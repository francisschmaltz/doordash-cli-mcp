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

test("restaurant item details uses store_id when menu_id lookup is empty", async (t) => {
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
      item_id: "i_9459662774",
      option_queries: ["Ranch"]
    }
  });

  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.structuredContent.menu_id, "store-chicken");
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

test("get_menu query recovers a current history item when full menu fails", async (t) => {
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
        return cliResult({ orders: [sourceOrder()] });
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
      query: "Deluxe Chicken Meal"
    }
  });

  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.structuredContent.menu_id, "menu-chicken");
  assert.equal(response.result.structuredContent.items.length, 1);
  assert.equal(
    response.result.structuredContent.items[0].item_id,
    "i_9459662774"
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

test("bare nested options fall back to restaurant preflight", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "item-details") {
        return cliResult({
          success: false,
          message: "This is not a retail item."
        });
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

  assert.equal(response.result.isError, undefined);
  assert.deepEqual(calls.map((args) => args[0]), [
    "item-details",
    "restaurant-item-details",
    "cart",
    "order"
  ]);
});

test("numeric retail IDs stay on retail preflight", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
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
  assert.deepEqual(calls.map((args) => args[0]), ["item-details"]);
});

test("malformed retail modifiers do not trigger restaurant fallback", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
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
  assert.deepEqual(calls.map((args) => args[0]), ["item-details"]);
});

test("restaurant fallback is not repeated after a name mismatch", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = authInfo(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
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
