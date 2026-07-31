# MCP response contract

Every public tool advertises a success/error `outputSchema` union. Results use
a compact, versioned object:

- `content[0].text` is readable prose.
- `content[1].text` is minified JSON exactly equal to
  `JSON.stringify(structuredContent)`.
- `structuredContent` is the machine contract.
- On a typed error, `isError` is `true` and `structuredContent.error` contains
  `code`, `message`, `retryable: false`, and optional concrete recovery fields.

The advertised schemas are shallow on purpose: they expose the fields needed
for chaining tools without copying the full response grammar into every tool
definition. The server still validates each result against its strict internal
contract before returning it.

Open WebUI caches these schemas. Disconnect and reconnect the MCP integration
after deploying a contract change, then start a new chat.

Cart preflight failures are success-shaped `cart` payloads with `items: []`,
complete `item_errors`, and `isError: true`; no write occurred. Partial
DoorDash additions are different: successful lines remain in `items`, failed
lines appear in `item_errors`, and the successful lines must not be retried.

Checkout-state changes are serialized. If a write or mode-changing preview
loses its upstream result, its typed error supplies one inspection action
instead of inviting a retry.

Every structured result starts with:

```json
{
  "schema": "doordash-cli",
  "version": 1,
  "kind": "store_search"
}
```

The wire contract has one value per fact:

- Money is a floating-point dollar number rounded to two decimals. JSON does
  not preserve insignificant zeroes, so four dollars is `4`, not `4.00`.
- Delivery timing is one `delivery_time` string. A source range such as
  `"25-35 min"` stays a range; there are no duplicate minimum and maximum
  fields.
- Distance is one display string in miles. An upstream mile value wins over
  converting meters.
- Optional fields that DoorDash did not provide are omitted.
- Checkout, tracking, and group-cart URLs appear only when DoorDash returned
  them.
- IDs are strings, timestamps are ISO 8601, and image URLs stay URLs.
- Restaurant stores, items, and cart lines retain authoritative `menu_id`
  values when DoorDash supplies them. A cart also exposes top-level `menu_id`
  when every line agrees.
- Public tool inputs use strict snake_case fields. Older aliases are accepted
  only for runtime compatibility and are not advertised by `tools/list`.

## Tool-to-kind map

| Tool | `kind` |
| --- | --- |
| `list_addresses` | `address_list` |
| `set_default_address` | `address_update` |
| `build_grocery_list` | `grocery_list` |
| `find_items` | `item_search` |
| `find_nearby_stores` | `store_search` |
| `get_item_details` | `item_details` |
| `get_menu` | `menu` |
| `search_restaurants` | `store_search` |
| `get_store_details` | `store_details` |
| `add_cart_items` | `cart` |
| `delete_cart` | `cart_mutation` |
| `list_carts` | `cart_list` |
| `remove_cart_item` | `cart` |
| `show_cart` | `cart` |
| `create_checkout_link` | `checkout_link` |
| `list_orders` | `order_list` |
| `preview_order` | `order_preview` |
| `get_receipt` | `receipt` |
| `reorder` | `reorder` |
| `order_status` | `order_status` |
| `list_promos` | `promotion_list` |
| `apply_promo` | `promotion_mutation` |
| `remove_promo` | `promotion_mutation` |
| `list_payment_methods` | `payment_methods` |
| `order_submit` | `order_submit` |

## Kind payloads

| `kind` | Payload after `schema`, `version`, and `kind` |
| --- | --- |
| `address_list` | `addresses` |
| `address_update` | Required `address_id` and optional `message` |
| `grocery_list` | Store, resolved `items`, optional alternatives and address |
| `item_search` | Search groups containing `query` and `items` |
| `store_search` | `stores` and optional `truncation` |
| `store_details` | `store` |
| `menu` | Store, `menu_id`, `items`, optional categories and truncation |
| `item_details` | `item` and optional store and `menu_id` |
| `cart` | Cart ID, store, items, optional line truncation, fulfillment, checkout link, and optional item errors |
| `cart_list` | `carts` and optional `truncation` |
| `cart_mutation` | Required `cart_uuid` and optional `message` |
| `checkout_link` | Cart ID and upstream `checkout_url` |
| `order_list` | Orders, per-order item truncation, and optional top-level truncation |
| `order_preview` | Current quote, pricing, ETA, optional tip/work data, and required `submit_context` |
| `receipt` | Final order and pricing |
| `reorder` | Hydrated new cart and any item, quantity, or modifier differences from the source order |
| `order_status` | Current order status and any upstream tracking URL |
| `promotion_list` | `promotions` |
| `promotion_mutation` | Required `cart_uuid` and `promo_code`; optional `message` |
| `payment_methods` | Masked `cards` |
| `order_submit` | Confirmed items, pricing, tip, ETA, status, and upstream links |

## Store search

```json
{
  "content": [
    {
      "type": "text",
      "text": "Found 1 DoorDash store."
    },
    {
      "type": "text",
      "text": "{\"schema\":\"doordash-cli\",\"version\":1,\"kind\":\"store_search\",\"stores\":[{\"store_id\":\"928163\",\"name\":\"Example Pizza\",\"image_url\":\"https://images.example.test/stores/928163.jpg\",\"vertical\":\"restaurant\",\"location\":{\"address\":\"123 Main St, Oakland, CA 94611\"},\"distance\":\"1 mi\",\"fulfillment\":[\"delivery\",\"pickup\"],\"delivery_time\":\"25-35 min\"}]}"
    }
  ],
  "structuredContent": {
    "schema": "doordash-cli",
    "version": 1,
    "kind": "store_search",
    "stores": [
      {
        "store_id": "928163",
        "name": "Example Pizza",
        "image_url": "https://images.example.test/stores/928163.jpg",
        "vertical": "restaurant",
        "location": {
          "address": "123 Main St, Oakland, CA 94611"
        },
        "distance": "1 mi",
        "fulfillment": [
          "delivery",
          "pickup"
        ],
        "delivery_time": "25-35 min"
      }
    ]
  }
}
```

## Menu and focused modifier lookup

`find_items` searches grocery and retail catalogs only. A known restaurant
`store_id` is rejected before any retail catalog call and directs the caller to
`get_menu`; never retry `find_items` for that store.

Use a canonical input such as
`{"store_id":"928163","query":"Margherita Pizza"}`. The optional `query`
filters the returned menu; it does not change DoorDash. `get_menu` takes
`store_id`; when reorder or a cart already supplied an authoritative
`menu_id`, pass it too so fallback output preserves that context. The response
supplies the effective menu context for the next call. If the full-menu endpoint
fails, a dish-name query can recover only the same normalized historical dish
name and verify it through current item details. It checks at most five matches
from bounded recent history and is not exhaustive; related spicy, deluxe, or
grilled items are not substitutes.
If no current exact-name history match exists, the call fails closed with
`RESTAURANT_CATALOG_UNAVAILABLE`; do not broaden the history match, call
`find_items`, or substitute another dish. Continue in the DoorDash app or
website. Recovery also fails closed when the returned items do not share one
authoritative `menu_id`. An unfiltered fallback returns at most five verified
recent items and warns that the result is not a complete menu.
If the user already named exact options, `add_cart_items` can resolve them.
Use `get_item_details` to inspect unknown or nested choices.

```json
{
  "content": [
    {
      "type": "text",
      "text": "Loaded 1 menu item from Example Pizza."
    },
    {
      "type": "text",
      "text": "{\"schema\":\"doordash-cli\",\"version\":1,\"kind\":\"menu\",\"store\":{\"store_id\":\"928163\",\"menu_id\":\"1657275\",\"name\":\"Example Pizza\"},\"menu_id\":\"1657275\",\"items\":[{\"item_id\":\"i_23266866023\",\"menu_id\":\"1657275\",\"name\":\"Margherita Pizza\",\"description\":\"Tomato, mozzarella, and basil\",\"image_url\":\"https://images.example.test/items/pizza.jpg\",\"price\":18.99,\"available\":true}],\"categories\":[{\"category_id\":\"pizza\",\"name\":\"Pizza\",\"item_ids\":[\"i_23266866023\"]}]}"
    }
  ],
  "structuredContent": {
    "schema": "doordash-cli",
    "version": 1,
    "kind": "menu",
    "store": {
      "store_id": "928163",
      "menu_id": "1657275",
      "name": "Example Pizza"
    },
    "menu_id": "1657275",
    "items": [
      {
        "item_id": "i_23266866023",
        "menu_id": "1657275",
        "name": "Margherita Pizza",
        "description": "Tomato, mozzarella, and basil",
        "image_url": "https://images.example.test/items/pizza.jpg",
        "price": 18.99,
        "available": true
      }
    ],
    "categories": [
      {
        "category_id": "pizza",
        "name": "Pizza",
        "item_ids": [
          "i_23266866023"
        ]
      }
    ]
  }
}
```

For an `i_` restaurant item ID copied from order history, `menu_id` may be
omitted; the server may use `store_id` only as the endpoint's internal lookup
context. If DoorDash supplies no separate menu ID, the public response omits
`menu_id` and cannot be handed to a cart call until an authoritative one is
available. On a large modifier tree,
`option_queries` returns root choices plus bounded paths matching those names
instead of the entire tree:

```json
{
  "store_id": "928163",
  "menu_id": "1657275",
  "item_id": "9459662774",
  "option_queries": [
    "Ranch"
  ]
}
```

Every cart line must copy the exact `item_id` and `name`. Put customization in
`requested_options` or exact `nested_options`, never in `name`:

```json
{
  "store_id": "928163",
  "menu_id": "1657275",
  "items": [
    {
      "item_id": "i_23266866023",
      "name": "Margherita Pizza",
      "quantity": 1,
      "requested_options": [
        {
          "name": "Large"
        },
        {
          "name": "Ranch",
          "quantity": 2,
          "option_id": "o_ranch_sauce"
        }
      ]
    }
  ]
}
```

## Cart preflight failure

Preflight runs before the additive cart write. `items: []`, `item_errors`, and
`isError: true` mean no cart change occurred. Resolve every line from choices
the user already supplied, or ask the user. Then retry the complete batch once;
never repeat unchanged input and never guess.

An unavailable item says not to retry. Malformed trees or selectable options
without IDs fail closed before a cart write. Large trees are resolved
internally; public errors return only relevant choices or ambiguity candidates.
Call `get_item_details` with focused `option_queries` for any remaining item.

If `{"name":"Ranch"}` matches both a sauce and a dressing branch, the error
returns both candidates. Ask the user which one they mean, then preserve the
requested count with
`{"name":"Ranch","quantity":2,"option_id":"o_ranch_sauce"}`. Do not guess.
Modifier quantities are capped at 100. If DoorDash reuses one `option_id`
across sibling groups, use the exact qualified name returned by the error,
such as `Sauce Ranch`, with that `option_id`.

```json
{
  "content": [
    {
      "type": "text",
      "text": "No cart changes were made. Fix all 1 item issue before retrying add_cart_items once; never repeat unchanged input. Use only choices the user already requested; otherwise ask. Do not guess. 1) request line 1 (Spicy TanTan): Select at least 1 option for Utensils. Available choices: Utensils (required; choose exactly 1): Utensils : Yes [o_yes], Utensils : No [o_no]."
    },
    {
      "type": "text",
      "text": "{\"schema\":\"doordash-cli\",\"version\":1,\"kind\":\"cart\",\"items\":[],\"item_errors\":[{\"request_index\":0,\"item\":{\"item_id\":\"i_12901175286\",\"name\":\"Spicy TanTan\",\"quantity\":1},\"message\":\"Select at least 1 option for Utensils.\",\"modifier_groups\":[{\"group_id\":\"e_utensils\",\"name\":\"Utensils\",\"min_selections\":1,\"max_selections\":1,\"options\":[{\"option_id\":\"o_yes\",\"name\":\"Utensils : Yes\"},{\"option_id\":\"o_no\",\"name\":\"Utensils : No\"}]}]}]}"
    }
  ],
  "structuredContent": {
    "schema": "doordash-cli",
    "version": 1,
    "kind": "cart",
    "items": [],
    "item_errors": [
      {
        "request_index": 0,
        "item": {
          "item_id": "i_12901175286",
          "name": "Spicy TanTan",
          "quantity": 1
        },
        "message": "Select at least 1 option for Utensils.",
        "modifier_groups": [
          {
            "group_id": "e_utensils",
            "name": "Utensils",
            "min_selections": 1,
            "max_selections": 1,
            "options": [
              {
                "option_id": "o_yes",
                "name": "Utensils : Yes"
              },
              {
                "option_id": "o_no",
                "name": "Utensils : No"
              }
            ]
          }
        ]
      }
    ]
  },
  "isError": true
}
```

## Partial cart addition

DoorDash can still report a partial result after the write. Successful lines
stay in `items`; failed lines appear in `item_errors`. First call `show_cart`,
then add only the failed lines using the same `cart_uuid`. Resending a
successful line or the original batch duplicates it.

```json
{
  "content": [
    {
      "type": "text",
      "text": "Partial cart update: 1 cart line added and 1 line failed. Never resend an added line or the full original batch. First call show_cart with {\"cart_uuid\":\"cart-123\"}. Then add only the failed lines using that same cart_uuid. 1) request line 2 (Pizza Combo): Choose a size. Available choices: Size (required; choose exactly 1): Small [small], Large [large]."
    },
    {
      "type": "text",
      "text": "{\"schema\":\"doordash-cli\",\"version\":1,\"kind\":\"cart\",\"cart_uuid\":\"cart-123\",\"store\":{\"store_id\":\"928163\",\"name\":\"Example Pizza\"},\"items\":[{\"item_id\":\"i_23266866023\",\"cart_item_id\":\"line-1\",\"name\":\"Margherita Pizza\",\"quantity\":1,\"price\":18.99}],\"fulfillment\":\"delivery\",\"group_cart_url\":\"https://www.doordash.com/group-orders/cart-123\",\"item_errors\":[{\"request_index\":1,\"item\":{\"item_id\":\"combo-1\",\"name\":\"Pizza Combo\",\"quantity\":1},\"message\":\"Choose a size.\",\"modifier_groups\":[{\"group_id\":\"size\",\"name\":\"Size\",\"min_selections\":1,\"max_selections\":1,\"options\":[{\"option_id\":\"small\",\"name\":\"Small\",\"price\":0},{\"option_id\":\"large\",\"name\":\"Large\",\"price\":1.5}]}]}],\"checkout_url\":\"https://www.doordash.com/checkout/cart-123\"}"
    }
  ],
  "structuredContent": {
    "schema": "doordash-cli",
    "version": 1,
    "kind": "cart",
    "cart_uuid": "cart-123",
    "store": {
      "store_id": "928163",
      "name": "Example Pizza"
    },
    "items": [
      {
        "item_id": "i_23266866023",
        "cart_item_id": "line-1",
        "name": "Margherita Pizza",
        "quantity": 1,
        "price": 18.99
      }
    ],
    "fulfillment": "delivery",
    "group_cart_url": "https://www.doordash.com/group-orders/cart-123",
    "item_errors": [
      {
        "request_index": 1,
        "item": {
          "item_id": "combo-1",
          "name": "Pizza Combo",
          "quantity": 1
        },
        "message": "Choose a size.",
        "modifier_groups": [
          {
            "group_id": "size",
            "name": "Size",
            "min_selections": 1,
            "max_selections": 1,
            "options": [
              {
                "option_id": "small",
                "name": "Small",
                "price": 0
              },
              {
                "option_id": "large",
                "name": "Large",
                "price": 1.5
              }
            ]
          }
        ]
      }
    ],
    "checkout_url": "https://www.doordash.com/checkout/cart-123"
  }
}
```

## Ambiguous repeated variants

If repeated lines share an `item_id` and DoorDash omits the failed modifier
variant, the error is deliberately not assigned by guesswork. `ambiguous: true`
lists every possible request line and its selections:

```json
{
  "ambiguous": true,
  "candidates": [
    {
      "request_index": 0,
      "item": {
        "item_id": "i_12901175286",
        "name": "Spicy TanTan",
        "selected_options": [
          {
            "option_id": "o_utensils_yes",
            "option_name": "Utensils : Yes"
          }
        ]
      }
    },
    {
      "request_index": 1,
      "item": {
        "item_id": "i_12901175286",
        "name": "Spicy TanTan",
        "selected_options": [
          {
            "option_id": "o_utensils_yes",
            "option_name": "Utensils : Yes"
          },
          {
            "option_id": "o_sweet_corn",
            "option_name": "Sweet Corn"
          }
        ]
      }
    }
  ]
}
```

Call `show_cart`, compare these candidates with the actual cart, and add only a
variant proven missing. Never resend the original batch.

## Safe cart-line removal

For a replacement, add and verify the new line first. Then pass the old line's
`cart_item_id` plus the new line's `cart_item_id` as
`replacement_cart_item_id`:

```json
{
  "cart_uuid": "cart-123",
  "cart_item_id": "line-old",
  "replacement_cart_item_id": "line-new"
}
```

The server verifies both lines before the removal and hydrates the cart again
afterward. Success returns the remaining `cart`, not a `cart_mutation` receipt:

```json
{
  "content": [
    {
      "type": "text",
      "text": "1 cart line at Example Pizza."
    },
    {
      "type": "text",
      "text": "{\"schema\":\"doordash-cli\",\"version\":1,\"kind\":\"cart\",\"cart_uuid\":\"cart-123\",\"menu_id\":\"1657275\",\"store\":{\"store_id\":\"928163\",\"menu_id\":\"1657275\",\"name\":\"Example Pizza\"},\"items\":[{\"item_id\":\"i_987654321\",\"menu_id\":\"1657275\",\"cart_item_id\":\"line-new\",\"name\":\"Replacement Pizza\",\"quantity\":1}]}"
    }
  ],
  "structuredContent": {
    "schema": "doordash-cli",
    "version": 1,
    "kind": "cart",
    "cart_uuid": "cart-123",
    "menu_id": "1657275",
    "store": {
      "store_id": "928163",
      "menu_id": "1657275",
      "name": "Example Pizza"
    },
    "items": [
      {
        "item_id": "i_987654321",
        "menu_id": "1657275",
        "cart_item_id": "line-new",
        "name": "Replacement Pizza",
        "quantity": 1
      }
    ]
  }
}
```

For a true deletion with no replacement, explicitly pass:

```json
{
  "cart_uuid": "cart-123",
  "cart_item_id": "line-old",
  "confirm_delete_without_replacement": true
}
```

Provide exactly one of `replacement_cart_item_id` or
`confirm_delete_without_replacement: true`. Never use the deletion confirmation
to bypass replacement proof. If the mutation or hydration result is unknown,
follow the returned one-time `show_cart` recovery and do not retry the removal.

## Order preview

Preview timing is the current DoorDash quote. No checkout URL is invented to
fill a field. `submit_context` is the exact safe handoff into `order_submit`;
do not rebuild its values from prose or earlier cart responses. Its
`preview_token` binds the cart contents, fields in `submit_context`, and the
selected work budget's identity, rules, and remaining balance; changing any of
that requires a new preview. Tip, payment confirmation, and expense details are
added afterward.

Omit the `preview_order` input `fulfillment` to preserve the cart's current
mode. Passing `delivery` or `pickup` explicitly changes it.

```json
{
  "content": [
    {
      "type": "text",
      "text": "DoorDash order preview from Example Pizza: 1 item, $25.01 before tip, 20-30 min."
    },
    {
      "type": "text",
      "text": "{\"schema\":\"doordash-cli\",\"version\":1,\"kind\":\"order_preview\",\"cart_uuid\":\"cart-123\",\"store\":{\"store_id\":\"928163\",\"name\":\"Example Pizza\"},\"items\":[{\"item_id\":\"i_23266866023\",\"cart_item_id\":\"line-1\",\"name\":\"Margherita Pizza\",\"quantity\":1,\"price\":23}],\"fulfillment\":\"delivery\",\"delivery_address\":{\"address\":\"123 Main St, Oakland, CA 94611\"},\"delivery_time\":\"20-30 min\",\"pricing\":{\"subtotal\":23,\"fees\":[{\"label\":\"Delivery fee\",\"amount\":0}],\"tax\":2.01,\"total_before_tip\":25.01},\"pricing_quote_id\":\"quote-456\",\"tip_suggestions\":[{\"amount\":5,\"percentage\":20,\"recommended\":true,\"recipient\":\"dasher\"}],\"work_benefits\":{\"team_id\":\"team-7\",\"eligible_budgets\":[{\"budget_id\":\"budget-4\",\"name\":\"Dinner Budget\",\"remaining\":40,\"team_account_id\":\"team-account-2\",\"expense_code_mode\":\"optional\"}]},\"submit_context\":{\"cart_uuid\":\"cart-123\",\"preview_token\":\"bHy-Nx9_OVxS4mVXGF8TF08f-HmEiEvPl-9mM9pHUaQ.sxoJtkJslOz0zqrsIs4uuss1vX8cPgTWuvHCAScEilk\",\"expected_total_before_tip\":25.01,\"expected_delivery_address\":\"123 Main St, Oakland, CA 94611\",\"fulfillment\":\"delivery\",\"priority\":false,\"apply_credits\":true,\"pin_handoff_required\":false}}"
    }
  ],
  "structuredContent": {
    "schema": "doordash-cli",
    "version": 1,
    "kind": "order_preview",
    "cart_uuid": "cart-123",
    "store": {
      "store_id": "928163",
      "name": "Example Pizza"
    },
    "items": [
      {
        "item_id": "i_23266866023",
        "cart_item_id": "line-1",
        "name": "Margherita Pizza",
        "quantity": 1,
        "price": 23
      }
    ],
    "fulfillment": "delivery",
    "delivery_address": {
      "address": "123 Main St, Oakland, CA 94611"
    },
    "delivery_time": "20-30 min",
    "pricing": {
      "subtotal": 23,
      "fees": [
        {
          "label": "Delivery fee",
          "amount": 0
        }
      ],
      "tax": 2.01,
      "total_before_tip": 25.01
    },
    "pricing_quote_id": "quote-456",
    "tip_suggestions": [
      {
        "amount": 5,
        "percentage": 20,
        "recommended": true,
        "recipient": "dasher"
      }
    ],
    "work_benefits": {
      "team_id": "team-7",
      "eligible_budgets": [
        {
          "budget_id": "budget-4",
          "name": "Dinner Budget",
          "remaining": 40,
          "team_account_id": "team-account-2",
          "expense_code_mode": "optional"
        }
      ]
    },
    "submit_context": {
      "cart_uuid": "cart-123",
      "preview_token": "bHy-Nx9_OVxS4mVXGF8TF08f-HmEiEvPl-9mM9pHUaQ.sxoJtkJslOz0zqrsIs4uuss1vX8cPgTWuvHCAScEilk",
      "expected_total_before_tip": 25.01,
      "expected_delivery_address": "123 Main St, Oakland, CA 94611",
      "fulfillment": "delivery",
      "priority": false,
      "apply_credits": true,
      "pin_handoff_required": false
    }
  }
}
```

Copy `cart_uuid`, `preview_token`, `expected_total_before_tip`,
`expected_delivery_address`, optional `scheduled_time`, `fulfillment`,
`priority`, `apply_credits`, and `pin_handoff_required` from `submit_context`.
Add the confirmed tip and payment. For pickup, copy
`expected_delivery_address: null` when the preview returns no delivery address.

```json
{
  "cart_uuid": "cart-123",
  "preview_token": "bHy-Nx9_OVxS4mVXGF8TF08f-HmEiEvPl-9mM9pHUaQ.sxoJtkJslOz0zqrsIs4uuss1vX8cPgTWuvHCAScEilk",
  "expected_total_before_tip": 25.01,
  "expected_delivery_address": "123 Main St, Oakland, CA 94611",
  "tip": 5,
  "tip_confirmed": true,
  "payment_confirmation": {
    "type": "card",
    "brand": "Visa",
    "last4": "4242"
  },
  "confirmation": "PLACE ORDER",
  "fulfillment": "delivery",
  "priority": false,
  "apply_credits": true,
  "pin_handoff_required": false
}
```

`expected_total_before_tip`, `tip`, and group-cart `spend_limit` are dollars.
For a card, `brand` and `last4` must come from the confirmed `is_default` card
returned by `list_payment_methods`.

If `submit_context.pin_handoff_required` is true, ask the user to accept giving
the delivery PIN to the Dasher, then add
`"pin_handoff_acknowledged": true`. Do not infer that acknowledgement.

For work payment, call `preview_order` again with the selected `budget_id`,
then copy `work_benefits.team_id` and that budget's `budget_id`, `name`, and
optional `team_account_id`. Set
`payment_confirmation` to `{"type":"work_budget","name":"Dinner Budget"}` and
include any required `expense_code` or `expense_notes`. `team_id` and
`budget_id` must be supplied together.

Use `{"type":"account_default","acknowledgement":"USE ACCOUNT DEFAULT"}` only
when `list_payment_methods` cannot identify the default, browser checkout was
offered, and the user explicitly accepts the unseen account default.

## Submitted order

The final result carries the revalidated preview forward, then adds the tip,
final total, order status, masked payment summary, and any URL returned by
DoorDash.

```json
{
  "content": [
    {
      "type": "text",
      "text": "DoorDash order from Example Pizza: successful, $30.01, 20-30 min. Track: https://www.doordash.com/orders/order-789"
    },
    {
      "type": "text",
      "text": "{\"schema\":\"doordash-cli\",\"version\":1,\"kind\":\"order_submit\",\"order_uuid\":\"order-789\",\"cart_uuid\":\"cart-123\",\"status\":\"successful\",\"store\":{\"store_id\":\"928163\",\"name\":\"Example Pizza\"},\"items\":[{\"item_id\":\"i_23266866023\",\"cart_item_id\":\"line-1\",\"name\":\"Margherita Pizza\",\"quantity\":1,\"price\":23}],\"fulfillment\":\"delivery\",\"delivery_address\":{\"address\":\"123 Main St, Oakland, CA 94611\"},\"delivery_time\":\"20-30 min\",\"pricing\":{\"subtotal\":23,\"fees\":[{\"label\":\"Delivery fee\",\"amount\":0}],\"tax\":2.01,\"tip\":5,\"total_before_tip\":25.01,\"total\":30.01},\"payment\":{\"type\":\"card\",\"brand\":\"Visa\",\"last4\":\"4242\"},\"tracking_url\":\"https://www.doordash.com/orders/order-789\",\"reorderable\":true}"
    }
  ],
  "structuredContent": {
    "schema": "doordash-cli",
    "version": 1,
    "kind": "order_submit",
    "order_uuid": "order-789",
    "cart_uuid": "cart-123",
    "status": "successful",
    "store": {
      "store_id": "928163",
      "name": "Example Pizza"
    },
    "items": [
      {
        "item_id": "i_23266866023",
        "cart_item_id": "line-1",
        "name": "Margherita Pizza",
        "quantity": 1,
        "price": 23
      }
    ],
    "fulfillment": "delivery",
    "delivery_address": {
      "address": "123 Main St, Oakland, CA 94611"
    },
    "delivery_time": "20-30 min",
    "pricing": {
      "subtotal": 23,
      "fees": [
        {
          "label": "Delivery fee",
          "amount": 0
        }
      ],
      "tax": 2.01,
      "tip": 5,
      "total_before_tip": 25.01,
      "total": 30.01
    },
    "payment": {
      "type": "card",
      "brand": "Visa",
      "last4": "4242"
    },
    "tracking_url": "https://www.doordash.com/orders/order-789",
    "reorderable": true
  }
}
```

## Safe reorder

Call `reorder` once with `{"order_uuid":"order-789"}`. Before writing, the
server loads the source order and checks active carts at the same store. A
nonempty cart stops the operation instead of silently merging and doubling the
items. Otherwise the server performs exactly one upstream reorder, hydrates the
new cart with `show_cart`, and compares its lines with the source order.

On success, use the verified hydrated cart as the starting point for
customization. If hydration fails or the tool reports an unknown mutation
outcome, perform its one inspection action; never call `reorder` again to find
out what happened.

## Checkout link

```json
{
  "content": [
    {
      "type": "text",
      "text": "DoorDash checkout: https://www.doordash.com/checkout/cart-123"
    },
    {
      "type": "text",
      "text": "{\"schema\":\"doordash-cli\",\"version\":1,\"kind\":\"checkout_link\",\"cart_uuid\":\"cart-123\",\"checkout_url\":\"https://www.doordash.com/checkout/cart-123\"}"
    }
  ],
  "structuredContent": {
    "schema": "doordash-cli",
    "version": 1,
    "kind": "checkout_link",
    "cart_uuid": "cart-123",
    "checkout_url": "https://www.doordash.com/checkout/cart-123"
  }
}
```

## Error

Typed errors are the error branch of the advertised `outputSchema`. They are
never safe to retry unchanged. When recovery is available,
`recovery_tool` and `recovery_arguments` describe one concrete next call.

Unknown mutation outcomes use the same rule: inspect once with the returned
tool. Cart mutations recover through `show_cart`, reorders through
`list_carts`, address changes through `list_addresses`, promo changes through
browser checkout, and mode-changing previews through `show_cart`.

```json
{
  "content": [
    {
      "type": "text",
      "text": "ACTIVE_CART_EXISTS: An active DoorDash cart already exists at this store (cart-existing). No items were added. Call show_cart with that cart_uuid first. If it already matches the request, call create_checkout_link; otherwise ask whether to extend it using that cart_uuid or replace it with delete_cart. Do not retry the unchanged call. Next: call show_cart once with {\"cart_uuid\":\"cart-existing\"}."
    },
    {
      "type": "text",
      "text": "{\"schema\":\"doordash-cli\",\"version\":1,\"kind\":\"cart\",\"error\":{\"code\":\"ACTIVE_CART_EXISTS\",\"message\":\"An active DoorDash cart already exists at this store (cart-existing). No items were added. Call show_cart with that cart_uuid first. If it already matches the request, call create_checkout_link; otherwise ask whether to extend it using that cart_uuid or replace it with delete_cart.\",\"retryable\":false,\"recovery_tool\":\"show_cart\",\"recovery_arguments\":{\"cart_uuid\":\"cart-existing\"}}}"
    }
  ],
  "structuredContent": {
    "schema": "doordash-cli",
    "version": 1,
    "kind": "cart",
    "error": {
      "code": "ACTIVE_CART_EXISTS",
      "message": "An active DoorDash cart already exists at this store (cart-existing). No items were added. Call show_cart with that cart_uuid first. If it already matches the request, call create_checkout_link; otherwise ask whether to extend it using that cart_uuid or replace it with delete_cart.",
      "retryable": false,
      "recovery_tool": "show_cart",
      "recovery_arguments": {
        "cart_uuid": "cart-existing"
      }
    }
  },
  "isError": true
}
```

If `show_cart` proves the existing cart should be replaced, ask the user first.
Only then call:

```json
{
  "cart_uuid": "cart-existing",
  "confirmation": "DELETE CART"
}
```

Schema failures use the same error shape with
`code: "UPSTREAM_SCHEMA_ERROR"`, `retryable: false`, and no invented recovery
action.
