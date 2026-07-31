import assert from "node:assert/strict";
import test from "node:test";

import { createDoorDashApp } from "../src/app.js";
import { SecurityStore } from "../src/security-store.js";

function createTestApp(options) {
  return createDoorDashApp({
    adminAccessToken: "test-admin-secret",
    ...options
  });
}

function cliResult(structuredContent) {
  return {
    ok: true,
    exitCode: 0,
    signal: null,
    stderr: null,
    data: {
      content: [],
      structuredContent,
      isError: false
    }
  };
}

async function mcpRequest(handler, authInfo, method, params, id = 1) {
  const body = {
    jsonrpc: "2.0",
    id,
    method,
    params
  };
  const request = new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25"
    },
    body: JSON.stringify(body)
  });
  const response = await handler.fetch(request, {
    authInfo
  });
  const text = await response.text();
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "));
  return {
    status: response.status,
    body: dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(text)
  };
}

function authInfo(store, token) {
  const record = store.verifyToken(token);
  return {
    token,
    clientId: record.id,
    scopes: record.scopes,
    expiresAt: record.expiresAt
  };
}

test("purchase tools appear only for tokens with the checkbox enabled", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async () => {
      throw new Error("CLI should not run during tools/list.");
    }
  });

  const safeList = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/list",
    {}
  );
  const safeNames = safeList.body.result.tools.map((tool) => tool.name);
  assert.equal(safeNames.includes("list_payment_methods"), false);
  assert.equal(safeNames.includes("order_submit"), false);
  assert.equal(
    safeList.body.result.tools.every(
      (tool) =>
        tool.outputSchema?.type === "object" &&
        tool.outputSchema?.properties?.schema &&
        tool.outputSchema?.properties?.version
    ),
    true
  );

  store.setPurchaseAccess(token.id, true);
  const purchaseList = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/list",
    {},
    2
  );
  const purchaseNames = purchaseList.body.result.tools.map((tool) => tool.name);
  assert.equal(purchaseNames.includes("list_payment_methods"), true);
  assert.equal(purchaseNames.includes("order_submit"), true);
  assert.equal(
    purchaseNames.some((name) => name.startsWith("doordash_")),
    false
  );
  assert.equal(
    purchaseList.body.result.tools.every(
      (tool) =>
        tool.outputSchema?.type === "object" &&
        tool.outputSchema?.properties?.schema &&
        tool.outputSchema?.properties?.version
    ),
    true
  );

  await mcpHandler.close();
  store.close();
});

test("discovery exposes no location override and documents the default address", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async () => {
      throw new Error("CLI should not run during tools/list.");
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/list",
    {}
  );

  for (const name of ["search_restaurants", "find_nearby_stores"]) {
    const tool = response.body.result.tools.find((entry) => entry.name === name);
    assert.ok(tool);
    assert.equal("lat" in tool.inputSchema.properties, false);
    assert.equal("lng" in tool.inputSchema.properties, false);
    assert.match(tool.description, /list_addresses/);
    assert.match(tool.description, /does not accept a location override/);
  }

  await mcpHandler.close();
  store.close();
});

test("cart tools instruct callers to satisfy required options and return checkout", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async () => {
      throw new Error("CLI should not run during tools/list.");
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/list",
    {}
  );
  const addTool = response.body.result.tools.find(
    (tool) => tool.name === "add_cart_items"
  );
  const detailTool = response.body.result.tools.find(
    (tool) => tool.name === "get_restaurant_item_details"
  );

  assert.ok(addTool);
  assert.match(addTool.description, /every modifier group/);
  assert.match(addTool.description, /selected option_id/);
  assert.match(addTool.description, /"option_id":"o_\.\.\."/);
  assert.match(addTool.description, /never pass group_id or extra_id/);
  assert.match(addTool.description, /automatically return.*checkout_url/);
  assert.match(JSON.stringify(addTool.inputSchema), /"option_id"/);
  assert.ok(detailTool);
  assert.match(detailTool.description, /must not be sent as cart selections/);

  await mcpHandler.close();
  store.close();
});

test("add cart returns a checkout URL after adding fully selected items", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "cart" && args[1] === "list") {
        return cliResult({ carts: [] });
      }
      if (args[0] === "cart" && args[1] === "add-items") {
        return cliResult({
          success: true,
          cart_uuid: "cart-1",
          cart: {
            id: "cart-1",
            store_id: "store-1",
            store_name: "Mercado",
            items: [
              {
                id: "line-1",
                item_id: "10523709271",
                name: "Enchiladas Verdes",
                quantity: 2
              }
            ]
          }
        });
      }
      if (args[0] === "order" && args[1] === "checkout-url") {
        return cliResult({
          cart_uuid: "cart-1",
          checkout_url: "https://www.doordash.test/checkout/cart-1"
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "add_cart_items",
      arguments: {
        storeId: "store-1",
        menuId: "menu-1",
        items: [
          {
            itemId: "i_10523709271",
            itemName: "Enchiladas Verdes",
            quantity: 2,
            nestedOptions: [
              {
                option_id: "o_31172333376",
                name: "Oaxacan Refried Black"
              },
              {
                option_id: "o_42978512124"
              }
            ]
          }
        ]
      }
    }
  );

  assert.equal(response.body.result.isError, undefined);
  assert.equal(
    response.body.result.structuredContent.checkout_url,
    "https://www.doordash.test/checkout/cart-1"
  );
  assert.match(
    response.body.result.content[0].text,
    /Checkout: https:\/\/www\.doordash\.test\/checkout\/cart-1/
  );
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2)),
    [
      ["cart", "list"],
      ["cart", "add-items"],
      ["order", "checkout-url"]
    ]
  );
  const requestedItems = JSON.parse(
    calls[1][calls[1].indexOf("--items-json") + 1]
  );
  assert.deepEqual(
    requestedItems[0].nested_options.map((option) => option.id),
    ["o_31172333376", "o_42978512124"]
  );
  assert.equal(
    requestedItems[0].nested_options[1].name,
    "o_42978512124"
  );

  await mcpHandler.close();
  store.close();
});

test("add cart preserves successful items when checkout link creation fails", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      if (args[0] === "cart" && args[1] === "add-items") {
        return cliResult({
          success: true,
          cart_uuid: "cart-1",
          cart: {
            id: "cart-1",
            items: [
              {
                id: "line-1",
                item_id: "item-1",
                name: "Item",
                quantity: 1
              }
            ]
          }
        });
      }
      throw new Error("Checkout link unavailable.");
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "add_cart_items",
      arguments: {
        storeId: "store-1",
        menuId: "menu-1",
        cartUuid: "cart-1",
        items: [
          {
            itemId: "item-1",
            itemName: "Item"
          }
        ]
      }
    }
  );

  assert.equal(response.body.result.isError, undefined);
  assert.equal(response.body.result.structuredContent.items.length, 1);
  assert.equal(
    response.body.result.structuredContent.checkout_url,
    undefined
  );
  assert.match(
    response.body.result.structuredContent.warnings[0],
    /create_checkout_link/
  );

  await mcpHandler.close();
  store.close();
});

test("add cart refuses to duplicate an active same-store cart", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "cart" && args[1] === "list") {
        return cliResult({
          carts: [
            {
              cart_uuid: "cart-existing",
              store_id: "store-1",
              store_name: "Mercado",
              items: [
                {
                  id: "line-1",
                  item_id: "item-1",
                  name: "Enchiladas Verdes",
                  quantity: 2
                }
              ]
            }
          ]
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "add_cart_items",
      arguments: {
        storeId: "store-1",
        menuId: "menu-1",
        items: [
          {
            itemId: "item-1",
            itemName: "Enchiladas Verdes",
            quantity: 2
          }
        ]
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.equal(
    response.body.result.structuredContent.error.code,
    "ACTIVE_CART_EXISTS"
  );
  assert.equal(
    response.body.result.structuredContent.error.recovery_tool,
    "show_cart"
  );
  assert.match(
    response.body.result.structuredContent.error.message,
    /cart-existing/
  );
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2)),
    [["cart", "list"]]
  );

  await mcpHandler.close();
  store.close();
});

test("add cart rejects modifier-group IDs as selected options", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  let cliCalls = 0;
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async () => {
      cliCalls += 1;
      return cliResult({});
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "add_cart_items",
      arguments: {
        storeId: "store-1",
        menuId: "menu-1",
        items: [
          {
            itemId: "item-1",
            itemName: "Item",
            nestedOptions: [
              {
                option_id: "e_7116953698",
                name: "CHOICE of BEANS"
              }
            ]
          }
        ]
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.match(response.body.result.content[0].text, /modifier-group IDs/);
  assert.equal(cliCalls, 0);

  await mcpHandler.close();
  store.close();
});

test("discovery tools resolve omitted coordinates from the default address", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "address" && args[1] === "list") {
        return cliResult({
          addresses: [
            {
              id: "address-old",
              printable_address: "1 Old St",
              latitude: 37.7,
              longitude: -122.1,
              is_default: false
            },
            {
              id: "address-default",
              printable_address: "21 Bay Forest Dr",
              latitude: 37.831,
              longitude: -122.219,
              is_default: true
            }
          ]
        });
      }
      if (
        (args[0] === "search" && args[1] === "--query") ||
        args[0] === "find-nearby-stores"
      ) {
        return cliResult({ stores: [] });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });

  const restaurantResponse = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "search_restaurants",
      arguments: {
        query: "pizza",
        limit: 10
      }
    }
  );
  const storeResponse = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "find_nearby_stores",
      arguments: {
        vertical: "grocery",
        max: 25
      }
    },
    2
  );

  assert.equal(restaurantResponse.body.result.isError, undefined);
  assert.equal(storeResponse.body.result.isError, undefined);
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2)),
    [
      ["address", "list"],
      ["search", "--query"],
      ["address", "list"],
      ["find-nearby-stores", "--vertical"]
    ]
  );
  for (const args of [calls[1], calls[3]]) {
    assert.deepEqual(args.slice(args.indexOf("--lat"), args.indexOf("--lat") + 2), [
      "--lat",
      "37.831"
    ]);
    assert.deepEqual(args.slice(args.indexOf("--lng"), args.indexOf("--lng") + 2), [
      "--lng",
      "-122.219"
    ]);
  }

  await mcpHandler.close();
  store.close();
});

test("activity keeps default-address commands and CLI results completely raw", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const { mcpHandler, activityLog } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      if (args[0] === "address" && args[1] === "list") {
        return cliResult({
          addresses: [
            {
              id: "address-default",
              printable_address: "21 Bay Forest Dr",
              latitude: 37.831,
              longitude: -122.219,
              is_default: true,
              upstream_private: "keep this too"
            }
          ]
        });
      }
      return cliResult({
        stores: [],
        requested_latitude: 37.831,
        requested_longitude: -122.219,
        upstream_private: "do not redact or normalize me"
      });
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "search_restaurants",
      arguments: {
        query: "pizza"
      }
    }
  );

  assert.equal(response.body.result.isError, undefined);
  const [searchEntry, addressEntry] = activityLog.list(2);
  assert.equal(
    searchEntry.command[searchEntry.command.indexOf("--lat") + 1],
    "37.831"
  );
  assert.equal(
    searchEntry.command[searchEntry.command.indexOf("--lng") + 1],
    "-122.219"
  );
  assert.equal(
    searchEntry.result.upstream_private,
    "do not redact or normalize me"
  );
  assert.equal(searchEntry.result.requested_latitude, 37.831);
  assert.equal(
    addressEntry.result.addresses[0].printable_address,
    "21 Bay Forest Dr"
  );
  assert.equal(
    addressEntry.result.addresses[0].upstream_private,
    "keep this too"
  );

  await mcpHandler.close();
  store.close();
});

test("stale discovery coordinates cannot bypass default-address lookup", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "address" && args[1] === "list") {
        return cliResult({
          addresses: [
            {
              id: "address-default",
              printable_address: "21 Bay Forest Dr",
              latitude: 37.831,
              longitude: -122.219,
              is_default: true
            }
          ]
        });
      }
      return cliResult({ stores: [] });
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "search_restaurants",
      arguments: {
        query: "pizza",
        lat: 37.8,
        lng: -122.2,
        limit: 10
      }
    }
  );

  assert.equal(response.body.result.isError, undefined);
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2)),
    [
      ["address", "list"],
      ["search", "--query"]
    ]
  );
  assert.equal(calls[1][calls[1].indexOf("--lat") + 1], "37.831");
  assert.equal(calls[1][calls[1].indexOf("--lng") + 1], "-122.219");

  await mcpHandler.close();
  store.close();
});

test("discovery fails clearly without a usable default address", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      return cliResult({
        addresses: [
          {
            id: "address-1",
            printable_address: "1 Main St",
            latitude: 37.8,
            longitude: -122.2
          }
        ]
      });
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "search_restaurants",
      arguments: {
        query: "pizza"
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.match(
    response.body.result.structuredContent.error.message,
    /did not identify a default saved address/
  );
  assert.deepEqual(calls, [["address", "list"]]);

  await mcpHandler.close();
  store.close();
});

test("generic runner cannot bypass payment gating", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Purchase",
    allowPurchases: true
  });
  let cliCalls = 0;
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async () => {
      cliCalls += 1;
      return cliResult({});
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "run",
      arguments: {
        args: ["payment-method", "list"]
      }
    }
  );
  assert.equal(response.body.result.isError, true);
  assert.match(
    response.body.result.structuredContent.error.message,
    /blocked in run/
  );
  assert.equal(cliCalls, 0);

  await mcpHandler.close();
  store.close();
});

test("permission is rechecked immediately before a dangerous CLI call", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Purchase",
    allowPurchases: true
  });
  const staleAuth = authInfo(store, token.token);
  let cliCalls = 0;
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async () => {
      cliCalls += 1;
      return cliResult({});
    }
  });

  store.setPurchaseAccess(token.id, false);
  const response = await mcpRequest(
    mcpHandler,
    staleAuth,
    "tools/call",
    {
      name: "list_payment_methods",
      arguments: {}
    }
  );
  assert.equal(response.body.result.isError, true);
  assert.match(
    response.body.result.structuredContent.error.message,
    /does not allow checkout or card details/
  );
  assert.equal(cliCalls, 0);

  await mcpHandler.close();
  store.close();
});

test("typed tools return concise text and normalized structured content", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      if (args[0] === "address" && args[1] === "list") {
        return cliResult({
          addresses: [
            {
              id: "address-default",
              printable_address: "21 Bay Forest Dr",
              latitude: 37.831,
              longitude: -122.219,
              is_default: true
            }
          ]
        });
      }
      return cliResult({
        success: true,
        upstream_only: "discard me",
        stores: [
          {
            store_id: 928163,
            name: "Example Pizza",
            image_url: "https://images.example.test/store.jpg",
            delivery_time: "25-35 min"
          }
        ]
      });
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "search_restaurants",
      arguments: {
        query: "pizza",
        limit: 10
      }
    }
  );

  assert.equal(
    response.body.result.content[0].text,
    "Found 1 DoorDash store."
  );
  assert.equal(response.body.result.content.length, 2);
  assert.equal(response.body.result.structuredContent.kind, "store_search");
  assert.equal(
    response.body.result.structuredContent.stores[0].store_id,
    "928163"
  );
  assert.equal(
    response.body.result.structuredContent.stores[0].delivery_time,
    "25-35 min"
  );
  assert.deepEqual(
    JSON.parse(response.body.result.content[1].text),
    response.body.result.structuredContent
  );
  assert.equal(
    JSON.stringify(response.body.result.structuredContent).includes(
      "upstream_only"
    ),
    false
  );
  assert.equal(
    JSON.stringify(response.body.result.structuredContent).includes(
      "min_minutes"
    ),
    false
  );

  await mcpHandler.close();
  store.close();
});

test("malformed upstream data is a typed MCP error, not an empty result", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      if (args[0] === "address" && args[1] === "list") {
        return cliResult({
          addresses: [
            {
              id: "address-default",
              printable_address: "21 Bay Forest Dr",
              latitude: 37.831,
              longitude: -122.219,
              is_default: true
            }
          ]
        });
      }
      return cliResult({ success: true });
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "search_restaurants",
      arguments: {
        query: "pizza",
        limit: 10
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.equal(
    response.body.result.structuredContent.error.code,
    "UPSTREAM_SCHEMA_ERROR"
  );
  assert.equal(response.body.result.content.length, 1);
  assert.equal("data" in response.body.result.structuredContent, false);

  await mcpHandler.close();
  store.close();
});

test("submit revalidates quote and card, records the attempt, and polls status", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Purchase",
    allowPurchases: true
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    pollDelay: async () => {},
    runCli: async (args, options) => {
      calls.push({ args, options });
      if (args[0] === "order" && args[1] === "preview") {
        return cliResult({
          success: true,
          cart_uuid: "cart-1",
          quote: {
            total_before_tip: {
              unit_amount: 2500,
              display_string: "$25.00"
            },
            delivery_address: {
              printable_address: "21 Bay Forest Dr, Oakland, CA 94611, USA"
            },
            store_order_cart: {
              orders: [
                {
                  order_items: [
                    {
                      id: "line-1",
                      quantity: 1,
                      item: {
                        id: "item-1",
                        name: "Pizza"
                      },
                      unit_price_monetary_fields: {
                        unit_amount: 2500
                      }
                    }
                  ]
                }
              ]
            }
          }
        });
      }
      if (args[0] === "payment-method") {
        return cliResult({
          default_payment_method_id: "pm-1",
          cards: [
            {
              payment_method_id: "pm-1",
              provider_payment_method_id: "provider-secret",
              brand: "Visa",
              last4: "4242",
              exp_month: 12,
              exp_year: 2030
            }
          ]
        });
      }
      if (args[0] === "order" && args[1] === "submit") {
        return cliResult({
          success: true,
          order_uuid: "order-1"
        });
      }
      if (args[0] === "order" && args[1] === "status") {
        return cliResult({
          order: {
            status: "successful",
            order_uuid: "order-1"
          },
          tracking_url: "https://www.doordash.test/orders/order-1"
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "order_submit",
      arguments: {
        cartUuid: "cart-1",
        expectedTotalBeforeTipCents: 2500,
        expectedDeliveryAddress:
          "21 Bay Forest Dr, Oakland, CA 94611",
        tipCents: 500,
        tipConfirmed: true,
        paymentConfirmation: {
          type: "card",
          brand: "Visa",
          last4: "4242"
        },
        confirmation: "PLACE ORDER",
        priority: false,
        applyCredits: true
      }
    }
  );

  assert.equal(response.body.result.structuredContent.schema, "doordash-cli");
  assert.equal(response.body.result.structuredContent.version, 1);
  assert.equal(response.body.result.structuredContent.kind, "order_submit");
  assert.equal(
    response.body.result.structuredContent.order_uuid,
    "order-1"
  );
  assert.equal(
    response.body.result.structuredContent.items[0].item_id,
    "item-1"
  );
  assert.equal(
    response.body.result.structuredContent.pricing.total_before_tip,
    25
  );
  assert.equal(
    response.body.result.structuredContent.pricing.tip,
    5
  );
  assert.equal(
    response.body.result.structuredContent.pricing.total,
    30
  );
  assert.equal(
    response.body.result.structuredContent.tracking_url,
    "https://www.doordash.test/orders/order-1"
  );
  assert.equal(
    response.body.result.structuredContent.warnings,
    undefined
  );
  assert.deepEqual(
    JSON.parse(response.body.result.content[1].text),
    response.body.result.structuredContent
  );
  assert.deepEqual(
    calls.map((call) => call.args.slice(0, 2).join(" ")),
    ["order preview", "payment-method list", "order submit", "order status"]
  );
  assert.equal(
    calls.find(
      (call) => call.args[0] === "order" && call.args[1] === "submit"
    ).options.allowPurchases,
    true
  );

  const duplicate = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "order_submit",
      arguments: {
        cartUuid: "cart-1",
        expectedTotalBeforeTipCents: 2500,
        expectedDeliveryAddress:
          "21 Bay Forest Dr, Oakland, CA 94611",
        tipCents: 500,
        tipConfirmed: true,
        paymentConfirmation: {
          type: "card",
          brand: "Visa",
          last4: "4242"
        },
        confirmation: "PLACE ORDER",
        priority: false,
        applyCredits: true
      }
    },
    2
  );
  assert.equal(duplicate.body.result.isError, true);
  assert.match(
    duplicate.body.result.structuredContent.error.message,
    /already has a recorded submission attempt/
  );
  assert.equal(
    calls.filter(
      (call) => call.args[0] === "order" && call.args[1] === "submit"
    ).length,
    1
  );

  await mcpHandler.close();
  store.close();
});
