import assert from "node:assert/strict";
import test from "node:test";

import {
  contractForCommand,
  contracts,
  errorEnvelope,
  money,
  projectWithContract
} from "../src/response-contract.js";
import {
  redactForActivity,
  sanitizeCommandForActivity
} from "../src/projections.js";

test("typed CLI commands resolve to their advertised response families", () => {
  assert.equal(
    contractForCommand(["address", "set", "--address-id", "address-1"]),
    contracts.addressUpdate
  );
  assert.equal(
    contractForCommand(["order", "preview", "--cart-uuid", "cart-1"]),
    contracts.orderPreview
  );
  assert.equal(
    contractForCommand(["promo", "apply", "--cart-uuid", "cart-1"]),
    contracts.promotionMutation
  );
  assert.equal(
    contractForCommand(["future-safe-command"]),
    contracts.rawCli
  );
});

test("money converts cents to rounded floating-point dollars", () => {
  assert.equal(
    money({
      unit_amount: 1235,
      currency: "USD",
      display_string: "$12.35"
    }),
    12.35
  );
  assert.equal(money(1235, { cents: true }), 12.35);
});

test("store search emits one display distance and one delivery range", () => {
  const projected = projectWithContract(contracts.storeSearch, {
    success: true,
    stores: [
      {
        store_id: 928163,
        name: "Example Pizza",
        image_url: "https://img.example/store.jpg",
        printable_address: "123 Main St",
        latitude: 37.8,
        longitude: -122.2,
        distance_miles: 1.25,
        distance_display: "2011 m",
        distance_meters: 1609.344,
        delivery_time: "30 min",
        asap_minutes_range: [25, 35]
      }
    ]
  });

  assert.equal(projected.schema, "doordash-cli");
  assert.equal(projected.version, 1);
  assert.equal(projected.kind, "store_search");
  assert.equal(projected.stores[0].store_id, "928163");
  assert.equal(
    projected.stores[0].image_url,
    "https://img.example/store.jpg"
  );
  assert.equal(
    projected.stores[0].location.address,
    "123 Main St"
  );
  assert.equal("latitude" in projected.stores[0].location, false);
  assert.equal("longitude" in projected.stores[0].location, false);
  assert.equal(projected.stores[0].distance, "1.25 mi");
  assert.equal(projected.stores[0].delivery_time, "25-35 min");
  assert.doesNotMatch(
    JSON.stringify(projected),
    /distance_meters|min_minutes|max_minutes|authoritative/
  );
});

test("pricing prefers the final total and classifies discounts once", () => {
  const projected = projectWithContract(contracts.receipt, {
    order_uuid: "order-1",
    items: [],
    final_total: { unit_amount: 1200 },
    total: { unit_amount: 1000 },
    line_items: [
      {
        charge_id: "DELIVERY_FEE_DISCOUNT",
        label: "Delivery fee discount",
        final_money: { unit_amount: 200 }
      }
    ]
  });

  assert.equal(projected.pricing.total, 12);
  assert.equal(projected.pricing.fees, undefined);
  assert.deepEqual(projected.pricing.discounts, [
    { label: "Delivery fee discount", amount: 2 }
  ]);
});

test("string and boolean aliases stay typed instead of becoming truthy junk", () => {
  const stores = projectWithContract(contracts.storeSearch, {
    stores: [
      {
        id: "store-1",
        name: { malformed: true },
        store_name: "Fallback Store"
      }
    ]
  });
  const addresses = projectWithContract(contracts.addresses, {
    addresses: [
      {
        id: "address-1",
        printable_address: "123 Main St",
        latitude: 37.8,
        longitude: -122.2,
        is_default: "false"
      }
    ]
  });

  assert.equal(stores.stores[0].name, "Fallback Store");
  assert.equal(addresses.addresses[0].is_default, false);
  assert.equal(addresses.addresses[0].latitude, 37.8);
  assert.equal(addresses.addresses[0].longitude, -122.2);
});

test("empty store and item detail payloads are schema errors", () => {
  assert.throws(
    () => projectWithContract(contracts.storeDetails, { success: true }),
    /did not contain a usable store/
  );
  assert.throws(
    () => projectWithContract(contracts.itemDetails, { success: true }),
    /did not contain a usable item/
  );
});

test("grocery truncation reports items and stores independently", () => {
  const projected = projectWithContract(contracts.groceryList, {
    items: Array.from({ length: 30 }, (_, index) => ({
      item_id: `item-${index + 1}`,
      name: `Item ${index + 1}`
    })),
    available_stores: Array.from({ length: 27 }, (_, index) => ({
      store_id: `store-${index + 1}`,
      name: `Store ${index + 1}`
    }))
  });

  assert.deepEqual(projected.items_truncation, {
    returned: 25,
    omitted: 5
  });
  assert.deepEqual(projected.available_stores_truncation, {
    returned: 25,
    omitted: 2
  });
});

test("submitted orders retain final nested status links", () => {
  const projected = projectWithContract(contracts.orderSubmit, {
    submitted: {
      order: {
        order_uuid: "order-1"
      }
    },
    preview: {
      quote: {
        total_before_tip: { unit_amount: 2500 },
        store_order_cart: {
          orders: [
            {
              order_items: [
                {
                  id: "line-1",
                  item: { id: "item-1", name: "Pizza" },
                  quantity: 1
                }
              ]
            }
          ]
        }
      }
    },
    finalStatus: {
      result: {
        status: "successful",
        tracking_url: "https://www.doordash.test/orders/order-1"
      }
    },
    orderUuid: "order-1",
    terminalStatus: "successful",
    tipCents: 500
  });

  assert.equal(projected.status, "successful");
  assert.equal(
    projected.tracking_url,
    "https://www.doordash.test/orders/order-1"
  );
  assert.equal(projected.pricing.total_before_tip, 25);
  assert.equal(projected.pricing.tip, 5);
  assert.equal(projected.pricing.total, 30);
});

test("menu truncation is metadata rather than a fake item", () => {
  const items = Array.from({ length: 251 }, (_, index) => ({
    item_id: index + 1,
    name: `Item ${index + 1}`,
    price: "$4.99"
  }));
  const projected = projectWithContract(contracts.menu, {
    store_id: "store-1",
    store_name: "Example Store",
    menu_id: "menu-1",
    items
  });

  assert.equal(projected.items.length, 250);
  assert.deepEqual(projected.truncation, {
    returned: 250,
    omitted: 1
  });
  assert.equal(
    projected.items.some((item) => "truncated" in item),
    false
  );
});

test("preview separates totals, floating-dollar tip suggestions, and quote ETA", () => {
  const projected = projectWithContract(contracts.orderPreview, {
    success: true,
    cart_uuid: "cart-1",
    quote: {
      id: "cart-1",
      total_before_tip: {
        unit_amount: 2501,
        display_string: "$25.01"
      },
      line_items: [
        {
          charge_id: "tax",
          label: "Tax",
          final_money: {
            unit_amount: 201,
            display_string: "$2.01"
          }
        }
      ],
      delivery_availability: {
        asap_minutes_range: [20, 30],
        asap_minutes_range_string: "20-30 min"
      },
      tips_suggestion_details: [
        {
          default_index: 0,
          percentage_values: [20],
          percentage_to_amount_monetary_values: [
            {
              unit_amount: 500,
              display_string: "$5.00"
            }
          ],
          tip_recipient: "DASHER"
        }
      ],
      store_order_cart: {
        is_consumer_pickup: false,
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
                  unit_amount: 2300,
                  display_string: "$23.00"
                }
              }
            ]
          }
        ]
      }
    }
  });

  assert.equal(projected.pricing.total_before_tip, 25.01);
  assert.equal(projected.pricing.total, undefined);
  assert.equal(projected.tip_suggestions[0].amount, 5);
  assert.equal(projected.delivery_time, "20-30 min");
  assert.equal(projected.items[0].cart_item_id, "line-1");
  assert.equal(projected.items[0].item_id, "item-1");
  assert.doesNotMatch(
    JSON.stringify(projected),
    /display_string|currency|min_minutes|max_minutes|authoritative/
  );
});

test("combined taxes-and-fees stays one pricing line", () => {
  const projected = projectWithContract(contracts.receipt, {
    order_uuid: "order-1",
    items: [],
    line_items: [
      {
        charge_id: "TAXES_AND_FEES",
        label: "Taxes and fees",
        final_money: { unit_amount: 325 }
      },
      {
        charge_id: "CREDITS",
        label: "Credits",
        final_money: { unit_amount: 200 }
      },
      {
        charge_id: "TIP",
        label: "Dasher tip",
        final_money: { unit_amount: 500 }
      }
    ]
  });

  assert.deepEqual(projected.pricing.fees, [
    { label: "Taxes and fees", amount: 3.25 }
  ]);
  assert.equal(projected.pricing.tax, undefined);
  assert.equal(projected.pricing.credits, 2);
  assert.equal(projected.pricing.tip, 5);
});

test("partial cart additions preserve successful items and required choices", () => {
  const projected = projectWithContract(contracts.cart, {
    success: false,
    cart_uuid: "cart-1",
    cart: {
      id: "cart-1",
      store_id: "store-1",
      store_name: "Example Store",
      created_at: 1762963200000,
      items: [
        {
          id: "line-1",
          item_id: "item-1",
          name: "Soup",
          quantity: 3
        }
      ]
    },
    item_errors: [
      {
        item_id: "item-2",
        item_name: "Combo",
        quantity: 1,
        error_message: "Choose a drink.",
        required_options: [
          {
            id: "drink",
            name: "Drink",
            min_num_options: 1,
            max_num_options: 1,
            options: [
              {
                id: "cola",
                name: "Cola"
              }
            ]
          }
        ]
      }
    ]
  });

  assert.equal(projected.items[0].cart_item_id, "line-1");
  assert.equal(projected.created_at, "2025-11-12T16:00:00.000Z");
  assert.equal(
    projected.item_errors[0].modifier_groups[0].options[0].option_id,
    "cola"
  );
  assert.doesNotMatch(
    JSON.stringify(projected.item_errors[0]),
    /required_options/
  );
});

test("upstream structural drift becomes a typed contract error", () => {
  assert.throws(
    () => projectWithContract(contracts.storeSearch, { success: true }),
    /invalid store-search response/
  );

  let error;
  try {
    projectWithContract(contracts.storeSearch, { success: true });
  } catch (caught) {
    error = caught;
  }
  const projected = errorEnvelope(contracts.storeSearch, error);
  assert.equal(projected.error.code, "UPSTREAM_SCHEMA_ERROR");
  assert.equal(projected.error.retryable, false);
  assert.equal("data" in projected, false);
  assert.equal("summary" in projected, false);
});

test("order statuses and restricted-item recovery remain actionable", () => {
  for (const status of [
    "pending",
    "successful",
    "action_required",
    "failed",
    "not_found"
  ]) {
    const projected = projectWithContract(contracts.orderStatus, {
      order_uuid: 12345,
      status,
      tracking_url: "https://www.doordash.test/orders/12345"
    });
    assert.equal(projected.order_uuid, "12345");
    assert.equal(projected.status, status);
    assert.equal(
      projected.tracking_url,
      "https://www.doordash.test/orders/12345"
    );
  }

  const error = new Error(
    "This order contains a restricted item and must be finished in the browser."
  );
  error.details = {
    data: {
      error_reason: "AGENTIC_RESTRICTED_ITEM_NOT_ALLOWED"
    }
  };
  const projected = errorEnvelope(contracts.orderSubmit, error);
  assert.equal(
    projected.error.code,
    "AGENTIC_RESTRICTED_ITEM_NOT_ALLOWED"
  );
  assert.equal(
    projected.error.recovery_tool,
    "doordash_create_checkout_link"
  );
});

test("payment projection omits internal payment identifiers", () => {
  const projected = projectWithContract(contracts.paymentMethods, {
    default_payment_method_id: "pm-default",
    cards: [
      {
        payment_method_id: "pm-default",
        provider_payment_method_id: "provider-secret",
        brand: "Visa",
        last4: "4242",
        exp_month: 12,
        exp_year: 2030
      }
    ]
  });

  assert.deepEqual(projected.cards[0], {
    brand: "Visa",
    last4: "4242",
    exp_month: 12,
    exp_year: 2030,
    is_default: true
  });
  assert.equal("default_card" in projected, false);
  assert.equal(JSON.stringify(projected).includes("pm-default"), false);
  assert.equal(JSON.stringify(projected).includes("provider-secret"), false);
});

test("activity redacts sensitive response keys, links, and command flags", () => {
  assert.deepEqual(
    redactForActivity({
      email: "person@example.com",
      delivery_address: {
        printable_address: "1 Main St",
        city: "Oakland"
      },
      cards: [{ last4: "4242", payment_method_id: "secret" }],
      checkout_url: "https://doordash.example/checkout-secret",
      tracking_url: "https://doordash.example/tracking-secret",
      group_cart_url: "https://doordash.example/group-secret",
      message:
        "Continue at https://doordash.example/private from 1 Main St, Oakland.",
      warnings: ["Tracking link: https://doordash.example/private"],
      note: "Open https://doordash.example/private"
    }),
    {
      email: "[redacted]",
      delivery_address: {
        printable_address: "[redacted]",
        city: "Oakland"
      },
      cards: [{ last4: "[redacted]", payment_method_id: "[redacted]" }],
      checkout_url: "[redacted]",
      tracking_url: "[redacted]",
      group_cart_url: "[redacted]",
      message: "[redacted]",
      warnings: ["[redacted]"],
      note: "Open [redacted-url]"
    }
  );

  assert.deepEqual(
    sanitizeCommandForActivity([
      "order",
      "submit",
      "--team-id",
      "secret-team",
      "--cart-uuid",
      "cart-1"
    ]),
    [
      "order",
      "submit",
      "--team-id",
      "[redacted]",
      "--cart-uuid",
      "cart-1"
    ]
  );
});
