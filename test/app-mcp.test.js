import assert from "node:assert/strict";
import test from "node:test";

import { createDoorDashApp } from "../src/app.js";
import { SecurityStore } from "../src/security-store.js";

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
  const { mcpHandler } = createDoorDashApp({
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
  assert.equal(safeNames.includes("doordash_list_payment_methods"), false);
  assert.equal(safeNames.includes("doordash_order_submit"), false);
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
  assert.equal(purchaseNames.includes("doordash_list_payment_methods"), true);
  assert.equal(purchaseNames.includes("doordash_order_submit"), true);
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

test("generic runner cannot bypass payment gating", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Purchase",
    allowPurchases: true
  });
  let cliCalls = 0;
  const { mcpHandler } = createDoorDashApp({
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
      name: "doordash_run",
      arguments: {
        args: ["payment-method", "list"]
      }
    }
  );
  assert.equal(response.body.result.isError, true);
  assert.match(
    response.body.result.structuredContent.error.message,
    /blocked in doordash_run/
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
  const { mcpHandler } = createDoorDashApp({
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
      name: "doordash_list_payment_methods",
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
  const { mcpHandler } = createDoorDashApp({
    securityStore: store,
    runCli: async () =>
      cliResult({
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
      })
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "doordash_search_restaurants",
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
  const { mcpHandler } = createDoorDashApp({
    securityStore: store,
    runCli: async () => cliResult({ success: true })
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "doordash_search_restaurants",
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
  const { mcpHandler } = createDoorDashApp({
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
      name: "doordash_order_submit",
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
      name: "doordash_order_submit",
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
