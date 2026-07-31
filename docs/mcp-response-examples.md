# MCP response contract

Typed results use a compact, versioned object:

- `content[0].text` is readable prose.
- On success, `content[1].text` is minified JSON exactly equal to
  `JSON.stringify(structuredContent)`.
- `structuredContent` is the machine contract.
- On error, `isError` is `true`, `content` contains only the readable error,
  and `structuredContent.error` contains the typed error.

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
| `get_restaurant_item_details` | `item_details` |
| `search_restaurants` | `store_search` |
| `get_store_details` | `store_details` |
| `add_cart_items` | `cart` |
| `delete_cart` | `cart_mutation` |
| `list_carts` | `cart_list` |
| `remove_cart_item` | `cart_mutation` |
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
| `activity` | `activity` |
| `run` | `raw_cli` |

`run` is intentionally generic. Its `raw_cli` payload is not
advertised as a stable typed contract.

## Kind payloads

| `kind` | Payload after `schema`, `version`, and `kind` |
| --- | --- |
| `address_list` | `addresses` |
| `address_update` | Optional `resource_id` and `message` |
| `grocery_list` | Store, resolved `items`, optional alternatives and address |
| `item_search` | Search groups containing `query` and `items` |
| `store_search` | `stores` and optional `truncation` |
| `store_details` | `store` |
| `menu` | Store, `menu_id`, `items`, optional categories and truncation |
| `item_details` | Store, `menu_id`, and `item` |
| `cart` | Cart ID, store, items, fulfillment, checkout link, and optional item errors |
| `cart_list` | `carts` and optional `truncation` |
| `cart_mutation` | Optional `resource_id` and `message` |
| `checkout_link` | Cart ID and upstream `checkout_url` |
| `order_list` | `orders` and optional `truncation` |
| `order_preview` | Current quote, pricing, ETA, and optional tip/work data |
| `receipt` | Final order and pricing |
| `reorder` | New cart |
| `order_status` | Current order status and any upstream tracking URL |
| `promotion_list` | `promotions` |
| `promotion_mutation` | Optional `resource_id` and `message` |
| `payment_methods` | Masked `cards` |
| `order_submit` | Confirmed items, pricing, tip, ETA, status, and upstream links |
| `activity` | Redacted activity `entries` |
| `raw_cli` | Generic `result` |

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

## Menu with modifiers

```json
{
  "content": [
    {
      "type": "text",
      "text": "Loaded 1 menu item from Example Pizza."
    },
    {
      "type": "text",
      "text": "{\"schema\":\"doordash-cli\",\"version\":1,\"kind\":\"menu\",\"store\":{\"store_id\":\"928163\",\"name\":\"Example Pizza\"},\"menu_id\":\"1657275\",\"items\":[{\"item_id\":\"23266866023\",\"name\":\"Margherita Pizza\",\"description\":\"Tomato, mozzarella, and basil\",\"image_url\":\"https://images.example.test/items/pizza.jpg\",\"price\":18.99,\"available\":true,\"modifier_groups\":[{\"group_id\":\"size\",\"name\":\"Size\",\"min_selections\":1,\"max_selections\":1,\"options\":[{\"option_id\":\"large\",\"name\":\"Large\",\"price\":4,\"available\":true}]}]}],\"categories\":[{\"category_id\":\"pizza\",\"name\":\"Pizza\",\"item_ids\":[\"23266866023\"]}]}"
    }
  ],
  "structuredContent": {
    "schema": "doordash-cli",
    "version": 1,
    "kind": "menu",
    "store": {
      "store_id": "928163",
      "name": "Example Pizza"
    },
    "menu_id": "1657275",
    "items": [
      {
        "item_id": "23266866023",
        "name": "Margherita Pizza",
        "description": "Tomato, mozzarella, and basil",
        "image_url": "https://images.example.test/items/pizza.jpg",
        "price": 18.99,
        "available": true,
        "modifier_groups": [
          {
            "group_id": "size",
            "name": "Size",
            "min_selections": 1,
            "max_selections": 1,
            "options": [
              {
                "option_id": "large",
                "name": "Large",
                "price": 4,
                "available": true
              }
            ]
          }
        ]
      }
    ],
    "categories": [
      {
        "category_id": "pizza",
        "name": "Pizza",
        "item_ids": [
          "23266866023"
        ]
      }
    ]
  }
}
```

## Partial cart addition

Successful lines stay in `items` and receive a `checkout_url`. Lines that still
need a choice appear once in `item_errors`; there is no second status envelope
describing the same fact.

```json
{
  "content": [
    {
      "type": "text",
      "text": "1 cart line at Example Pizza; 1 item still needs attention. Checkout: https://www.doordash.com/checkout/cart-123"
    },
    {
      "type": "text",
      "text": "{\"schema\":\"doordash-cli\",\"version\":1,\"kind\":\"cart\",\"cart_uuid\":\"cart-123\",\"store\":{\"store_id\":\"928163\",\"name\":\"Example Pizza\"},\"items\":[{\"item_id\":\"23266866023\",\"cart_item_id\":\"line-1\",\"name\":\"Margherita Pizza\",\"quantity\":1,\"price\":18.99}],\"fulfillment\":\"delivery\",\"group_cart_url\":\"https://www.doordash.com/group-orders/cart-123\",\"item_errors\":[{\"item\":{\"item_id\":\"combo-1\",\"name\":\"Pizza Combo\",\"quantity\":1},\"message\":\"Choose a size.\",\"modifier_groups\":[{\"group_id\":\"size\",\"name\":\"Size\",\"min_selections\":1,\"max_selections\":1,\"options\":[{\"option_id\":\"small\",\"name\":\"Small\",\"price\":0},{\"option_id\":\"large\",\"name\":\"Large\",\"price\":1.5}]}]}],\"checkout_url\":\"https://www.doordash.com/checkout/cart-123\"}"
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
        "item_id": "23266866023",
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

## Order preview

Preview timing is the current DoorDash quote. No checkout URL is invented to
fill a field.

```json
{
  "content": [
    {
      "type": "text",
      "text": "DoorDash order preview from Example Pizza: 1 item, $25.01 before tip, 20-30 min."
    },
    {
      "type": "text",
      "text": "{\"schema\":\"doordash-cli\",\"version\":1,\"kind\":\"order_preview\",\"cart_uuid\":\"cart-123\",\"store\":{\"store_id\":\"928163\",\"name\":\"Example Pizza\"},\"items\":[{\"item_id\":\"23266866023\",\"cart_item_id\":\"line-1\",\"name\":\"Margherita Pizza\",\"quantity\":1,\"price\":23}],\"fulfillment\":\"delivery\",\"delivery_address\":{\"address\":\"123 Main St, Oakland, CA 94611\"},\"delivery_time\":\"20-30 min\",\"pricing\":{\"subtotal\":23,\"fees\":[{\"label\":\"Delivery fee\",\"amount\":0}],\"tax\":2.01,\"total_before_tip\":25.01},\"pricing_quote_id\":\"quote-456\",\"tip_suggestions\":[{\"amount\":5,\"percentage\":20,\"recommended\":true,\"recipient\":\"dasher\"}]}"
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
        "item_id": "23266866023",
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
    ]
  }
}
```

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
      "text": "{\"schema\":\"doordash-cli\",\"version\":1,\"kind\":\"order_submit\",\"order_uuid\":\"order-789\",\"cart_uuid\":\"cart-123\",\"status\":\"successful\",\"store\":{\"store_id\":\"928163\",\"name\":\"Example Pizza\"},\"items\":[{\"item_id\":\"23266866023\",\"cart_item_id\":\"line-1\",\"name\":\"Margherita Pizza\",\"quantity\":1,\"price\":23}],\"fulfillment\":\"delivery\",\"delivery_address\":{\"address\":\"123 Main St, Oakland, CA 94611\"},\"delivery_time\":\"20-30 min\",\"pricing\":{\"subtotal\":23,\"fees\":[{\"label\":\"Delivery fee\",\"amount\":0}],\"tax\":2.01,\"tip\":5,\"total_before_tip\":25.01,\"total\":30.01},\"payment\":{\"type\":\"card\",\"brand\":\"Visa\",\"last4\":\"4242\"},\"tracking_url\":\"https://www.doordash.com/orders/order-789\",\"reorderable\":true}"
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
        "item_id": "23266866023",
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

Malformed upstream containers are errors, not empty successes. Errors have no
JSON compatibility copy because the readable error plus structured error is
already unambiguous.

```json
{
  "content": [
    {
      "type": "text",
      "text": "UPSTREAM_SCHEMA_ERROR: DoorDash menu response did not contain an items array."
    }
  ],
  "structuredContent": {
    "schema": "doordash-cli",
    "version": 1,
    "kind": "menu",
    "error": {
      "code": "UPSTREAM_SCHEMA_ERROR",
      "message": "DoorDash menu response did not contain an items array.",
      "retryable": false
    }
  },
  "isError": true
}
```
