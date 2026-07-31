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

async function mcpRequest(handler, authInfo, params, id = 1) {
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
      params
    })
  });
  const response = await handler.fetch(request, { authInfo });
  const text = await response.text();
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "));
  return dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(text);
}

function authInfo(store) {
  const token = store.createToken({
    name: "Reorder regression",
    allowPurchases: false
  });
  const record = store.verifyToken(token.token);
  return {
    token: token.token,
    clientId: record.id,
    scopes: record.scopes,
    expiresAt: record.expiresAt
  };
}

function sourceOrder() {
  return {
    order_uuid: "order-source",
    order_target: "RESTAURANT",
    menu_id: "menu-chicken",
    store: {
      store_id: "store-chicken",
      menu_id: "menu-chicken",
      name: "Example Chicken"
    },
    items: [
      {
        item_id: 9459662774,
        menu_id: "menu-chicken",
        name: "Deluxe Chicken Meal",
        quantity: 1
      }
    ],
    total: { unit_amount: 1299 }
  };
}

function liveReceiptShape() {
  return {
    success: true,
    store_id: "store-chicken",
    store_name: "Example Chicken",
    line_items: [
      {
        charge_id: "SUBTOTAL",
        label: "Subtotal",
        final_money: { unit_amount: 1299 }
      },
      {
        charge_id: "TOTAL",
        label: "Total",
        final_money: { unit_amount: 1299 }
      }
    ],
    orders: [
      {
        id: "internal-order-line-group",
        order_items: [
          {
            id: "internal-order-line",
            quantity: 1,
            item: {
              id: "9459662774",
              name: "Deluxe Chicken Meal",
              price_monetary_fields: { unit_amount: 1299 }
            },
            options: [
              {
                id: "31718037616",
                quantity: 1,
                item_extra_option: {
                  id: "31718037616",
                  name: "Pepper Jack Meal"
                }
              }
            ]
          }
        ]
      }
    ]
  };
}

function ranchItemDetails() {
  return {
    item: {
      item_id: "9459662774",
      name: "Deluxe Chicken Meal",
      extras: [
        {
          extra_id: "e_sauce",
          title: "Sauce",
          min_num_options: 0,
          max_num_options: 2,
          options: [
            { option_id: "o_ranch_sauce", name: "Ranch" }
          ]
        },
        {
          extra_id: "e_dressing",
          title: "Dressing",
          min_num_options: 0,
          max_num_options: 2,
          options: [
            { option_id: "o_ranch_dressing", name: "Ranch" }
          ]
        }
      ]
    }
  };
}

function modifierOptionIds(groups = []) {
  return groups.flatMap((group) =>
    (group.options || []).flatMap((option) => [
      option.option_id,
      ...modifierOptionIds(option.modifier_groups)
    ])
  );
}

async function reorderWarnings(t, { cartUuid, sourceItems, cartItems }) {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const receipt = sourceOrder();
  receipt.items = sourceItems;
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      if (args[0] === "order" && args[1] === "receipt") {
        return cliResult(receipt);
      }
      if (args[0] === "cart" && args[1] === "list") {
        return cliResult({ carts: [] });
      }
      if (args[0] === "order" && args[1] === "reorder") {
        return cliResult({ cart_uuid: cartUuid, items: [] });
      }
      if (args[0] === "cart" && args[1] === "show") {
        return cliResult({
          cart_uuid: cartUuid,
          store_id: "store-chicken",
          menu_id: "menu-chicken",
          items: cartItems
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "reorder",
    arguments: { order_uuid: "order-source" }
  });
  assert.equal(response.result.isError, undefined);
  return response.result.structuredContent.warnings || [];
}

test("reorder rejects a receipt for a different order before mutation", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "order" && args[1] === "receipt") {
        const receipt = sourceOrder();
        receipt.order_uuid = "order-stale";
        return cliResult(receipt);
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "reorder",
    arguments: { order_uuid: "order-source" }
  });

  assert.equal(response.result.isError, true);
  assert.equal(
    response.result.structuredContent.error.code,
    "UPSTREAM_SCHEMA_ERROR"
  );
  assert.match(response.result.content[0].text, /No reorder was attempted/);
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
    ["order", "receipt"]
  ]);
});

test("reorder hydrates incomplete cart-list entries before mutation", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "order" && args[1] === "receipt") {
        return cliResult(liveReceiptShape());
      }
      if (args[0] === "cart" && args[1] === "list") {
        return cliResult({
          carts: [
            {
              cart_uuid: "cart-existing",
              store_id: "store-chicken",
              menu_id: "menu-chicken"
            }
          ]
        });
      }
      if (args[0] === "cart" && args[1] === "show") {
        return cliResult({
          cart_uuid: "cart-existing",
          store_id: "store-chicken",
          menu_id: "menu-chicken",
          items: [
            {
              id: "line-existing",
              item_id: "i_9459662774",
              menu_id: "menu-chicken",
              name: "Deluxe Chicken Meal",
              quantity: 2
            }
          ]
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "reorder",
    arguments: { order_uuid: "order-source" }
  });

  assert.equal(response.result.isError, true);
  assert.equal(
    response.result.structuredContent.error.code,
    "ACTIVE_CART_EXISTS"
  );
  assert.match(response.result.content[0].text, /No reorder was attempted/);
  assert.equal(
    calls.filter(
      (args) => args[0] === "order" && args[1] === "reorder"
    ).length,
    0
  );
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2)),
    [
      ["order", "receipt"],
      ["cart", "list"],
      ["cart", "show"]
    ]
  );
});

test("reorder refuses a truncated active-cart list", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "order" && args[1] === "receipt") {
        return cliResult(liveReceiptShape());
      }
      if (args[0] === "cart" && args[1] === "list") {
        return cliResult({ carts: [], truncated: " TRUE " });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "reorder",
    arguments: { order_uuid: "order-source" }
  });
  const error = response.result.structuredContent.error;

  assert.equal(response.result.isError, true);
  assert.equal(error.code, "ACTIVE_CART_STATE_UNKNOWN");
  assert.equal(error.recovery_tool, "list_carts");
  assert.equal(
    calls.some(
      (args) => args[0] === "order" && args[1] === "reorder"
    ),
    false
  );
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2)),
    [
      ["order", "receipt"],
      ["cart", "list"]
    ]
  );
});

test("cart add refuses a truncated active-cart list", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "cart" && args[1] === "list") {
        return cliResult({ carts: [], truncated: true });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "add_cart_items",
    arguments: {
      store_id: "store-chicken",
      menu_id: "menu-chicken",
      items: [
        {
          item_id: "9459662774",
          name: "Deluxe Chicken Meal"
        }
      ]
    }
  });

  assert.equal(response.result.isError, true);
  assert.equal(
    response.result.structuredContent.error.code,
    "ACTIVE_CART_STATE_UNKNOWN"
  );
  assert.equal(
    calls.some(
      (args) => args[0] === "cart" && args[1] === "add-items"
    ),
    false
  );
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
    ["cart", "list"]
  ]);
});

test("cart add fails before mutation when cart and line menu IDs conflict", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "cart" && args[1] === "show") {
        return cliResult({
          cart_uuid: "cart-conflict",
          menu_id: "menu-cart",
          store: { store_id: "store-chicken" },
          items: [
            {
              id: "line-existing",
              item_id: "existing-item",
              menu_id: "menu-line",
              name: "Existing Item",
              quantity: 1
            }
          ]
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "add_cart_items",
    arguments: {
      store_id: "store-chicken",
      menu_id: "menu-cart",
      cart_uuid: "cart-conflict",
      items: [{ item_id: "new-item", name: "New Item" }]
    }
  });

  assert.equal(response.result.isError, true);
  assert.equal(
    response.result.structuredContent.error.code,
    "UPSTREAM_SCHEMA_ERROR"
  );
  assert.match(
    response.result.structuredContent.error.message,
    /line menu_id values that conflict with the cart menu_id/i
  );
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
    ["cart", "show"]
  ]);
});

test("reorder mutates once, hydrates the cart, and reports quantity drift", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "order" && args[1] === "receipt") {
        return cliResult(liveReceiptShape());
      }
      if (args[0] === "cart" && args[1] === "list") {
        return cliResult({ carts: [] });
      }
      if (args[0] === "order" && args[1] === "reorder") {
        return cliResult({
          success: true,
          cart_uuid: "cart-new",
          cart: { id: "cart-new", items: [] }
        });
      }
      if (args[0] === "cart" && args[1] === "show") {
        return cliResult({
          success: true,
          cart_uuid: "cart-new",
          cart: {
            id: "cart-new",
            store_id: "store-chicken",
            store_name: "Example Chicken",
            menu_id: "menu-chicken",
            items: [
              {
                id: "line-new",
                item_id: "i_9459662774",
                menu_id: "menu-chicken",
                name: "Deluxe Chicken Meal",
                quantity: 2,
                selected_options: [
                  {
                    option_id: "31718037616",
                    option_name: "Pepper Jack Meal",
                    quantity: 1
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
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "reorder",
    arguments: { order_uuid: "order-source" }
  });
  const result = response.result.structuredContent;

  assert.equal(response.result.isError, undefined);
  assert.equal(result.kind, "reorder");
  assert.equal(result.cart_uuid, "cart-new");
  assert.equal(result.menu_id, "menu-chicken");
  assert.equal(result.items[0].menu_id, "menu-chicken");
  assert.equal(result.items[0].quantity, 2);
  assert.match(
    result.warnings.join(" "),
    /changed from quantity 1 in history to 2/
  );
  assert.doesNotMatch(
    result.warnings.join(" "),
    /different modifier selections/
  );
  assert.equal(
    calls.filter(
      (args) => args[0] === "order" && args[1] === "reorder"
    ).length,
    1
  );
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2)),
    [
      ["order", "receipt"],
      ["cart", "list"],
      ["order", "reorder"],
      ["cart", "show"]
    ]
  );
});

test("reorder treats receipt modifier selections as partial", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const receipt = liveReceiptShape();
  receipt.orders[0].order_items[0].id = "meal-source-1";
  receipt.orders[0].order_items.push(
    {
      ...structuredClone(receipt.orders[0].order_items[0]),
      id: "meal-source-2"
    },
    {
      id: "sandwich-source",
      quantity: 1,
      item: {
        id: "9459675362",
        name: "Grilled Chicken Sandwich",
        price_monetary_fields: { unit_amount: 935 }
      },
      options: [
        {
          id: "31718049067",
          quantity: 1,
          item_extra_option: {
            id: "31718049067",
            name: "Buttery White Bun"
          }
        },
        {
          id: "31718049079",
          quantity: 1,
          item_extra_option: {
            id: "31718049079",
            name: "Remove Tomato"
          }
        }
      ]
    }
  );
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      if (args[0] === "order" && args[1] === "receipt") {
        return cliResult(receipt);
      }
      if (args[0] === "cart" && args[1] === "list") {
        return cliResult({ carts: [] });
      }
      if (args[0] === "order" && args[1] === "reorder") {
        return cliResult({ cart_uuid: "cart-partial-receipt", items: [] });
      }
      if (args[0] === "cart" && args[1] === "show") {
        return cliResult({
          cart_uuid: "cart-partial-receipt",
          store_id: "store-chicken",
          items: [
            {
              id: "meal-cart-1",
              item_id: "i_9459662774",
              name: "Deluxe Chicken Meal",
              quantity: 1,
              selected_options: [
                {
                  option_id: "31718037616",
                  option_name: "Pepper Jack Meal",
                  quantity: 1,
                  options: [
                    {
                      option_id: "beverage",
                      option_name: "Meal Beverages",
                      quantity: 1,
                      options: [
                        {
                          option_id: "diet-cola",
                          option_name: "Diet Cola",
                          quantity: 1
                        }
                      ]
                    },
                    {
                      option_id: "side",
                      option_name: "Meal Sides",
                      quantity: 1
                    }
                  ]
                }
              ]
            },
            {
              id: "meal-cart-2",
              item_id: "i_9459662774",
              name: "Deluxe Chicken Meal",
              quantity: 1,
              selected_options: [
                {
                  option_id: "31718037616",
                  option_name: "Pepper Jack Meal",
                  quantity: 1,
                  options: [
                    {
                      option_id: "beverage",
                      option_name: "Meal Beverages",
                      quantity: 1,
                      options: [
                        {
                          option_id: "milkshake",
                          option_name: "Cookies and Cream Milkshake",
                          quantity: 1
                        }
                      ]
                    },
                    {
                      option_id: "side",
                      option_name: "Meal Sides",
                      quantity: 1
                    }
                  ]
                }
              ]
            },
            {
              id: "sandwich-cart",
              item_id: "i_9459675362",
              name: "Grilled Chicken Sandwich",
              quantity: 1,
              selected_options: [
                {
                  option_id: "31718049067",
                  option_name: "Buttery White Bun",
                  quantity: 1
                },
                {
                  option_id: "31718049079",
                  option_name: "Remove Tomato",
                  quantity: 1
                },
                {
                  option_id: "31718049080",
                  option_name: "Remove Lettuce",
                  quantity: 1
                }
              ]
            }
          ]
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "reorder",
    arguments: { order_uuid: "order-source" }
  });

  assert.equal(response.result.isError, undefined);
  assert.doesNotMatch(
    (response.result.structuredContent.warnings || []).join(" "),
    /different modifier selections/
  );
});

test("reorder consumes nested choices and respects reused option IDs across groups", async (t) => {
  const item = (selectedOptions) => ({
    item_id: "9459662774",
    name: "Deluxe Chicken Meal",
    quantity: 1,
    selected_options: [
      {
        option_id: "meal",
        group_name: "Entree",
        option_name: "Meal",
        quantity: 1,
        options: selectedOptions
      }
    ]
  });
  const ranch = (groupName) => ({
    option_id: "shared-ranch",
    group_name: groupName,
    option_name: "Ranch",
    quantity: 1
  });

  const missingChoiceWarnings = await reorderWarnings(t, {
    cartUuid: "cart-missing-nested-choice",
    sourceItems: [item([ranch("Sauce"), ranch("Sauce")])],
    cartItems: [item([ranch("Sauce")])]
  });
  assert.match(
    missingChoiceWarnings.join(" "),
    /different modifier selections/
  );

  const wrongGroupWarnings = await reorderWarnings(t, {
    cartUuid: "cart-wrong-ranch-group",
    sourceItems: [item([ranch("Sauce"), ranch("Dressing")])],
    cartItems: [item([ranch("Sauce"), ranch("Sauce")])]
  });
  assert.match(
    wrongGroupWarnings.join(" "),
    /different modifier selections/
  );

  const missingGroupWarnings = await reorderWarnings(t, {
    cartUuid: "cart-missing-ranch-group",
    sourceItems: [item([ranch("Sauce")])],
    cartItems: [item([ranch(undefined)])]
  });
  assert.match(
    missingGroupWarnings.join(" "),
    /different modifier selections/
  );
});

test("reorder allocates mixed-specificity receipt variants without a false warning", async (t) => {
  const item = (cartItemId, selectedOptions) => ({
    id: cartItemId,
    item_id: "9459662774",
    name: "Deluxe Chicken Meal",
    quantity: 1,
    ...(selectedOptions ? { selected_options: selectedOptions } : {})
  });
  const option = (optionId, optionName) => ({
    option_id: optionId,
    option_name: optionName,
    quantity: 1
  });
  const warnings = await reorderWarnings(t, {
    cartUuid: "cart-mixed-specificity",
    sourceItems: [
      item("source-unknown"),
      item("source-pepper", [option("cheese-pepper", "Pepper Jack")])
    ],
    cartItems: [
      item("cart-american", [option("cheese-american", "American")]),
      item("cart-pepper", [option("cheese-pepper", "Pepper Jack")])
    ]
  });

  assert.doesNotMatch(warnings.join(" "), /different modifier selections/);
});

test("reorder reports quantity and modifier drift together", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const original = sourceOrder();
  original.items[0].selected_options = [
    { option_id: "cheese-pepper", name: "Pepper Jack", quantity: 1 }
  ];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "order" && args[1] === "receipt") {
        return cliResult(original);
      }
      if (args[0] === "cart" && args[1] === "list") {
        return cliResult({ carts: [] });
      }
      if (args[0] === "order" && args[1] === "reorder") {
        return cliResult({
          cart_uuid: "cart-variant",
          menu_id: "menu-chicken",
          items: []
        });
      }
      if (args[0] === "cart" && args[1] === "show") {
        return cliResult({
          cart_uuid: "cart-variant",
          store_id: "store-chicken",
          menu_id: "menu-chicken",
          items: [
            {
              id: "line-variant",
              item_id: "i_9459662774",
              name: "Deluxe Chicken Meal",
              quantity: 2,
              selected_options: [
                {
                  option_id: "cheese-american",
                  name: "American",
                  quantity: 1
                }
              ]
            }
          ]
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "reorder",
    arguments: { order_uuid: "order-source" }
  });

  assert.equal(response.result.isError, undefined);
  assert.match(
    response.result.structuredContent.warnings.join(" "),
    /changed from quantity 1 in history to 2/
  );
  assert.match(
    response.result.structuredContent.warnings.join(" "),
    /different modifier selections/
  );
  assert.equal(
    calls.filter(
      (args) => args[0] === "order" && args[1] === "reorder"
    ).length,
    1
  );
});

test("reorder rejects a mismatched hydration response", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "order" && args[1] === "receipt") {
        return cliResult(sourceOrder());
      }
      if (args[0] === "cart" && args[1] === "list") {
        return cliResult({ carts: [] });
      }
      if (args[0] === "order" && args[1] === "reorder") {
        return cliResult({ cart_uuid: "cart-new", items: [] });
      }
      if (args[0] === "cart" && args[1] === "show") {
        return cliResult({ cart_uuid: "cart-stale", items: [] });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "reorder",
    arguments: { order_uuid: "order-source" }
  });
  const error = response.result.structuredContent.error;

  assert.equal(response.result.isError, true);
  assert.equal(error.code, "REORDER_HYDRATION_FAILED");
  assert.equal(error.recovery_tool, "show_cart");
  assert.deepEqual(error.recovery_arguments, { cart_uuid: "cart-new" });
  assert.equal(
    calls.filter(
      (args) => args[0] === "order" && args[1] === "reorder"
    ).length,
    1
  );
});

test("order history hands one safe reorder into one customized cart add", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "order" && args[1] === "history") {
        return cliResult({ orders: [sourceOrder()] });
      }
      if (args[0] === "order" && args[1] === "receipt") {
        return cliResult(liveReceiptShape());
      }
      if (args[0] === "cart" && args[1] === "list") {
        return cliResult({ carts: [] });
      }
      if (args[0] === "order" && args[1] === "reorder") {
        return cliResult({
          success: true,
          cart_uuid: "cart-journey",
          menu_id: "menu-chicken",
          items: []
        });
      }
      if (args[0] === "cart" && args[1] === "show") {
        return cliResult({
          cart_uuid: "cart-journey",
          cart: {
            id: "cart-journey",
            store_id: "store-chicken",
            store_name: "Example Chicken",
            menu_id: "menu-chicken",
            items: [
              {
                id: "line-reordered",
                item_id: "i_9459662774",
                menu_id: "menu-chicken",
                name: "Deluxe Chicken Meal",
                quantity: 1
              }
            ]
          }
        });
      }
      if (args[0] === "restaurant-item-details") {
        return cliResult(ranchItemDetails());
      }
      if (args[0] === "cart" && args[1] === "add-items") {
        return cliResult({
          success: true,
          cart_uuid: "cart-journey",
          cart: {
            id: "cart-journey",
            store_id: "store-chicken",
            store_name: "Example Chicken",
            menu_id: "menu-chicken",
            items: [
              {
                id: "line-reordered",
                item_id: "i_9459662774",
                menu_id: "menu-chicken",
                name: "Deluxe Chicken Meal",
                quantity: 1
              },
              {
                id: "line-customized",
                item_id: "i_9459662774",
                menu_id: "menu-chicken",
                name: "Deluxe Chicken Meal",
                quantity: 1
              }
            ]
          }
        });
      }
      if (args[0] === "order" && args[1] === "checkout-url") {
        return cliResult({
          cart_uuid: "cart-journey",
          checkout_url: "https://www.doordash.test/checkout/cart-journey"
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const history = await mcpRequest(mcpHandler, auth, {
    name: "list_orders",
    arguments: {}
  });
  const historicalOrder = history.result.structuredContent.orders[0];
  assert.equal(historicalOrder.items[0].item_id, "i_9459662774");

  const reordered = await mcpRequest(
    mcpHandler,
    auth,
    {
      name: "reorder",
      arguments: { order_uuid: historicalOrder.order_uuid }
    },
    2
  );
  const cart = reordered.result.structuredContent;
  assert.equal(cart.cart_uuid, "cart-journey");
  assert.equal(cart.menu_id, "menu-chicken");
  assert.equal(cart.items.length, 1);

  const details = await mcpRequest(
    mcpHandler,
    auth,
    {
      name: "get_item_details",
      arguments: {
        store_id: cart.store.store_id,
        menu_id: cart.menu_id,
        item_id: historicalOrder.items[0].item_id,
        option_queries: ["Ranch"]
      }
    },
    3
  );
  assert.equal(details.result.isError, undefined);

  const added = await mcpRequest(
    mcpHandler,
    auth,
    {
      name: "add_cart_items",
      arguments: {
        store_id: cart.store.store_id,
        menu_id: cart.menu_id,
        cart_uuid: cart.cart_uuid,
        items: [
          {
            item_id: historicalOrder.items[0].item_id,
            name: details.result.structuredContent.item.name,
            requested_options: [
              {
                name: "Ranch",
                quantity: 2,
                option_id: "o_ranch_sauce"
              }
            ]
          }
        ]
      }
    },
    4
  );

  assert.equal(added.result.isError, undefined);
  assert.equal(
    added.result.structuredContent.checkout_url,
    "https://www.doordash.test/checkout/cart-journey"
  );
  assert.equal(
    calls.filter(
      (args) => args[0] === "order" && args[1] === "reorder"
    ).length,
    1
  );
  assert.equal(
    calls.filter(
      (args) => args[0] === "cart" && args[1] === "add-items"
    ).length,
    1
  );
});

test("bare restaurant item ID with menu_id uses restaurant details", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "restaurant-item-details") {
        return cliResult({
          item: {
            item_id: "9459662774",
            name: "Deluxe Chicken Meal"
          }
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "get_item_details",
    arguments: {
      store_id: "store-chicken",
      menu_id: "menu-chicken",
      item_id: "9459662774"
    }
  });

  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.structuredContent.menu_id, "menu-chicken");
  assert.equal(response.result.structuredContent.item.menu_id, "menu-chicken");
  assert.deepEqual(calls, [
    [
      "restaurant-item-details",
      "--store-id",
      "store-chicken",
      "--menu-id",
      "menu-chicken",
      "--item-id",
      "9459662774"
    ]
  ]);
});

test("restaurant item details never publishes store_id as menu_id", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "store-details") {
        return cliResult({
          success: true,
          store: {
            store_id: "store-chicken",
            name: "Example Chicken",
            menu_id: ""
          }
        });
      }
      if (args[0] === "restaurant-item-details") {
        const details = ranchItemDetails();
        details.menu_id = "store-chicken";
        details.store = {
          store_id: "store-chicken",
          menu_id: "store-chicken"
        };
        details.item.item_id = "i_9459662774";
        details.item.menu_id = "store-chicken";
        return cliResult(details);
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "get_item_details",
    arguments: {
      store_id: "store-chicken",
      menu_id: "store-chicken",
      item_id: "i_9459662774",
      option_queries: ["Ranch"]
    }
  });

  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.structuredContent.menu_id, undefined);
  assert.equal(response.result.structuredContent.store.menu_id, undefined);
  assert.equal(response.result.structuredContent.item.menu_id, undefined);
  assert.match(
    response.result.structuredContent.warnings.join(" "),
    /returned store_id as menu_id/i
  );
  assert.equal(
    response.result.structuredContent.item.item_id,
    "i_9459662774"
  );
  assert.deepEqual(calls.map((args) => args[0]), [
    "store-details",
    "restaurant-item-details"
  ]);
  assert.deepEqual(calls[1], [
    "restaurant-item-details",
    "--store-id",
    "store-chicken",
    "--menu-id",
    "store-chicken",
    "--item-id",
    "9459662774"
  ]);
});

test("restaurant item details preserves a menu_id returned by the item endpoint", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      if (args[0] === "store-details") {
        return cliResult({
          success: true,
          store: { store_id: "store-chicken", menu_id: "" }
        });
      }
      if (args[0] === "restaurant-item-details") {
        const details = ranchItemDetails();
        details.menu_id = "menu-authoritative";
        details.item.item_id = "i_9459662774";
        return cliResult(details);
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "get_item_details",
    arguments: {
      store_id: "store-chicken",
      item_id: "i_9459662774"
    }
  });

  assert.equal(response.result.isError, undefined);
  assert.equal(
    response.result.structuredContent.menu_id,
    "menu-authoritative"
  );
  assert.equal(
    response.result.structuredContent.item.menu_id,
    "menu-authoritative"
  );
});

test("get_menu query rejects stale input provenance and recovers a current history item", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "menu") {
        return cliResult({
          success: false,
          menu_id: "",
          message: "Something went wrong retrieving the menu."
        });
      }
      if (args[0] === "order" && args[1] === "history") {
        const order = sourceOrder();
        order.store.name = "Chick-fil-A";
        order.menu_id = "25103748";
        order.store.menu_id = "25103748";
        order.items[0].item_id = 111111;
        order.items[0].menu_id = "25103748";
        order.items[0].name = "Chick-fil-A® Chicken Sandwich Meal";
        return cliResult({ orders: [order] });
      }
      if (args[0] === "restaurant-item-details") {
        const details = ranchItemDetails();
        details.item.item_id = "i_111111";
        details.item.name = "Chick-fil-A® Chicken Sandwich Meal";
        return cliResult(details);
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "get_menu",
    arguments: {
      store_id: "store-chicken",
      menu_id: "25021439",
      query: "Chicken Sandwich Meal"
    }
  });

  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.structuredContent.menu_id, "25103748");
  assert.equal(response.result.structuredContent.items.length, 1);
  assert.equal(
    response.result.structuredContent.items[0].item_id,
    "i_111111"
  );
  assert.equal(
    response.result.structuredContent.items[0].name,
    "Chick-fil-A® Chicken Sandwich Meal"
  );
  assert.match(
    response.result.structuredContent.warnings.join(" "),
    /full-menu lookup failed.*order history/i
  );
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
    ["menu", "--store-id"],
    ["order", "history"],
    ["restaurant-item-details", "--store-id"]
  ]);
  assert.deepEqual(calls[2], [
    "restaurant-item-details",
    "--store-id",
    "store-chicken",
    "--menu-id",
    "25103748",
    "--item-id",
    "111111"
  ]);

  calls.length = 0;
  const unfiltered = await mcpRequest(
    mcpHandler,
    auth,
    {
      name: "get_menu",
      arguments: { store_id: "store-chicken" }
    },
    2
  );
  assert.equal(unfiltered.result.isError, undefined);
  assert.equal(unfiltered.result.structuredContent.items.length, 1);
  assert.match(
    unfiltered.result.structuredContent.warnings.join(" "),
    /not the store's complete menu/i
  );
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
    ["menu", "--store-id"],
    ["order", "history"],
    ["restaurant-item-details", "--store-id"]
  ]);
});

test("get_menu recovery inspects exact history matches after order 25", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "menu") {
        return cliResult({
          success: false,
          menu_id: "",
          message: "Something went wrong retrieving the menu."
        });
      }
      if (args[0] === "order" && args[1] === "history") {
        const fillerOrders = Array.from({ length: 25 }, (_, index) => {
          const order = sourceOrder();
          order.order_uuid = `order-filler-${index + 1}`;
          order.menu_id = "25103748";
          order.store.menu_id = "25103748";
          order.items[0].item_id = 100000 + index;
          order.items[0].menu_id = "25103748";
          order.items[0].name = `Different Meal ${index + 1}`;
          return order;
        });
        const targetOrder = sourceOrder();
        targetOrder.order_uuid = "order-target";
        targetOrder.menu_id = "25103748";
        targetOrder.store.menu_id = "25103748";
        targetOrder.items[0].item_id = 999999;
        targetOrder.items[0].menu_id = "25103748";
        targetOrder.items[0].name = "Chicken Sandwich Meal";
        return cliResult({ orders: [...fillerOrders, targetOrder] });
      }
      if (args[0] === "restaurant-item-details") {
        const details = ranchItemDetails();
        details.menu_id = "25103748";
        details.item.item_id = "i_999999";
        details.item.name = "Chicken Sandwich Meal";
        return cliResult(details);
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "get_menu",
    arguments: {
      store_id: "store-chicken",
      query: "Chicken Sandwich Meal"
    }
  });

  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.structuredContent.menu_id, "25103748");
  assert.deepEqual(
    response.result.structuredContent.items.map((item) => item.item_id),
    ["i_999999"]
  );
  const historyCall = calls.find(
    (args) => args[0] === "order" && args[1] === "history"
  );
  assert.ok(historyCall);
  assert.equal(historyCall[historyCall.indexOf("--max") + 1], "100");
  assert.deepEqual(calls.at(-1), [
    "restaurant-item-details",
    "--store-id",
    "store-chicken",
    "--menu-id",
    "25103748",
    "--item-id",
    "999999"
  ]);
});

test("get_menu never substitutes a qualified historical item for an unseen dish", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "menu") {
        return cliResult({
          success: false,
          menu_id: "",
          error_reason: "RESTAURANT_CATALOG_UNAVAILABLE",
          message: "Full menu unavailable."
        });
      }
      if (args[0] === "order" && args[1] === "history") {
        const spicy = sourceOrder();
        spicy.items[0].name = "Spicy Chicken Sandwich Deluxe Meal";
        const grilled = sourceOrder();
        grilled.order_uuid = "order-grilled";
        grilled.items[0].item_id = 222222;
        grilled.items[0].name = "Grilled Chicken Sandwich";
        return cliResult({ orders: [spicy, grilled] });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "get_menu",
    arguments: {
      store_id: "store-chicken",
      query: "Chicken Sandwich Meal"
    }
  });

  assert.equal(response.result.isError, true);
  assert.match(
    response.result.structuredContent.error.message,
    /cannot be safely discovered.*do not use find_items/i
  );
  assert.equal(
    calls.some((args) => args[0] === "restaurant-item-details"),
    false
  );
});

test("get_menu rejects store_id published as menu_id", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      assert.deepEqual(args, ["menu", "--store-id", "store-chicken"]);
      return cliResult({
        success: true,
        menu_id: "store-chicken",
        items: [
          {
            item_id: "i_9459662774",
            name: "Deluxe Chicken Meal"
          }
        ]
      });
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "get_menu",
    arguments: { store_id: "store-chicken" }
  });

  assert.equal(response.result.isError, true);
  assert.equal(
    response.result.structuredContent.error.code,
    "RESTAURANT_MENU_ID_UNAVAILABLE"
  );
  assert.match(
    response.result.structuredContent.error.message,
    /store_id as menu_id/i
  );
});

test("get_menu fallback treats store_id only as lookup context", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "menu") {
        return cliResult({
          success: false,
          menu_id: "",
          message: "Full menu unavailable."
        });
      }
      if (args[0] === "order" && args[1] === "history") {
        const order = sourceOrder();
        delete order.menu_id;
        delete order.store.menu_id;
        delete order.items[0].menu_id;
        return cliResult({ orders: [order] });
      }
      if (args[0] === "cart" && args[1] === "list") {
        return cliResult({ carts: [] });
      }
      if (args[0] === "restaurant-item-details") {
        const details = ranchItemDetails();
        details.menu_id = "menu-chicken";
        details.item.item_id = "i_9459662774";
        return cliResult(details);
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "get_menu",
    arguments: {
      store_id: "store-chicken",
      menu_id: "store-chicken",
      query: "Deluxe Chicken Meal"
    }
  });

  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.structuredContent.menu_id, "menu-chicken");
  assert.notEqual(
    response.result.structuredContent.menu_id,
    response.result.structuredContent.store.store_id
  );
  const detailsCall = calls.find(
    (args) => args[0] === "restaurant-item-details"
  );
  assert.equal(
    detailsCall[detailsCall.indexOf("--menu-id") + 1],
    "store-chicken"
  );
});

test("get_menu fallback keeps the newest historical item identity", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "menu") {
        return cliResult({
          success: false,
          menu_id: "",
          message: "Something went wrong retrieving the menu."
        });
      }
      if (args[0] === "order" && args[1] === "history") {
        const newest = sourceOrder();
        const older = sourceOrder();
        older.order_uuid = "order-older";
        older.items[0].name = "Retired Deluxe Chicken Meal";
        return cliResult({
          orders: [
            { ...sourceOrder(), order_uuid: "order-empty", items: [] },
            newest,
            older
          ]
        });
      }
      if (args[0] === "restaurant-item-details") {
        const details = ranchItemDetails();
        details.item.item_id = "i_9459662774";
        return cliResult(details);
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "get_menu",
    arguments: {
      store_id: "store-chicken",
      query: "Deluxe Chicken Meal"
    }
  });

  assert.equal(response.result.isError, undefined);
  assert.deepEqual(
    response.result.structuredContent.items.map((item) => item.name),
    ["Deluxe Chicken Meal"]
  );
  assert.equal(
    calls.filter((args) => args[0] === "restaurant-item-details").length,
    1
  );
});

test("get_menu fallback rejects mismatched current item details", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      if (args[0] === "menu") {
        return cliResult({
          success: false,
          menu_id: "",
          error_reason: "TEMPORARY_UPSTREAM_FAILURE",
          message: "Full menu unavailable."
        });
      }
      if (args[0] === "order" && args[1] === "history") {
        return cliResult({ orders: [sourceOrder()] });
      }
      if (args[0] === "restaurant-item-details") {
        const details = ranchItemDetails();
        details.item.item_id = "i_different_item";
        return cliResult(details);
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "get_menu",
    arguments: {
      store_id: "store-chicken",
      query: "Deluxe Chicken Meal"
    }
  });

  assert.equal(response.result.isError, true);
  assert.equal(
    response.result.structuredContent.error.code,
    "TEMPORARY_UPSTREAM_FAILURE"
  );
  assert.equal(
    response.result.structuredContent.error.message,
    "Full menu unavailable."
  );
});

test("get_menu rejects a whitespace-only query before the CLI", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  let cliCalls = 0;
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async () => {
      cliCalls += 1;
      throw new Error("The CLI must not run for invalid input.");
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "get_menu",
    arguments: { store_id: "store-chicken", query: "   " }
  });

  assert.equal(response.result.isError, true);
  assert.equal(cliCalls, 0);
});

test("find_items rejects a restaurant before the retail catalog call", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "store-details") {
        return cliResult({
          success: true,
          store: {
            store_id: "store-chicken",
            name: "Example Chicken",
            business_vertical_id: 0
          }
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "find_items",
    arguments: {
      store_id: "store-chicken",
      queries: ["Chicken Sandwich Meal"]
    }
  });

  assert.equal(response.result.isError, true);
  assert.equal(
    response.result.structuredContent.error.code,
    "RESTAURANT_REQUIRES_MENU"
  );
  assert.equal(
    response.result.structuredContent.error.recovery_tool,
    "get_menu"
  );
  assert.deepEqual(
    response.result.structuredContent.error.recovery_arguments,
    {
      store_id: "store-chicken",
      query: "Chicken Sandwich Meal"
    }
  );
  assert.deepEqual(calls.map((args) => args[0]), ["store-details"]);
});

test("find_items gives no unsafe recovery for multiple restaurant queries", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "store-details") {
        return cliResult({
          success: true,
          store: {
            store_id: "store-chicken",
            business_vertical_id: 0
          }
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "find_items",
    arguments: {
      store_id: "store-chicken",
      queries: ["Chicken Sandwich Meal", "Waffle Fries"]
    }
  });

  assert.equal(response.result.isError, true);
  assert.equal(
    response.result.structuredContent.error.code,
    "RESTAURANT_REQUIRES_SINGLE_MENU_QUERY"
  );
  assert.equal(
    response.result.structuredContent.error.recovery_tool,
    undefined
  );
  assert.match(
    response.result.structuredContent.error.message,
    /call get_menu once per dish.*2 queries/i
  );
  assert.deepEqual(calls.map((args) => args[0]), ["store-details"]);
});

test("replacement removal requires the verified new cart line", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  let replacementPresent = false;
  let oldLineRemoved = false;
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "cart" && args[1] === "show") {
        return cliResult({
          cart_uuid: "cart-existing",
          menu_id: "menu-chicken",
          store: { store_id: "store-chicken", menu_id: "menu-chicken" },
          items: [
            ...(oldLineRemoved
              ? []
              : [
                  {
                    id: "line-old",
                    item_id: "old-meal",
                    menu_id: "menu-chicken",
                    name: "Old Meal",
                    quantity: 1
                  }
                ]),
            ...(replacementPresent
              ? [
                  {
                    id: "line-new",
                    item_id: "new-meal",
                    menu_id: "menu-chicken",
                    name: "Replacement Meal",
                    quantity: 1
                  }
                ]
              : [])
          ]
        });
      }
      if (args[0] === "cart" && args[1] === "remove-item") {
        oldLineRemoved = true;
        return cliResult({
          success: true,
          cart_uuid: "cart-existing",
          message: "Removed item from cart successfully."
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const missing = await mcpRequest(mcpHandler, auth, {
    name: "remove_cart_item",
    arguments: {
      cart_uuid: "cart-existing",
      cart_item_id: "line-old",
      replacement_cart_item_id: "line-new"
    }
  });

  assert.equal(missing.result.isError, true);
  assert.equal(
    missing.result.structuredContent.error.code,
    "REPLACEMENT_LINE_NOT_FOUND"
  );
  assert.equal(
    calls.some(
      (args) => args[0] === "cart" && args[1] === "remove-item"
    ),
    false
  );

  replacementPresent = true;
  calls.length = 0;
  const removed = await mcpRequest(
    mcpHandler,
    auth,
    {
      name: "remove_cart_item",
      arguments: {
        cart_uuid: "cart-existing",
        cart_item_id: "line-old",
        replacement_cart_item_id: "line-new"
      }
    },
    2
  );

  assert.equal(removed.result.isError, undefined);
  assert.equal(removed.result.structuredContent.kind, "cart");
  assert.deepEqual(
    removed.result.structuredContent.items.map(
      (item) => item.cart_item_id
    ),
    ["line-new"]
  );
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
    ["cart", "show"],
    ["cart", "remove-item"],
    ["cart", "show"]
  ]);
});

test("remove_cart_item fails closed when the hydrated cart is truncated", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  let removed = false;
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "cart" && args[1] === "show") {
        return cliResult({
          cart_uuid: "cart-existing",
          items: removed
            ? Array.from({ length: 101 }, (_, index) => ({
                id: `line-${index}`,
                item_id: `item-${index}`,
                name: `Item ${index}`,
                quantity: 1
              }))
            : [
                {
                  id: "line-old",
                  item_id: "old-meal",
                  name: "Old Meal",
                  quantity: 1
                }
              ]
        });
      }
      if (args[0] === "cart" && args[1] === "remove-item") {
        removed = true;
        return cliResult({
          success: true,
          cart_uuid: "cart-existing"
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "remove_cart_item",
    arguments: {
      cart_uuid: "cart-existing",
      cart_item_id: "line-old",
      confirm_delete_without_replacement: true
    }
  });

  assert.equal(response.result.isError, true);
  assert.equal(
    response.result.structuredContent.error.code,
    "CART_REMOVAL_HYDRATION_FAILED"
  );
  assert.deepEqual(
    response.result.structuredContent.error.recovery_arguments,
    { cart_uuid: "cart-existing" }
  );
  assert.match(
    response.result.structuredContent.error.message,
    /hydrated cart was truncated/i
  );
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
    ["cart", "show"],
    ["cart", "remove-item"],
    ["cart", "show"]
  ]);
});

test("bare nested options fall back to restaurant preflight", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "cart" && args[1] === "show") {
        return cliResult({
          cart_uuid: "cart-existing",
          menu_id: "menu-chicken",
          store: { store_id: "store-chicken", menu_id: "menu-chicken" },
          items: []
        });
      }
      if (args[0] === "store-details") {
        return cliResult({
          success: true,
          store: {
            store_id: "store-chicken",
            business_vertical_id: 0
          }
        });
      }
      if (args[0] === "item-details") {
        throw new Error("Restaurant preflight must not use retail details.");
      }
      if (args[0] === "restaurant-item-details") {
        const details = ranchItemDetails();
        details.item.item_id = "history-item";
        return cliResult(details);
      }
      if (args[0] === "cart" && args[1] === "add-items") {
        return cliResult({
          cart_uuid: "cart-existing",
          items: [
            {
              id: "line-new",
              item_id: "history-item",
              menu_id: "menu-chicken",
              name: "Deluxe Chicken Meal",
              quantity: 1
            }
          ]
        });
      }
      if (args[0] === "order" && args[1] === "checkout-url") {
        return cliResult({
          cart_uuid: "cart-existing",
          checkout_url: "https://www.doordash.test/checkout/cart-existing"
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "add_cart_items",
    arguments: {
      store_id: "store-chicken",
      menu_id: "store-chicken",
      cart_uuid: "cart-existing",
      items: [
        {
          item_id: "history-item",
          name: "Deluxe Chicken Meal",
          nested_options: [
            { option_id: "o_ranch_sauce", name: "Ranch" }
          ]
        }
      ]
    }
  });

  assert.equal(response.result.isError, undefined);
  assert.deepEqual(calls.map((args) => args[0]), [
    "cart",
    "store-details",
    "restaurant-item-details",
    "cart",
    "order"
  ]);
  assert.equal(
    calls
      .find((args) => args[0] === "restaurant-item-details")
      .includes("menu-chicken"),
    true
  );
  assert.equal(
    calls
      .find((args) => args[0] === "cart" && args[1] === "add-items")
      .includes("menu-chicken"),
    true
  );
});

test("numeric retail IDs stay on retail preflight", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "cart" && args[1] === "show") {
        return cliResult({
          cart_uuid: "cart-retail",
          menu_id: "retail-menu",
          store: { store_id: "retail-store", menu_id: "retail-menu" },
          items: []
        });
      }
      if (args[0] === "store-details") {
        return cliResult({
          success: true,
          store: { store_id: "retail-store", business_vertical_id: 1 }
        });
      }
      if (args[0] === "item-details") {
        return cliResult({
          item: {
            item_id: "12345",
            name: "Sparkling Water",
            extras: [
              {
                extra_id: "flavor",
                title: "Flavor",
                min_num_options: 0,
                max_num_options: 1,
                options: [{ option_id: "o_lime", name: "Lime" }]
              }
            ]
          }
        });
      }
      if (args[0] === "cart" && args[1] === "add-items") {
        return cliResult({
          cart_uuid: "cart-retail",
          items: [
            {
              id: "line-retail",
              item_id: "12345",
              name: "Sparkling Water",
              quantity: 1
            }
          ]
        });
      }
      if (args[0] === "order" && args[1] === "checkout-url") {
        return cliResult({
          cart_uuid: "cart-retail",
          checkout_url: "https://www.doordash.test/checkout/cart-retail"
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "add_cart_items",
    arguments: {
      store_id: "retail-store",
      menu_id: "retail-menu",
      cart_uuid: "cart-retail",
      items: [
        {
          item_id: "12345",
          name: "Sparkling Water",
          nested_options: [{ option_id: "o_lime", name: "Lime" }]
        }
      ]
    }
  });

  assert.equal(response.result.isError, undefined);
  assert.deepEqual(calls.map((args) => args[0]), [
    "cart",
    "store-details",
    "item-details",
    "cart",
    "order"
  ]);
});

test("retail operational failures are not masked by restaurant fallback", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "cart" && args[1] === "show") {
        return cliResult({
          cart_uuid: "cart-retail",
          menu_id: "retail-menu",
          store: { store_id: "retail-store", menu_id: "retail-menu" },
          items: []
        });
      }
      if (args[0] === "store-details") {
        return cliResult({
          success: true,
          store: { store_id: "retail-store", business_vertical_id: 1 }
        });
      }
      if (args[0] === "item-details") {
        return cliResult({
          success: false,
          error_reason: "TEMPORARY_UPSTREAM_FAILURE",
          message: "Please try again later."
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "add_cart_items",
    arguments: {
      store_id: "retail-store",
      menu_id: "retail-menu",
      cart_uuid: "cart-retail",
      items: [
        {
          item_id: "retail-item",
          name: "Sparkling Water",
          nested_options: [{ option_id: "o_lime", name: "Lime" }]
        }
      ]
    }
  });

  assert.equal(response.result.isError, true);
  assert.equal(
    response.result.structuredContent.error.code,
    "TEMPORARY_UPSTREAM_FAILURE"
  );
  assert.equal(
    response.result.structuredContent.error.message,
    "Please try again later."
  );
  assert.deepEqual(calls.map((args) => args[0]), [
    "cart",
    "store-details",
    "item-details"
  ]);
});

test("malformed retail modifiers do not trigger restaurant fallback", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "cart" && args[1] === "show") {
        return cliResult({
          cart_uuid: "cart-retail",
          menu_id: "retail-menu",
          store: { store_id: "retail-store", menu_id: "retail-menu" },
          items: []
        });
      }
      if (args[0] === "store-details") {
        return cliResult({
          success: true,
          store: { store_id: "retail-store", business_vertical_id: 1 }
        });
      }
      if (args[0] === "item-details") {
        return cliResult({
          item: {
            item_id: "retail-item",
            name: "Sparkling Water",
            extras: [
              {
                extra_id: "flavor",
                title: "Flavor",
                options: [{ name: "Lime" }]
              }
            ]
          }
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "add_cart_items",
    arguments: {
      store_id: "retail-store",
      menu_id: "retail-menu",
      cart_uuid: "cart-retail",
      items: [
        {
          item_id: "retail-item",
          name: "Sparkling Water",
          nested_options: [{ option_id: "o_lime", name: "Lime" }]
        }
      ]
    }
  });

  assert.equal(response.result.isError, true);
  assert.equal(
    response.result.structuredContent.error.code,
    "UPSTREAM_SCHEMA_ERROR"
  );
  assert.deepEqual(calls.map((args) => args[0]), [
    "cart",
    "store-details",
    "item-details"
  ]);
});

test("restaurant fallback is not repeated after a name mismatch", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "cart" && args[1] === "show") {
        return cliResult({
          cart_uuid: "cart-existing",
          menu_id: "menu-chicken",
          store: { store_id: "store-chicken", menu_id: "menu-chicken" },
          items: []
        });
      }
      if (args[0] === "store-details") {
        return cliResult({ success: true, store: { store_id: "store-chicken" } });
      }
      if (args[0] === "item-details") {
        return cliResult({ item: { message: "Use restaurant details." } });
      }
      if (args[0] === "restaurant-item-details") {
        const details = ranchItemDetails();
        details.item.item_id = "history-item";
        details.item.name = "Different Chicken Meal";
        return cliResult(details);
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "add_cart_items",
    arguments: {
      store_id: "store-chicken",
      menu_id: "menu-chicken",
      cart_uuid: "cart-existing",
      items: [
        {
          item_id: "history-item",
          name: "Deluxe Chicken Meal",
          nested_options: [
            { option_id: "o_ranch_sauce", name: "Ranch" }
          ]
        }
      ]
    }
  });

  assert.equal(response.result.isError, true);
  assert.match(
    response.result.structuredContent.item_errors[0].message,
    /name must exactly match "Different Chicken Meal"/
  );
  assert.deepEqual(calls.map((args) => args[0]), [
    "cart",
    "store-details",
    "item-details",
    "restaurant-item-details"
  ]);
});

test("get_menu preserves success:false when history recovery is unavailable", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "menu") {
        return cliResult({
          success: false,
          menu_id: "",
          error_reason: "TEMPORARY_UPSTREAM_FAILURE",
          message: "Please try again."
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "get_menu",
    arguments: { store_id: "store-chicken" }
  });
  const error = response.result.structuredContent.error;

  assert.equal(response.result.isError, true);
  assert.equal(error.code, "TEMPORARY_UPSTREAM_FAILURE");
  assert.equal(error.message, "Please try again.");
  assert.notEqual(error.code, "UPSTREAM_SCHEMA_ERROR");
  assert.deepEqual(calls.map((args) => args[0]), ["menu", "order"]);
});

test("preview preserves success:false before quote validation", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      if (args[0] === "order" && args[1] === "preview") {
        return cliResult({
          success: false,
          error_reason: "PREVIEW_UNAVAILABLE",
          message: "Please try again later."
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const response = await mcpRequest(mcpHandler, auth, {
    name: "preview_order",
    arguments: { cart_uuid: "cart-1" }
  });
  const error = response.result.structuredContent.error;

  assert.equal(response.result.isError, true);
  assert.equal(error.code, "PREVIEW_UNAVAILABLE");
  assert.equal(error.message, "Please try again later.");
  assert.notEqual(error.code, "PREVIEW_OUTCOME_UNKNOWN");
});

test("Ranch ambiguity requires option_id and preserves quantity two", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "restaurant-item-details") {
        return cliResult(ranchItemDetails());
      }
      if (args[0] === "cart" && args[1] === "list") {
        return cliResult({ carts: [] });
      }
      if (args[0] === "cart" && args[1] === "add-items") {
        return cliResult({
          success: true,
          cart_uuid: "cart-ranch",
          cart: {
            id: "cart-ranch",
            store_id: "store-chicken",
            store_name: "Example Chicken",
            menu_id: "menu-chicken",
            items: [
              {
                id: "line-ranch",
                item_id: "9459662774",
                menu_id: "menu-chicken",
                name: "Deluxe Chicken Meal",
                quantity: 1
              }
            ]
          }
        });
      }
      if (args[0] === "order" && args[1] === "checkout-url") {
        return cliResult({
          cart_uuid: "cart-ranch",
          checkout_url: "https://www.doordash.test/checkout/cart-ranch"
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const baseArguments = {
    store_id: "store-chicken",
    menu_id: "menu-chicken",
    items: [
      {
        item_id: "9459662774",
        name: "Deluxe Chicken Meal",
        quantity: 1
      }
    ]
  };
  const ambiguous = await mcpRequest(mcpHandler, auth, {
    name: "add_cart_items",
    arguments: {
      ...baseArguments,
      items: [
        {
          ...baseArguments.items[0],
          requested_options: [{ name: "Ranch", quantity: 2 }]
        }
      ]
    }
  });

  assert.equal(ambiguous.result.isError, true);
  assert.deepEqual(ambiguous.result.structuredContent.items, []);
  assert.match(
    ambiguous.result.structuredContent.item_errors[0].message,
    /Ranch.*ambiguous/
  );
  assert.deepEqual(
    modifierOptionIds(
      ambiguous.result.structuredContent.item_errors[0].modifier_groups
    ).sort(),
    ["o_ranch_dressing", "o_ranch_sauce"]
  );

  const resolved = await mcpRequest(
    mcpHandler,
    auth,
    {
      name: "add_cart_items",
      arguments: {
        ...baseArguments,
        items: [
          {
            ...baseArguments.items[0],
            requested_options: [
              {
                name: "Ranch",
                quantity: 2,
                option_id: "o_ranch_sauce"
              }
            ]
          }
        ]
      }
    },
    2
  );

  assert.equal(resolved.result.isError, undefined);
  assert.equal(
    resolved.result.structuredContent.checkout_url,
    "https://www.doordash.test/checkout/cart-ranch"
  );
  const addCalls = calls.filter(
    (args) => args[0] === "cart" && args[1] === "add-items"
  );
  assert.equal(addCalls.length, 1);
  const submittedItems = JSON.parse(
    addCalls[0][addCalls[0].indexOf("--items-json") + 1]
  );
  assert.deepEqual(submittedItems[0].nested_options, [
    {
      id: "o_ranch_sauce",
      name: "Ranch",
      quantity: 2
    }
  ]);
});
