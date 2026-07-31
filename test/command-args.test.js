import assert from "node:assert/strict";
import test from "node:test";

import {
  addCartItemsArgs,
  checkoutLinkArgs,
  listOrdersArgs,
  previewOrderArgs,
  removeCartItemArgs,
  reorderArgs,
  showCartArgs,
  submitOrderArgs
} from "../src/command-args.js";

test("builds order history arguments", () => {
  assert.deepEqual(listOrdersArgs({ max: 10, days: 30 }), [
    "order",
    "history",
    "--max",
    "10",
    "--days",
    "30"
  ]);
});

test("builds reorder arguments", () => {
  assert.deepEqual(reorderArgs({ orderUuid: "order-123" }), [
    "order",
    "reorder",
    "--order-uuid",
    "order-123"
  ]);
});

test("builds cart inspection and mutation arguments", () => {
  assert.deepEqual(showCartArgs({ cartUuid: "cart-123" }), [
    "cart",
    "show",
    "--cart-uuid",
    "cart-123"
  ]);
  assert.deepEqual(
    removeCartItemArgs({ cartUuid: "cart-123", cartItemId: "line-42" }),
    [
      "cart",
      "remove-item",
      "--cart-uuid",
      "cart-123",
      "--cart-item-id",
      "line-42"
    ]
  );
});

test("builds checkout link arguments", () => {
  assert.deepEqual(checkoutLinkArgs({ cartUuid: "cart-123" }), [
    "order",
    "checkout-url",
    "--cart-uuid",
    "cart-123"
  ]);
});

test("builds nested additive cart arguments", () => {
  assert.deepEqual(
    addCartItemsArgs({
      storeId: "store-1",
      menuId: "menu-1",
      cartUuid: "cart-1",
      fulfillment: "delivery",
      groupCart: true,
      items: [
        {
          itemId: "item-1",
          itemName: "Combo",
          quantity: 2,
          nestedOptions: [
            {
              id: "protein-1",
              name: "Chicken",
              quantity: 1,
              options: [{ id: "sauce-1", name: "Hot", quantity: 1 }]
            }
          ]
        }
      ]
    }),
    [
      "cart",
      "add-items",
      "--store-id",
      "store-1",
      "--menu-id",
      "menu-1",
      "--items-json",
      JSON.stringify([
        {
          item_id: "item-1",
          item_name: "Combo",
          quantity: 2,
          nested_options: [
            {
              id: "protein-1",
              name: "Chicken",
              quantity: 1,
              options: [{ id: "sauce-1", name: "Hot", quantity: 1 }]
            }
          ]
        }
      ]),
      "--cart-uuid",
      "cart-1",
      "--fulfillment",
      "delivery",
      "--group-cart"
    ]
  );
});

test("keeps preview and submit pricing flags aligned", () => {
  const shared = {
    cartUuid: "cart-1",
    scheduledTime: "2026-08-01T18:00:00Z",
    fulfillment: "delivery",
    priority: true,
    applyCredits: false
  };
  assert.deepEqual(previewOrderArgs(shared), [
    "order",
    "preview",
    "--cart-uuid",
    "cart-1",
    "--scheduled-time",
    "2026-08-01T18:00:00Z",
    "--fulfillment",
    "delivery",
    "--priority",
    "--no-apply-credits"
  ]);
  assert.deepEqual(submitOrderArgs({ ...shared, tipCents: 500 }), [
    "order",
    "submit",
    "--cart-uuid",
    "cart-1",
    "--tip-cents",
    "500",
    "--yes",
    "--scheduled-time",
    "2026-08-01T18:00:00Z",
    "--fulfillment",
    "delivery",
    "--priority",
    "--no-apply-credits"
  ]);
});
