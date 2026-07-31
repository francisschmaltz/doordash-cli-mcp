import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RESPONSE_SCHEMA,
  RESPONSE_SCHEMA_VERSION,
  contracts,
  errorEnvelope,
  projectWithContract,
  toToolResult
} from "../src/response-contract.js";

const fixtures = new Map([
  [contracts.addresses, { addresses: [] }],
  [contracts.addressUpdate, { success: true }],
  [contracts.groceryList, { items: [] }],
  [contracts.itemSearch, { results: {} }],
  [contracts.storeSearch, { stores: [] }],
  [contracts.itemDetails, { item_id: "item-1", name: "Item" }],
  [contracts.menu, { menu_id: "menu-1", items: [] }],
  [contracts.storeDetails, { store_id: "store-1", name: "Store" }],
  [
    contracts.cart,
    {
      success: true,
      cart_uuid: "cart-1",
      cart: { id: "cart-1", items: [] }
    }
  ],
  [contracts.cartList, { carts: [] }],
  [contracts.cartMutation, { success: true, cart_uuid: "cart-1" }],
  [
    contracts.checkoutLink,
    {
      cart_uuid: "cart-1",
      checkout_url: "https://www.doordash.test/checkout/cart-1"
    }
  ],
  [contracts.orderList, { orders: [], page_full: false }],
  [
    contracts.orderPreview,
    {
      success: true,
      cart_uuid: "cart-1",
      quote: {
        total_before_tip: {
          unit_amount: 1000,
          display_string: "$10.00"
        },
        store_order_cart: { orders: [] }
      }
    }
  ],
  [
    contracts.receipt,
    {
      order_uuid: "order-1",
      items: [],
      total: { unit_amount: 1000 }
    }
  ],
  [
    contracts.reorder,
    {
      success: true,
      cart_uuid: "cart-1",
      cart: { id: "cart-1", items: [] }
    }
  ],
  [contracts.orderStatus, { order_uuid: "order-1", status: "pending" }],
  [contracts.promotionList, { promos: [] }],
  [contracts.promotionMutation, { success: true, cart_uuid: "cart-1" }],
  [contracts.paymentMethods, { cards: [] }],
  [
    contracts.orderSubmit,
    {
      submitted: { order_uuid: "order-1" },
      preview: {
        cart_uuid: "cart-1",
        quote: {
          total_before_tip: {
            unit_amount: 1000,
            display_string: "$10.00"
          },
          store_order_cart: { orders: [] }
        }
      },
      finalStatus: { order_uuid: "order-1", status: "successful" },
      orderUuid: "order-1",
      terminalStatus: "successful",
      tipCents: 200,
      payment: {
        type: "card",
        brand: "Visa",
        last4: "4242"
      }
    }
  ],
  [contracts.orderSubmitAccepted, { order_uuid: "order-1" }],
  [contracts.activity, { count: 0, entries: [] }],
  [contracts.rawCli, { future_field: true }]
]);

test("every response contract validates its compact success response", () => {
  for (const contract of new Set(Object.values(contracts))) {
    assert.equal(
      fixtures.has(contract),
      true,
      `missing fixture for ${contract.kind}`
    );

    const projected = projectWithContract(contract, fixtures.get(contract));
    assert.equal(projected.schema, RESPONSE_SCHEMA);
    assert.equal(projected.version, RESPONSE_SCHEMA_VERSION);
    assert.equal(projected.kind, contract.kind);
    assert.deepEqual(contract.outputSchema.parse(projected), projected);

    const result = toToolResult(projected);
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, "text");
    assert.match(result.content[0].text, /\S/);
    assert.equal(result.content[1].type, "text");
    assert.deepEqual(JSON.parse(result.content[1].text), projected);
    assert.deepEqual(result.structuredContent, projected);
    assert.equal("isError" in result, false);
  }
});

test("errors are readable, direct, and are not duplicated as JSON text", () => {
  for (const contract of new Set(Object.values(contracts))) {
    const failure = errorEnvelope(contract, new Error("Upstream exploded."));
    assert.equal(failure.schema, RESPONSE_SCHEMA);
    assert.equal(failure.version, RESPONSE_SCHEMA_VERSION);
    assert.equal(failure.kind, contract.kind);
    assert.equal(Object.hasOwn(failure, "data"), false);
    assert.equal(failure.error.message, "Upstream exploded.");

    const result = toToolResult(failure);
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, failure);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    assert.match(result.content[0].text, /Upstream exploded\./);
  }
});

test("documented JSON responses parse and match their advertised contracts", async () => {
  const markdown = await readFile(
    new URL("../docs/mcp-response-examples.md", import.meta.url),
    "utf8"
  );
  const blocks = [
    ...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)
  ].map((match) => JSON.parse(match[1]));

  const examples = blocks.filter(
    (example) =>
      Array.isArray(example?.content) &&
      example?.structuredContent &&
      typeof example.structuredContent === "object"
  );

  assert.ok(examples.length > 0, "documentation has no full MCP responses");
  for (const example of examples) {
    const structured = example.structuredContent;
    const contract = Object.values(contracts).find(
      (candidate) => candidate.kind === structured.kind
    );
    assert.ok(
      contract,
      `unknown documented kind ${structured.kind}`
    );

    assert.equal(structured.schema, RESPONSE_SCHEMA);
    assert.equal(structured.version, RESPONSE_SCHEMA_VERSION);
    assert.equal(example.content[0]?.type, "text");
    assert.match(example.content[0]?.text || "", /\S/);

    if (structured.error) {
      assert.equal(example.isError, true);
      assert.equal(example.content.length, 1);
      assert.equal(typeof structured.error.code, "string");
      assert.equal(typeof structured.error.message, "string");
      continue;
    }

    assert.deepEqual(contract.outputSchema.parse(structured), structured);
    assert.equal(example.content.length, 2);
    assert.equal(example.content[1]?.type, "text");
    assert.deepEqual(JSON.parse(example.content[1].text), structured);
  }
});
