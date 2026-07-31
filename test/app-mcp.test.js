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
  const genericDetailTool = response.body.result.tools.find(
    (tool) => tool.name === "get_item_details"
  );

  assert.ok(addTool);
  assert.match(addTool.description, /never add one item at a time/);
  assert.match(addTool.description, /before making one DoorDash cart write/);
  assert.match(addTool.description, /every modifier group/);
  assert.match(addTool.description, /selected option_id/);
  assert.match(addTool.description, /"option_id":"o_\.\.\."/);
  assert.match(addTool.description, /never pass group_id or extra_id/);
  assert.match(addTool.description, /automatically return.*checkout_url/);
  assert.match(JSON.stringify(addTool.inputSchema), /"option_id"/);
  assert.match(JSON.stringify(addTool.inputSchema), /"requestedOptions"/);
  assert.ok(detailTool);
  assert.match(detailTool.description, /must not be sent as cart selections/);
  assert.ok(genericDetailTool);
  assert.match(genericDetailTool.description, /prefixed i_/);
  assert.ok(genericDetailTool.inputSchema.properties.menuId);

  await mcpHandler.close();
  store.close();
});

test("generic item details auto-routes restaurant IDs and resolves the menu", async () => {
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
      if (args[0] === "menu") {
        return cliResult({
          menu_id: "menu-1",
          items: []
        });
      }
      if (args[0] === "restaurant-item-details") {
        return cliResult({
          item: {
            item_id: "i_12901175286",
            name: "Spicy TanTan",
            has_modifiers: true,
            extras: [
              {
                extra_id: "e_utensils",
                title: "Utensils",
                min_num_options: 1,
                max_num_options: 1,
                options: [
                  {
                    option_id: "o_yes",
                    name: "Utensils : Yes"
                  },
                  {
                    option_id: "o_no",
                    name: "Utensils : No"
                  }
                ]
              }
            ]
          }
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
      name: "get_item_details",
      arguments: {
        storeId: "store-1",
        itemId: "i_12901175286"
      }
    }
  );

  assert.equal(response.body.result.isError, undefined);
  assert.equal(
    response.body.result.structuredContent.item.name,
    "Spicy TanTan"
  );
  assert.equal(
    response.body.result.structuredContent.item.has_required_modifiers,
    true
  );
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["menu", "restaurant-item-details"]
  );
  assert.equal(
    calls[1][calls[1].indexOf("--item-id") + 1],
    "12901175286"
  );

  await mcpHandler.close();
  store.close();
});

test("order status accepts order_uuid copied from list_orders", async () => {
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
        order_uuid: "order-1",
        status: "successful"
      });
    }
  });

  const list = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/list",
    {}
  );
  const statusTool = list.body.result.tools.find(
    (tool) => tool.name === "order_status"
  );
  assert.ok(statusTool.inputSchema.properties.order_uuid);
  assert.ok(statusTool.inputSchema.properties.orderUuid);
  assert.match(statusTool.description, /Copy order_uuid exactly/);

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "order_status",
      arguments: {
        order_uuid: "order-1"
      }
    }
  );

  assert.equal(response.body.result.isError, undefined);
  assert.equal(
    response.body.result.structuredContent.order_uuid,
    "order-1"
  );
  assert.deepEqual(calls[0], [
    "order",
    "status",
    "--order-uuid",
    "order-1"
  ]);

  await mcpHandler.close();
  store.close();
});

test("every emitted identifier is accepted by its consuming tool", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Purchase",
    allowPurchases: true
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
  const tools = new Map(
    response.body.result.tools.map((tool) => [tool.name, tool])
  );
  const expectedFields = {
    set_default_address: ["address_id"],
    build_grocery_list: ["store_id"],
    find_items: ["store_id"],
    get_item_details: ["store_id", "item_id", "menu_id"],
    get_menu: ["store_id"],
    get_restaurant_item_details: ["store_id", "menu_id", "item_id"],
    get_store_details: ["store_id"],
    add_cart_items: ["store_id", "menu_id", "cart_uuid"],
    delete_cart: ["cart_uuid"],
    list_carts: ["store_id"],
    remove_cart_item: ["cart_uuid", "cart_item_id"],
    show_cart: ["cart_uuid"],
    create_checkout_link: ["cart_uuid"],
    preview_order: [
      "cart_uuid",
      "scheduled_time",
      "selected_budget_id",
      "budget_id"
    ],
    get_receipt: ["order_uuid"],
    reorder: ["order_uuid"],
    order_status: ["order_uuid"],
    list_promos: ["store_id"],
    apply_promo: [
      "cart_uuid",
      "promo_code",
      "campaign_id",
      "ad_group_id",
      "ad_id"
    ],
    remove_promo: [
      "cart_uuid",
      "promo_code",
      "campaign_id",
      "ad_group_id",
      "ad_id"
    ],
    order_submit: [
      "cart_uuid",
      "scheduled_time",
      "team_id",
      "budget_id",
      "team_account_id",
      "expense_code",
      "expense_notes"
    ]
  };

  for (const [toolName, fields] of Object.entries(expectedFields)) {
    const tool = tools.get(toolName);
    assert.ok(tool, `${toolName} should be registered`);
    for (const field of fields) {
      assert.ok(
        tool.inputSchema.properties[field],
        `${toolName} should accept ${field}`
      );
    }
  }

  const addSchema = JSON.stringify(tools.get("add_cart_items").inputSchema);
  for (const field of [
    "item_id",
    "name",
    "requested_options",
    "nested_options",
    "option_id"
  ]) {
    assert.match(addSchema, new RegExp(`"${field}"`));
  }
  assert.match(
    JSON.stringify(tools.get("order_submit").inputSchema),
    /"budget_name"/
  );
  assert.match(
    JSON.stringify(tools.get("order_submit").inputSchema),
    /"name"/
  );

  await mcpHandler.close();
  store.close();
});

test("snake-case IDs route through address, item, cart, and promo tools", async () => {
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
      if (args[0] === "address") {
        return cliResult({
          success: true,
          address_id: "address-1"
        });
      }
      if (args[0] === "restaurant-item-details") {
        return cliResult({
          item: {
            item_id: "i_item-1",
            name: "Item"
          }
        });
      }
      if (args[0] === "order" && args[1] === "preview") {
        return cliResult({
          success: true,
          cart_uuid: "cart-1",
          quote: {
            store_order_cart: {
              orders: []
            }
          }
        });
      }
      return cliResult({
        success: true,
        message: "Updated."
      });
    }
  });
  const auth = authInfo(store, token.token);

  const requests = [
    {
      name: "set_default_address",
      arguments: {
        address_id: "address-1",
        confirmation: "SET DEFAULT ADDRESS"
      }
    },
    {
      name: "get_restaurant_item_details",
      arguments: {
        store_id: "store-1",
        menu_id: "menu-1",
        item_id: "i_item-1"
      }
    },
    {
      name: "remove_cart_item",
      arguments: {
        cart_uuid: "cart-1",
        cart_item_id: "line-1"
      }
    },
    {
      name: "apply_promo",
      arguments: {
        cart_uuid: "cart-1",
        promo_code: "SAVE",
        campaign_id: "campaign-1",
        ad_group_id: "group-1",
        ad_id: "ad-1"
      }
    },
    {
      name: "preview_order",
      arguments: {
        cart_uuid: "cart-1",
        budget_id: "budget-1"
      }
    }
  ];

  for (const [index, request] of requests.entries()) {
    const response = await mcpRequest(
      mcpHandler,
      auth,
      "tools/call",
      request,
      index + 1
    );
    assert.equal(
      response.body.result.isError,
      undefined,
      response.body.result.content[0].text
    );
  }

  assert.deepEqual(calls, [
    ["address", "set", "--address-id", "address-1", "--yes"],
    [
      "restaurant-item-details",
      "--store-id",
      "store-1",
      "--menu-id",
      "menu-1",
      "--item-id",
      "item-1"
    ],
    [
      "cart",
      "remove-item",
      "--cart-uuid",
      "cart-1",
      "--cart-item-id",
      "line-1"
    ],
    [
      "promo",
      "apply",
      "--cart-uuid",
      "cart-1",
      "--promo-code",
      "SAVE",
      "--campaign-id",
      "campaign-1",
      "--ad-group-id",
      "group-1",
      "--ad-id",
      "ad-1"
    ],
    [
      "order",
      "preview",
      "--cart-uuid",
      "cart-1",
      "--selected-budget-id",
      "budget-1"
    ]
  ]);

  await mcpHandler.close();
  store.close();
});

test("conflicting snake-case and camel-case IDs fail before the CLI", async () => {
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
      name: "show_cart",
      arguments: {
        cart_uuid: "cart-1",
        cartUuid: "cart-2"
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.match(
    response.body.result.content[0].text,
    /cart_uuid and cartUuid must match/
  );
  assert.equal(cliCalls, 0);

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
      if (args[0] === "restaurant-item-details") {
        return cliResult({
          item: {
            item_id: "i_10523709271",
            name: "Enchiladas Verdes",
            extras: [
              {
                extra_id: "e_beans",
                title: "Choice of Beans",
                min_num_options: 1,
                max_num_options: 1,
                options: [
                  {
                    option_id: "o_31172333376",
                    name: "Oaxacan Refried Black"
                  }
                ]
              },
              {
                extra_id: "e_protein",
                title: "Choice of Protein",
                min_num_options: 1,
                max_num_options: 1,
                options: [
                  {
                    option_id: "o_42978512124",
                    name: "Rotisserie Chicken"
                  }
                ]
              }
            ]
          }
        });
      }
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
      ["restaurant-item-details", "--store-id"],
      ["cart", "list"],
      ["cart", "add-items"],
      ["order", "checkout-url"]
    ]
  );
  const addCall = calls.find(
    (args) => args[0] === "cart" && args[1] === "add-items"
  );
  const requestedItems = JSON.parse(
    addCall[addCall.indexOf("--items-json") + 1]
  );
  assert.deepEqual(
    requestedItems[0].nested_options.map((option) => option.id),
    ["o_31172333376", "o_42978512124"]
  );
  assert.equal(
    requestedItems[0].nested_options[1].name,
    "Rotisserie Chicken"
  );

  await mcpHandler.close();
  store.close();
});

test("add cart preflights variants and sends one complete DoorDash batch", async () => {
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
      if (args[0] === "restaurant-item-details") {
        return cliResult({
          item: {
            item_id: "i_12901175286",
            name: "Spicy TanTan",
            extras: [
              {
                extra_id: "e_utensils",
                title: "Utensils",
                min_num_options: 1,
                max_num_options: 1,
                options: [
                  {
                    option_id: "o_utensils_yes",
                    name: "Utensils : Yes"
                  },
                  {
                    option_id: "o_utensils_no",
                    name: "Utensils : No"
                  }
                ]
              },
              {
                extra_id: "e_toppings",
                title: "Topping",
                min_num_options: 0,
                max_num_options: 0,
                options: [
                  {
                    option_id: "o_sweet_corn",
                    name: "Sweet Corn"
                  }
                ]
              }
            ]
          }
        });
      }
      if (args[0] === "cart" && args[1] === "list") {
        return cliResult({ carts: [] });
      }
      if (args[0] === "cart" && args[1] === "add-items") {
        return cliResult({
          cart_uuid: "cart-ramen",
          cart: {
            id: "cart-ramen",
            items: [
              {
                id: "line-1",
                item_id: "12901175286",
                name: "Spicy TanTan",
                quantity: 1
              },
              {
                id: "line-2",
                item_id: "12901175286",
                name: "Spicy TanTan",
                quantity: 1
              }
            ]
          }
        });
      }
      if (args[0] === "order" && args[1] === "checkout-url") {
        return cliResult({
          cart_uuid: "cart-ramen",
          checkout_url: "https://www.doordash.test/checkout/cart-ramen"
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
        store_id: "707534",
        menu_id: "34596353",
        items: [
          {
            item_id: "i_12901175286",
            name: "Spicy TanTan",
            requested_options: ["Utensils"]
          },
          {
            item_id: "i_12901175286",
            name: "Spicy TanTan with Sweet Corn",
            requested_options: ["Utensils"]
          }
        ]
      }
    }
  );

  assert.equal(
    response.body.result.isError,
    undefined,
    JSON.stringify(response.body.result)
  );
  assert.equal(
    calls.filter(
      (args) => args[0] === "restaurant-item-details"
    ).length,
    1
  );
  assert.equal(
    calls.filter(
      (args) => args[0] === "cart" && args[1] === "add-items"
    ).length,
    1
  );
  const addCall = calls.find(
    (args) => args[0] === "cart" && args[1] === "add-items"
  );
  const items = JSON.parse(
    addCall[addCall.indexOf("--items-json") + 1]
  );
  assert.deepEqual(
    items.map((item) => item.item_name),
    ["Spicy TanTan", "Spicy TanTan"]
  );
  assert.deepEqual(
    items.map((item) =>
      item.nested_options.map((option) => option.id)
    ),
    [
      ["o_utensils_yes"],
      ["o_utensils_yes", "o_sweet_corn"]
    ]
  );
  assert.equal(
    response.body.result.structuredContent.checkout_url,
    "https://www.doordash.test/checkout/cart-ramen"
  );

  await mcpHandler.close();
  store.close();
});

test("add cart reports every modifier before writing when a choice is missing", async () => {
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
      if (args[0] === "restaurant-item-details") {
        return cliResult({
          item: {
            item_id: "i_12901175286",
            name: "Spicy TanTan",
            extras: [
              {
                extra_id: "e_utensils",
                title: "Utensils",
                min_num_options: 1,
                max_num_options: 1,
                options: [
                  {
                    option_id: "o_yes",
                    name: "Utensils : Yes"
                  },
                  {
                    option_id: "o_no",
                    name: "Utensils : No"
                  }
                ]
              },
              {
                extra_id: "e_toppings",
                title: "Topping",
                min_num_options: 0,
                max_num_options: 0,
                options: [
                  {
                    option_id: "o_corn",
                    name: "Sweet Corn"
                  }
                ]
              }
            ]
          }
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
        storeId: "707534",
        menuId: "34596353",
        items: [
          {
            itemId: "i_12901175286",
            itemName: "Spicy TanTan",
            requestedOptions: ["Imaginary Sauce"]
          }
        ]
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["restaurant-item-details"]
  );
  assert.equal(
    response.body.result.structuredContent.item_errors[0]
      .modifier_groups.length,
    2
  );
  assert.match(
    response.body.result.structuredContent.item_errors[0].message,
    /No cart changes were made/
  );
  assert.match(
    response.body.result.structuredContent.item_errors[0].message,
    /Imaginary Sauce.*does not match/
  );
  assert.match(
    response.body.result.content[0].text,
    /No cart changes were made/
  );
  assert.match(
    response.body.result.content[0].text,
    /retrying add_cart_items once; never repeat the unchanged input/
  );
  assert.match(
    response.body.result.content[0].text,
    /Utensils: Utensils : Yes \[o_yes\], Utensils : No \[o_no\]/
  );
  assert.match(
    response.body.result.content[0].text,
    /Topping: Sweet Corn \[o_corn\]/
  );
  assert.deepEqual(
    JSON.parse(response.body.result.content[1].text),
    response.body.result.structuredContent
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

test("add cart safely reuses an empty active same-store cart", async () => {
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
              cart_uuid: "cart-empty",
              store_id: "store-1",
              items: []
            }
          ]
        });
      }
      if (args[0] === "cart" && args[1] === "add-items") {
        return cliResult({
          cart_uuid: "cart-empty",
          cart: {
            id: "cart-empty",
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
      if (args[0] === "order" && args[1] === "checkout-url") {
        return cliResult({
          cart_uuid: "cart-empty",
          checkout_url: "https://www.doordash.test/checkout/cart-empty"
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
            itemName: "Item"
          }
        ]
      }
    }
  );

  assert.equal(response.body.result.isError, undefined);
  const addCall = calls.find(
    (args) => args[0] === "cart" && args[1] === "add-items"
  );
  assert.equal(
    addCall[addCall.indexOf("--cart-uuid") + 1],
    "cart-empty"
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
  assert.equal(response.body.result.content.length, 2);
  assert.deepEqual(
    JSON.parse(response.body.result.content[1].text),
    response.body.result.structuredContent
  );
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
        cart_uuid: "cart-1",
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
