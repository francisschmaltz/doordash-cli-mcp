import assert from "node:assert/strict";
import test from "node:test";

import {
  contractForCommand,
  contracts,
  errorEnvelope,
  money,
  projectWithContract,
  publicOutputSchemaForTool,
  toToolResult
} from "../src/response-contract.js";

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

test("receipt pricing distinguishes before-tip, tip, and exact total lines", () => {
  const projected = projectWithContract(contracts.receipt, {
    order_uuid: "order-1",
    items: [],
    line_items: [
      {
        charge_id: "TOTAL_BEFORE_TIP",
        label: "Total before tip",
        final_money: { unit_amount: 2000 }
      },
      {
        charge_id: "DASHER_TIP",
        label: "Dasher Tip",
        final_money: { unit_amount: 500 }
      },
      {
        charge_id: "TOTAL",
        label: "Total",
        final_money: { unit_amount: 2500 }
      }
    ]
  });

  assert.equal(projected.pricing.tip, 5);
  assert.equal(projected.pricing.total, 25);
});

test("receipt parses live orders[].order_items and binds the requested UUID", () => {
  const projected = projectWithContract(contracts.receipt, {
    success: true,
    mcp_order_uuid: "order-live",
    store_id: "25021439",
    store_name: "Chick-fil-A",
    line_items: [
      {
        charge_id: "TOTAL",
        label: "Total",
        final_money: { unit_amount: 1699 }
      }
    ],
    orders: [
      {
        id: "internal-order",
        order_items: [
          {
            id: "internal-line",
            quantity: 1,
            item: {
              id: "9459662774",
              name: "Spicy Chicken Sandwich Deluxe Meal",
              price_monetary_fields: { unit_amount: 1699 }
            },
            options: [
              {
                id: "31718037616",
                quantity: 1,
                item_extra_option: {
                  id: "31718037616",
                  name: "Spicy Deluxe w/ Pepper Jack Meal"
                }
              }
            ]
          }
        ]
      }
    ]
  });

  assert.equal(projected.order_uuid, "order-live");
  assert.equal(projected.store.store_id, "25021439");
  assert.equal(projected.items.length, 1);
  assert.equal(projected.items[0].item_id, "9459662774");
  assert.equal(projected.items[0].name, "Spicy Chicken Sandwich Deluxe Meal");
  assert.equal(projected.items[0].selected_options[0].option_id, "31718037616");
  assert.equal(
    projected.items[0].selected_options[0].option_name,
    "Spicy Deluxe w/ Pepper Jack Meal"
  );
  assert.equal(projected.pricing.total, 16.99);
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
    /did not contain the store_id needed for follow-up tools/
  );
  assert.throws(
    () => projectWithContract(contracts.itemDetails, { success: true }),
    /did not contain item_id and name/
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
  items[0].extras = [
    {
      title: "Details belong in get_item_details",
      options: [{ name: "Missing ID is irrelevant to menu discovery" }]
    }
  ];
  const projected = projectWithContract(contracts.menu, {
    store_id: "store-1",
    store_name: "Example Store",
    menu_id: "menu-1",
    items
  });

  assert.equal(projected.items.length, 50);
  assert.deepEqual(projected.truncation, {
    returned: 50,
    omitted: 201
  });
  assert.equal(
    projected.items.some((item) => "truncated" in item),
    false
  );
  assert.equal("modifier_groups" in projected.items[0], false);
  assert.match(
    projected.warnings.join(" "),
    /201 menu items were omitted.*query/
  );
});

test("menu categories reference only returned items and are capped", () => {
  const categories = Array.from({ length: 60 }, (_, categoryIndex) => ({
    id: `category-${categoryIndex + 1}`,
    name: `Category ${categoryIndex + 1}`,
    items: Array.from({ length: 6 }, (_, itemIndex) => ({
      item_id: `item-${categoryIndex * 6 + itemIndex + 1}`,
      name: `Item ${categoryIndex * 6 + itemIndex + 1}`
    }))
  }));
  const projected = projectWithContract(contracts.menu, {
    menu_id: "menu-categories",
    categories
  });

  assert.equal(projected.items.length, 50);
  assert.ok(projected.categories.length <= 50);
  const returnedIds = new Set(
    projected.items.map((item) => item.item_id)
  );
  assert.equal(
    projected.categories
      .flatMap((category) => category.item_ids)
      .every((itemId) => returnedIds.has(itemId)),
    true
  );
  assert.match(
    projected.warnings.join(" "),
    /10 menu categories were omitted/
  );
});

test("order history omits unusable orders and caps nested items", () => {
  const projected = projectWithContract(contracts.orderList, {
    orders: [
      {
        status: "successful",
        items: []
      },
      {
        order_uuid: "order-usable",
        status: "successful",
        items: Array.from({ length: 30 }, (_, index) => ({
          item_id: `item-${index + 1}`,
          name: `Item ${index + 1}`
        }))
      }
    ]
  });

  assert.equal(projected.orders.length, 1);
  assert.equal(projected.orders[0].order_uuid, "order-usable");
  assert.equal(projected.orders[0].items.length, 10);
  assert.deepEqual(projected.orders[0].items_truncation, {
    returned: 10,
    omitted: 20
  });
  assert.match(
    projected.warnings.join(" "),
    /Orders without order_uuid were omitted/
  );
  assert.match(
    projected.warnings.join(" "),
    /20 order-history items were omitted/
  );
});

test("restaurant history item IDs are canonicalized from order_target", () => {
  const projected = projectWithContract(contracts.orderList, {
    orders: [
      {
        order_uuid: "restaurant-order",
        order_target: { type: "RESTAURANT" },
        store: { store_id: "store-1", name: "Chick-fil-A" },
        items: [
          {
            item_id: 9459662774,
            name: "Spicy Chicken Sandwich Deluxe Meal"
          }
        ]
      },
      {
        order_uuid: "retail-order",
        order_target: "RETAIL",
        store: { store_id: "store-2", name: "Corner Market" },
        items: [{ item_id: 9459662774, name: "Retail Item" }]
      }
    ]
  });

  assert.equal(projected.orders[0].items[0].item_id, "i_9459662774");
  assert.equal(projected.orders[1].items[0].item_id, "9459662774");
});

test("menu_id survives store, item, cart, and reorder projections", () => {
  const store = projectWithContract(contracts.storeDetails, {
    store: { store_id: "store-1", name: "Example" },
    menu_id: "menu-store"
  });
  const item = projectWithContract(contracts.itemDetails, {
    store: { store_id: "store-1", name: "Example" },
    menu_id: "menu-item",
    item: { item_id: "i_item-1", name: "Combo" }
  });
  const cartPayload = {
    success: true,
    cart_uuid: "cart-1",
    cart: {
      id: "cart-1",
      items: [
        {
          id: "line-1",
          item_id: "i_item-1",
          menu_id: "menu-cart",
          name: "Combo"
        },
        {
          id: "line-2",
          item_id: "i_item-2",
          menu_id: "menu-cart",
          name: "Shake"
        }
      ]
    }
  };
  const cart = projectWithContract(contracts.cart, cartPayload);
  const reorder = projectWithContract(contracts.reorder, cartPayload);

  assert.equal(store.store.menu_id, "menu-store");
  assert.equal(item.store.menu_id, "menu-item");
  assert.equal(item.item.menu_id, "menu-item");
  for (const projected of [cart, reorder]) {
    assert.equal(projected.menu_id, "menu-cart");
    assert.deepEqual(
      projected.items.map((entry) => entry.menu_id),
      ["menu-cart", "menu-cart"]
    );
  }
});

test("cart-level menu_id is not guessed when line menu IDs conflict", () => {
  const projected = projectWithContract(contracts.cart, {
    cart_uuid: "cart-1",
    items: [
      {
        id: "line-1",
        item_id: "item-1",
        menu_id: "menu-1",
        name: "One"
      },
      {
        id: "line-2",
        item_id: "item-2",
        menu_id: "menu-2",
        name: "Two"
      }
    ]
  });

  assert.equal(projected.menu_id, undefined);
  assert.deepEqual(
    projected.items.map((entry) => entry.menu_id),
    ["menu-1", "menu-2"]
  );
});

test("modifier choices without option_id fail closed", () => {
  assert.throws(
    () =>
      projectWithContract(contracts.itemDetails, {
        menu_id: "menu-1",
        item: {
          item_id: "item-1",
          name: "Combo",
          extras: [
            {
              extra_id: "size",
              title: "Size",
              min_num_options: 1,
              options: [
                {
                  name: "Mystery size"
                },
                {
                  option_id: "large",
                  name: "Large"
                }
              ]
            }
          ]
        }
      }),
    /omitted an option_id/
  );
});

test("oversized modifier trees return root choices and matching paths", () => {
  const nestedGroups = Array.from({ length: 820 }, (_, groupIndex) => ({
    extra_id: `group-${groupIndex + 1}`,
    title: `Choice ${groupIndex + 1}`,
    options: Array.from(
      { length: groupIndex === 0 ? 22 : 3 },
      (_, optionIndex) => ({
        option_id: `option-${groupIndex + 1}-${optionIndex + 1}`,
        name:
          groupIndex === 819 && optionIndex === 2
            ? "Garden Herb Ranch Dressing"
            : `Option ${groupIndex + 1}.${optionIndex + 1}`
      })
    )
  }));
  const projected = projectWithContract(contracts.itemDetails, {
    menu_id: "menu-1",
    mcp_option_queries: ["Ranch"],
    item: {
      item_id: "i_item-1",
      name: "Combo",
      extras: [
        {
          extra_id: "meal-root",
          title: "Choose a Meal",
          options: [
            {
              option_id: "meal-option",
              name: "Meal",
              extras: nestedGroups
            }
          ]
        }
      ]
    }
  });

  const rootOption = projected.item.modifier_groups[0].options[0];
  assert.equal(rootOption.name, "Meal");
  assert.equal(rootOption.modifier_groups.length, 1);
  assert.equal(rootOption.modifier_groups[0].name, "Choice 820");
  assert.deepEqual(
    rootOption.modifier_groups[0].options.map((option) => option.name),
    ["Garden Herb Ranch Dressing"]
  );
  assert.match(
    projected.warnings.join(" "),
    /omitted 819 modifier groups and 2478 options.*paths matching "ranch"/
  );
});

test("modifier query results preserve ambiguous choices under distinct paths", () => {
  const projected = projectWithContract(contracts.itemDetails, {
    menu_id: "menu-1",
    mcp_option_queries: ["Ranch"],
    item: {
      item_id: "i_combo",
      name: "Combo",
      extras: [
        {
          extra_id: "root",
          title: "Choose a side",
          options: [
            {
              option_id: "sauces",
              name: "Sauces",
              extras: [
                {
                  extra_id: "sauce-choice",
                  title: "Sauce",
                  options: [
                    { option_id: "ranch-sauce", name: "Ranch Sauce" }
                  ]
                }
              ]
            },
            {
              option_id: "dressings",
              name: "Dressings",
              extras: [
                {
                  extra_id: "dressing-choice",
                  title: "Dressing",
                  options: [
                    {
                      option_id: "ranch-dressing",
                      name: "Garden Herb Ranch Dressing"
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  });

  const paths = projected.item.modifier_groups[0].options.map((option) => ({
    branch: option.name,
    choice: option.modifier_groups[0].options[0].name
  }));
  assert.deepEqual(paths, [
    { branch: "Sauces", choice: "Ranch Sauce" },
    { branch: "Dressings", choice: "Garden Herb Ranch Dressing" }
  ]);
});

test("modifier queries normalize ampersands and punctuation", () => {
  const projected = projectWithContract(contracts.itemDetails, {
    menu_id: "menu-1",
    mcp_option_queries: ["Cookies and Cream"],
    item: {
      item_id: "i_combo",
      name: "Combo",
      extras: Array.from({ length: 26 }, (_, index) => ({
        extra_id: `drink-${index}`,
        title: `Drink ${index}`,
        options: [
          {
            option_id: `option-${index}`,
            name:
              index === 25
                ? "Cookies & Cream Milk Shake"
                : `Drink Option ${index}`
          }
        ]
      }))
    }
  });

  assert.equal(
    projected.item.modifier_groups[0].options[0].name,
    "Cookies & Cream Milk Shake"
  );
});

test("preview separates totals, floating-dollar tip suggestions, and quote ETA", () => {
  const projected = projectWithContract(contracts.orderPreview, {
    success: true,
    cart_uuid: "cart-1",
    mcp_preview_token: "preview-token",
    mcp_preview_options: {
      fulfillment: "delivery",
      priority: false,
      apply_credits: true
    },
    quote: {
      id: "cart-1",
      delivery_address: {
        printable_address: "123 Main St, Oakland, CA 94611"
      },
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
  assert.deepEqual(projected.submit_context, {
    cart_uuid: "cart-1",
    preview_token: "preview-token",
    expected_total_before_tip: 25.01,
    expected_delivery_address: "123 Main St, Oakland, CA 94611",
    fulfillment: "delivery",
    priority: false,
    apply_credits: true,
    pin_handoff_required: false
  });
  assert.doesNotMatch(
    JSON.stringify(projected),
    /display_string|currency|min_minutes|max_minutes|authoritative/
  );
});

test("pickup preview uses a null delivery address in submit_context", () => {
  const projected = projectWithContract(contracts.orderPreview, {
    success: true,
    cart_uuid: "cart-pickup",
    mcp_preview_token: "preview-token",
    mcp_preview_options: {
      fulfillment: "pickup",
      priority: false,
      apply_credits: true
    },
    quote: {
      total_before_tip: {
        unit_amount: 1800
      },
      store_order_cart: {
        is_consumer_pickup: true,
        orders: [
          {
            order_items: [
              {
                id: "line-1",
                quantity: 1,
                item: {
                  id: "item-1",
                  name: "Ramen"
                }
              }
            ]
          }
        ]
      }
    }
  });

  assert.equal(projected.submit_context.fulfillment, "pickup");
  assert.equal(projected.submit_context.expected_delivery_address, null);
});

test("oversized previews require browser checkout instead of partial confirmation", () => {
  let error;
  try {
    projectWithContract(contracts.orderPreview, {
      success: true,
      cart_uuid: "cart-oversized",
      quote: {
        store_order_cart: {
          orders: [
            {
              order_items: Array.from({ length: 101 }, (_, index) => ({
                id: `line-${index + 1}`,
                quantity: 1,
                item: {
                  id: `item-${index + 1}`,
                  name: `Item ${index + 1}`
                }
              }))
            }
          ]
        }
      }
    });
  } catch (caught) {
    error = caught;
  }

  assert.equal(error?.code, "PREVIEW_TOO_LARGE");
  const projected = errorEnvelope(contracts.orderPreview, error);
  assert.equal(projected.error.code, "PREVIEW_TOO_LARGE");
  assert.equal(projected.error.recovery_tool, "create_checkout_link");
  assert.deepEqual(projected.error.recovery_arguments, {
    cart_uuid: "cart-oversized"
  });
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
        request: {
          item_id: "item-2",
          item_name: "Combo",
          quantity: 1
        },
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
  assert.deepEqual(projected.item_errors[0].item, {
    item_id: "item-2",
    name: "Combo",
    quantity: 1
  });
  assert.equal(
    projected.item_errors[0].modifier_groups[0].options[0].option_id,
    "cola"
  );
  assert.doesNotMatch(
    JSON.stringify(projected.item_errors[0]),
    /required_options/
  );
  const summary = toToolResult(projected).content[0].text;
  assert.match(summary, /Partial cart update: 1 cart line added and 1 line failed/);
  assert.match(summary, /Never resend an added line or the full original batch/);
  assert.match(
    summary,
    /add only the failed lines using that same cart_uuid/
  );
  assert.doesNotMatch(summary, /No cart changes were made/);
  assert.doesNotMatch(summary, /retrying add_cart_items once/);
});

test("cart modifier ambiguities preserve bounded deep candidate paths", () => {
  let modifierGroups = [];
  for (let depth = 9; depth >= 0; depth -= 1) {
    modifierGroups = [
      {
        group_id: `group-${depth}`,
        name: `Choice ${depth}`,
        min_selections: 0,
        max_selections: 1,
        options: [
          {
            option_id: `option-${depth}`,
            name: `Option ${depth}`,
            ...(modifierGroups.length
              ? { modifier_groups: modifierGroups }
              : {})
          }
        ]
      }
    ];
  }

  const projected = projectWithContract(contracts.cart, {
    cart_uuid: "cart-deep-path",
    items: [],
    item_errors: [
      {
        request: {
          item_id: "meal-1",
          item_name: "Meal"
        },
        message: "Choose one matching path.",
        modifier_groups: modifierGroups
      }
    ]
  });

  let current = projected.item_errors[0].modifier_groups;
  for (let depth = 0; depth < 10; depth += 1) {
    assert.equal(current[0].group_id, `group-${depth}`);
    current = current[0].options[0].modifier_groups || [];
  }
});

test("cart errors collapse to one actionable result per requested line", () => {
  const projected = projectWithContract(contracts.cart, {
    cart_uuid: "cart-1",
    cart: {
      id: "cart-1",
      items: []
    },
    mcp_requested_items: [
      {
        item_id: "item-1",
        name: "Combo",
        quantity: 1
      }
    ],
    item_errors: [
      {
        request: {
          item_id: "item-1",
          item_name: "Combo",
          quantity: 1
        },
        error_message: "Choose a drink."
      },
      {
        request: {
          item_id: "item-1",
          item_name: "Combo",
          quantity: 1
        },
        error_message: "Choose a side."
      },
      {
        request: {
          item_id: "item-1",
          item_name: "Combo",
          quantity: 1
        },
        error_message: "Choose a drink."
      }
    ]
  });

  assert.equal(projected.item_errors.length, 1);
  assert.match(projected.item_errors[0].message, /Choose a drink/);
  assert.match(projected.item_errors[0].message, /Choose a side/);
  assert.match(projected.warnings[0], /2 duplicate or excess/);
  assert.match(
    toToolResult(projected).content[0].text,
    /Fix all 1 item issue/
  );
});

test("failed extensions do not count existing cart lines as newly added", () => {
  const projected = projectWithContract(contracts.cart, {
    cart_uuid: "cart-1",
    cart: {
      id: "cart-1",
      items: [
        {
          id: "existing-line",
          item_id: "existing-item",
          name: "Existing Item",
          quantity: 1
        }
      ]
    },
    mcp_requested_items: [
      {
        request_index: 0,
        item_id: "new-item",
        name: "New Item",
        quantity: 1
      }
    ],
    item_errors: [
      {
        request_index: 0,
        request: {
          item_id: "new-item",
          item_name: "New Item",
          quantity: 1
        },
        error_message: "Unavailable."
      }
    ]
  });

  assert.equal(projected.added_line_count, 0);
  const summary = toToolResult(projected).content[0].text;
  assert.match(summary, /No cart changes were made/);
  assert.doesNotMatch(summary, /Partial cart update/);
});

test("cart projections preserve the checkout URL", () => {
  const projected = projectWithContract(contracts.cart, {
    success: true,
    cart_uuid: "cart-1",
    checkout_url: "https://www.doordash.test/checkout/cart-1",
    cart: {
      id: "cart-1",
      items: [
        {
          id: "line-1",
          item_id: "item-1",
          name: "Item",
          quantity: 1,
          nested_options: [
            {
              id: "option-1",
              quantity: 1,
              item_extra_option: {
                id: "option-1",
                name: "Chicken"
              }
            }
          ]
        }
      ]
    }
  });

  assert.equal(
    projected.checkout_url,
    "https://www.doordash.test/checkout/cart-1"
  );
  assert.deepEqual(projected.items[0].selected_options, [
    {
      option_id: "option-1",
      option_name: "Chicken",
      quantity: 1
    }
  ]);
});

test("show and add cart projections cap lines with explicit truncation", () => {
  const cartItems = Array.from({ length: 125 }, (_, index) => ({
    id: `line-${index + 1}`,
    item_id: `item-${index + 1}`,
    name: `Item ${index + 1}`,
    quantity: 1
  }));
  const projections = [
    projectWithContract(contracts.cart, {
      cart_uuid: "cart-show",
      items: cartItems
    }),
    projectWithContract(contracts.cart, {
      cart_uuid: "cart-add",
      cart: {
        id: "cart-add",
        items: cartItems
      }
    })
  ];

  for (const projected of projections) {
    assert.equal(projected.items.length, 100);
    assert.deepEqual(projected.items_truncation, {
      returned: 100,
      omitted: 25
    });
    assert.equal(projected.items[99].cart_item_id, "line-100");
  }
});

test("cart lists cap carts and lines with an actionable detail warning", () => {
  const projected = projectWithContract(contracts.cartList, {
    carts: Array.from({ length: 30 }, (_, cartIndex) => ({
      cart_uuid: `cart-${cartIndex + 1}`,
      items: Array.from({ length: 12 }, (_, itemIndex) => ({
        id: `line-${cartIndex + 1}-${itemIndex + 1}`,
        item_id: `item-${itemIndex + 1}`,
        name: `Item ${itemIndex + 1}`,
        quantity: 1
      }))
    }))
  });

  assert.equal(projected.carts.length, 25);
  assert.deepEqual(projected.truncation, {
    returned: 25,
    omitted: 5
  });
  for (const cart of projected.carts) {
    assert.equal(cart.items.length, 10);
    assert.deepEqual(cart.items_truncation, {
      returned: 10,
      omitted: 2
    });
  }
  assert.match(
    projected.warnings.join(" "),
    /50 cart lines were omitted from list_carts\. Call show_cart for one cart's details\./
  );
});

test("cart lists never imply omitted item contents mean empty", () => {
  const projected = projectWithContract(contracts.cartList, {
    carts: [{ cart_uuid: "cart-summary", store_id: "store-1" }]
  });

  assert.deepEqual(projected.carts[0].items, []);
  assert.match(
    projected.warnings.join(" "),
    /summary omitted item contents.*show_cart.*treating.*empty/
  );
});

test("cart lines without cart_item_id warn against substituting item_id", () => {
  const projected = projectWithContract(contracts.cart, {
    cart_uuid: "cart-missing-line-id",
    items: [
      {
        item_id: "menu-item-1",
        name: "Ramen",
        quantity: 1
      }
    ]
  });

  assert.equal(projected.items[0].cart_item_id, undefined);
  assert.match(
    projected.warnings.join(" "),
    /missing cart_item_id.*Do not substitute item_id/
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
      structuredContent: {
        error: {
          code: "AGENTIC_RESTRICTED_ITEM_NOT_ALLOWED",
          cart_uuid: "cart-123"
        }
      }
    }
  };
  const projected = errorEnvelope(contracts.orderSubmit, error);
  assert.equal(
    projected.error.code,
    "AGENTIC_RESTRICTED_ITEM_NOT_ALLOWED"
  );
  assert.equal(
    projected.error.recovery_tool,
    "create_checkout_link"
  );
  assert.deepEqual(projected.error.recovery_arguments, {
    cart_uuid: "cart-123"
  });
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
