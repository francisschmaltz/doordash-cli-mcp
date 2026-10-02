import assert from "node:assert/strict";
import test from "node:test";

import { addCartItemsArgs } from "../src/command-args.js";
import {
  classifyOrderStatus,
  contractForTool,
  contracts,
  errorEnvelope,
  normalizeOrderStatusData,
  projectWithContract,
  publicOutputSchemaForTool,
  toToolResult
} from "../src/response-contract.js";

test("v0.2.5 cart input opts out of automatic merchant modifiers", () => {
  const args = addCartItemsArgs({
    storeId: "restaurant-1",
    menuId: "menu-1",
    items: [
      {
        itemId: "item-1",
        itemName: "Sandwich",
        quantity: 1,
        nestedOptions: [
          {
            option_id: "choice-1",
            name: "No onions",
            options: [{ option_id: "choice-2", name: "Extra mustard" }]
          }
        ]
      },
      { itemId: "item-2", itemName: "Drink", quantity: 1, nestedOptions: [] }
    ]
  });
  const items = JSON.parse(args[args.indexOf("--items-json") + 1]);
  assert.equal(items[0].default_handling, "exact");
  assert.deepEqual(items[0].nested_options, [{
    id: "choice-1",
    name: "No onions",
    quantity: 1,
    options: [{ id: "choice-2", name: "Extra mustard", quantity: 1 }]
  }]);
  assert.equal(items[1].default_handling, "exact");
  assert.deepEqual(items[1].nested_options, []);
});

test("order status accepts lifecycle states without claiming delivery is complete", () => {
  for (const status of [
    "pending", "action_required", "order_declined", "placed", "scheduled",
    "store_confirmed", "ready_for_pickup", "dasher_assigned", "dasher_at_store",
    "picked_up", "dasher_nearby", "completed", "cancelled"
  ]) {
    const projected = projectWithContract(contracts.orderStatus, {
      order_uuid: "order-1", status
    });
    assert.equal(projected.status, status);
    assert.equal(projected.order_uuid, "order-1");
    assert.match(toToolResult(projected).content[0].text, new RegExp(`: ${status}\\.`));
  }
  assert.deepEqual(classifyOrderStatus("placed"), {
    status: "placed", created: true, terminal: false, failed: false
  });
  assert.deepEqual(classifyOrderStatus("dasher_assigned"), {
    status: "dasher_assigned", created: true, terminal: false, failed: false
  });
  assert.deepEqual(classifyOrderStatus("completed"), {
    status: "completed", created: true, terminal: true, failed: false
  });
  assert.deepEqual(classifyOrderStatus("cancelled"), {
    status: "cancelled", created: true, terminal: true, failed: true
  });
  assert.deepEqual(classifyOrderStatus("order_declined"), {
    status: "order_declined", created: false, terminal: true, failed: true
  });
  assert.equal(classifyOrderStatus("action_required").terminal, true);
  assert.equal(classifyOrderStatus("pending").created, false);
  assert.equal(classifyOrderStatus("pending").terminal, false);
  assert.equal(classifyOrderStatus("successful").created, true);
  assert.equal(classifyOrderStatus("successful").terminal, true);
  assert.equal(classifyOrderStatus("failed").failed, true);
  assert.equal(classifyOrderStatus("not_found").failed, true);
  assert.equal(classifyOrderStatus("unknown").created, false);
});

test("nested status envelopes preserve root order identity and tracking links", () => {
  for (const response of [
    { order_status: "placed" },
    { result: { status: "placed" } },
    { order: { status: "placed" } },
    { result: { order: { order_status: "placed" } } },
    { order_status: { status: "placed" } },
    { result: { order_status: { status: "placed" } } }
  ]) {
    const raw = {
      order_uuid: "order-1",
      tracking_url: "https://www.doordash.test/orders/order-1",
      ...response
    };
    assert.equal(normalizeOrderStatusData(raw).status, "placed");
    assert.equal(classifyOrderStatus(raw).created, true);
    const projected = projectWithContract(contracts.orderStatus, raw);
    assert.equal(projected.order_uuid, "order-1");
    assert.equal(projected.tracking_url, raw.tracking_url);
    assert.equal(projected.status, "placed");
  }
  assert.throws(
    () => projectWithContract(contracts.orderStatus, { order_uuid: "order-1" }),
    /did not contain a status/
  );
});

test("submitted order uses nested final lifecycle status and final links", () => {
  const projected = projectWithContract(contracts.orderSubmit, {
    submitted: { order_uuid: "order-1" },
    preview: { cart_uuid: "cart-1", quote: { store_order_cart: { orders: [] } } },
    finalStatus: {
      order_uuid: "order-1",
      result: {
        order_status: {
          status: "store_confirmed",
          tracking_url: "https://www.doordash.test/orders/order-1"
        }
      }
    },
    terminalStatus: "store_confirmed"
  });
  assert.equal(projected.order_uuid, "order-1");
  assert.equal(projected.status, "store_confirmed");
  assert.equal(projected.tracking_url, "https://www.doordash.test/orders/order-1");
});

test("v0.2.5 explicit null result distinguishes missing orders from lookup failures", () => {
  const notFound = { success: true, order_uuid: "order-1", result: null };
  assert.equal(projectWithContract(contracts.orderStatus, notFound).status, "not_found");
  assert.deepEqual(classifyOrderStatus(notFound), {
    status: "not_found", created: false, terminal: true, failed: true
  });
  assert.throws(
    () => projectWithContract(contracts.orderStatus, {
      success: false, result: null, message: "Status lookup failed."
    }),
    /Status lookup failed/
  );
  for (const malformed of [{ result: null }, { success: true, result: "bad" }]) {
    assert.throws(
      () => projectWithContract(contracts.orderStatus, malformed),
      /did not contain a status/
    );
  }
});

test("nested lifecycle status retains its pickup mode and timestamp ETA", () => {
  const delivery = projectWithContract(contracts.orderStatus, {
    success: true,
    order_uuid: "order-1",
    result: {
      status: "dasher_assigned",
      is_pickup: false,
      delivery_window_start: "2026-10-02T02:00:00Z",
      delivery_window_end: "2026-10-02T02:10:00Z"
    }
  });
  assert.equal(delivery.fulfillment, "delivery");
  assert.equal(delivery.delivery_time, "2026-10-02T02:00:00.000Z – 2026-10-02T02:10:00.000Z");
  const pickup = projectWithContract(contracts.orderStatus, {
    success: true,
    order_uuid: "order-1",
    result: {
      status: "store_confirmed",
      is_pickup: true,
      estimated_pickup_time: "2026-10-02T02:00:00Z"
    }
  });
  assert.equal(pickup.fulfillment, "pickup");
  assert.equal(pickup.delivery_time, "2026-10-02T02:00:00.000Z");
});

test("credential status exposes only status and renewal guidance", () => {
  assert.equal(contractForTool("doordash_auth"), contracts.credentials);
  const projected = projectWithContract(contracts.credentials, {
    configured: true,
    authenticated: false,
    expires_at: "2026-10-02T02:00:00Z",
    message: "DoorDash login expired. Request a replacement from dd-cli export-token.",
    access_token: "credential-value-must-not-appear",
    credentials: { access_token: "nested-credential-must-not-appear" }
  });
  assert.deepEqual(publicOutputSchemaForTool("doordash_auth").parse(projected), projected);
  const result = toToolResult(projected);
  assert.equal(JSON.stringify(result).includes("must-not-appear"), false);
  assert.equal(result.content[0].text, projected.message);
  assert.equal("access_token" in projected, false);
});

test("authentication recovery asks for a new credential and preserves mutation inspection", () => {
  const error = new Error("DoorDash authentication is missing or expired.");
  error.code = "DOORDASH_AUTH_REQUIRED";
  const projected = errorEnvelope(contracts.orderSubmit, error);
  assert.deepEqual(projected.error.recovery_arguments, {});
  assert.equal(projected.error.recovery_tool, "doordash_auth");
  assert.equal(projected.error.retryable, false);
  const summary = toToolResult(projected).content[0].text;
  assert.match(summary, /Ask the user for a replacement from dd-cli export-token/);
  assert.match(summary, /inspect its outcome first/);
  assert.doesNotMatch(summary, /retry once/);
});

test("auth failure after a write retains unknown outcome and asks for renewal first", () => {
  const error = new Error("Cart write outcome is unknown. After renewal, call show_cart and inspect the cart before making another change.");
  error.details = {
    code: "CART_WRITE_OUTCOME_UNKNOWN",
    cartUuid: "cart-1",
    requiresCredentialRenewal: true
  };
  const projected = errorEnvelope(contracts.cart, error);
  assert.equal(projected.error.code, "CART_WRITE_OUTCOME_UNKNOWN");
  assert.equal(projected.error.message, error.message);
  assert.equal(projected.error.recovery_tool, "doordash_auth");
  assert.deepEqual(projected.error.recovery_arguments, {});
  assert.equal(projected.error.retryable, false);
  const summary = toToolResult(projected).content[0].text;
  assert.match(summary, /After renewal, call show_cart/);
  assert.match(summary, /Ask the user for a replacement from dd-cli export-token/);
  assert.match(summary, /inspect its outcome first/);
});
