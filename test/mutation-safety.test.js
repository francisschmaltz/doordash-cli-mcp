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

function bearer(store) {
  const created = store.createToken({
    name: "Mutation safety",
    allowPurchases: false
  });
  const record = store.verifyToken(created.token);
  return {
    token: created.token,
    clientId: record.id,
    scopes: record.scopes,
    expiresAt: record.expiresAt
  };
}

async function callTool(handler, authInfo, name, args, id) {
  const request = new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name,
        arguments: args
      }
    })
  });
  const response = await handler.fetch(request, { authInfo });
  const text = await response.text();
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "));
  return dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(text);
}

test("unknown mutation outcomes return one concrete inspection action", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = bearer(store);
  const calls = [];
  const { mcpHandler } = createDoorDashApp({
    adminAccessToken: "test-admin-secret",
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "order" && args[1] === "receipt") {
        return cliResult({
          order_uuid: "order-1",
          store: { store_id: "store-1", name: "Example Store" },
          items: [{ item_id: "item-1", name: "Meal", quantity: 1 }],
          total: { unit_amount: 1000 }
        });
      }
      if (args[0] === "cart" && args[1] === "list") {
        return cliResult({ carts: [] });
      }
      if (args[0] === "order" && args[1] === "reorder") {
        return cliResult({
          success: true,
          items: []
        });
      }
      throw new Error("Connection closed before confirmation.");
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const cases = [
    {
      name: "reorder",
      args: { order_uuid: "order-1" },
      code: "REORDER_OUTCOME_UNKNOWN",
      recovery_tool: "list_carts",
      recovery_arguments: {}
    },
    {
      name: "remove_cart_item",
      args: {
        cart_uuid: "cart-1",
        cart_item_id: "line-1"
      },
      code: "CART_MUTATION_OUTCOME_UNKNOWN",
      recovery_tool: "show_cart",
      recovery_arguments: { cart_uuid: "cart-1" }
    },
    {
      name: "apply_promo",
      args: {
        cart_uuid: "cart-1",
        promo_code: "DINNER"
      },
      code: "PROMO_MUTATION_OUTCOME_UNKNOWN",
      recovery_tool: "create_checkout_link",
      recovery_arguments: { cart_uuid: "cart-1" }
    },
    {
      name: "set_default_address",
      args: {
        address_id: "address-1",
        confirmation: "SET DEFAULT ADDRESS"
      },
      code: "ADDRESS_MUTATION_OUTCOME_UNKNOWN",
      recovery_tool: "list_addresses",
      recovery_arguments: {}
    },
    {
      name: "preview_order",
      args: {
        cart_uuid: "cart-1",
        fulfillment: "pickup"
      },
      code: "PREVIEW_OUTCOME_UNKNOWN",
      recovery_tool: "show_cart",
      recovery_arguments: { cart_uuid: "cart-1" }
    }
  ];

  for (const [index, expected] of cases.entries()) {
    const response = await callTool(
      mcpHandler,
      auth,
      expected.name,
      expected.args,
      index + 1
    );
    const error = response.result.structuredContent.error;
    assert.equal(response.result.isError, true);
    assert.equal(error.code, expected.code);
    assert.equal(error.retryable, false);
    assert.equal(error.recovery_tool, expected.recovery_tool);
    assert.deepEqual(
      error.recovery_arguments,
      expected.recovery_arguments
    );
    assert.match(response.result.content[0].text, /Do not retry/);
  }

  assert.equal(
    calls.filter(
      (args) => args[0] === "order" && args[1] === "reorder"
    ).length,
    1
  );
});
