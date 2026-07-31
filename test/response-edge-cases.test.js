import assert from "node:assert/strict";
import test from "node:test";

import * as z from "zod/v4";

import { createDoorDashApp } from "../src/app.js";
import {
  contracts,
  projectWithContract
} from "../src/response-contract.js";
import { SecurityStore } from "../src/security-store.js";

function createTestApp(options) {
  return createDoorDashApp({
    adminAccessToken: "test-admin-secret",
    ...options
  });
}

function orderItems() {
  return [
    {
      id: "line-1",
      quantity: 1,
      item: {
        id: "item-1",
        name: "Pizza"
      },
      unit_price_monetary_fields: {
        unit_amount: 2500
      }
    }
  ];
}

function preview({
  totalBeforeTip = 2500,
  quote = {}
} = {}) {
  return {
    success: true,
    cart_uuid: "cart-1",
    quote: {
      total_before_tip: { unit_amount: totalBeforeTip },
      delivery_address: {
        printable_address: "21 Bay Forest Dr, Oakland, CA 94611, USA"
      },
      store_order_cart: {
        store: {
          id: "store-1",
          name: "Example Pizza"
        },
        orders: [{ order_items: orderItems() }]
      },
      ...quote
    }
  };
}

function submittedOrder(overrides = {}) {
  return {
    submitted: {
      order_uuid: "order-1"
    },
    preview: preview(),
    finalStatus: {
      status: "successful"
    },
    orderUuid: "order-1",
    terminalStatus: "successful",
    tipCents: 500,
    ...overrides
  };
}

function assertUpstreamSchemaError(callback) {
  assert.throws(callback, (error) => {
    assert.equal(error?.code, "UPSTREAM_SCHEMA_ERROR");
    return true;
  });
}

test("submitted total uses the confirmed tip, not a stale preview total", () => {
  const projected = projectWithContract(
    contracts.orderSubmit,
    submittedOrder({
      preview: preview({
        quote: {
          tip: { unit_amount: 200 },
          total: { unit_amount: 2700 }
        }
      })
    })
  );

  assert.equal(projected.pricing.total_before_tip, 25);
  assert.equal(projected.pricing.tip, 5);
  assert.equal(projected.pricing.total, 30);
});

test("sparse final order data preserves preview store, items, quote, and ETA", () => {
  const projected = projectWithContract(
    contracts.orderSubmit,
    submittedOrder({
      preview: preview({
        quote: {
          pricing_quote_id: "quote-1",
          delivery_availability: {
            asap_minutes_range_string: "25-35 min"
          }
        }
      }),
      finalStatus: {
        status: "successful"
      }
    })
  );

  assert.equal(projected.store.store_id, "store-1");
  assert.equal(projected.store.name, "Example Pizza");
  assert.equal(projected.items[0].item_id, "item-1");
  assert.equal(projected.pricing.total_before_tip, 25);
  assert.equal(projected.delivery_time, "25-35 min");
});

test("final non-null order links win, with submitted links as fallback", () => {
  const finalLink = projectWithContract(
    contracts.orderSubmit,
    submittedOrder({
      submitted: {
        order_uuid: "order-1",
        tracking_url: "https://doordash.test/submitted"
      },
      finalStatus: {
        status: "successful",
        tracking_url: "https://doordash.test/final"
      }
    })
  );
  const submittedFallback = projectWithContract(
    contracts.orderSubmit,
    submittedOrder({
      submitted: {
        order_uuid: "order-1",
        tracking_url: "https://doordash.test/submitted"
      },
      finalStatus: {
        status: "successful",
        tracking_url: null
      }
    })
  );

  assert.equal(
    finalLink.tracking_url,
    "https://doordash.test/final"
  );
  assert.equal(
    submittedFallback.tracking_url,
    "https://doordash.test/submitted"
  );
});

test("unknown distance text is omitted instead of pretending to be miles", () => {
  const projected = projectWithContract(contracts.storeSearch, {
    stores: [
      {
        store_id: "store-1",
        name: "Example Pizza",
        distance_display: "nearby"
      }
    ]
  });

  assert.equal("distance" in projected.stores[0], false);
});

test("a later valid ETA range beats an earlier malformed alias", () => {
  const projected = projectWithContract(contracts.storeSearch, {
    stores: [
      {
        store_id: "store-1",
        name: "Example Pizza",
        asap_minutes_range: ["soon"],
        delivery_minutes_range: [25, 35]
      }
    ]
  });

  assert.equal(projected.stores[0].delivery_time, "25-35 min");
});

test("a promotional credit appears once as credit, not also as a discount", () => {
  const projected = projectWithContract(contracts.receipt, {
    order_uuid: "order-1",
    items: [],
    total_before_tip: { unit_amount: 2000 },
    line_items: [
      {
        charge_id: "PROMO_CREDIT",
        label: "Promotional credit",
        final_money: { unit_amount: 500 }
      }
    ]
  });

  assert.equal(projected.pricing.credits, 5);
  assert.equal(projected.pricing.discounts, undefined);
});

test("unknown address and payment default flags stay omitted", () => {
  const addresses = projectWithContract(contracts.addresses, {
    addresses: [
      {
        id: "address-1",
        printable_address: "123 Main St"
      }
    ]
  });
  const payments = projectWithContract(contracts.paymentMethods, {
    cards: [
      {
        payment_method_id: "pm-1",
        brand: "Visa",
        last4: "4242"
      }
    ]
  });

  assert.equal("is_default" in addresses.addresses[0], false);
  assert.equal("is_default" in payments.cards[0], false);
});

test("output-schema validation failures become UPSTREAM_SCHEMA_ERROR", () => {
  const invalidContract = {
    kind: "invalid_test_contract",
    outputSchema: z.object({
      required_value: z.string()
    }),
    project: () => ({
      required_value: 42
    })
  };

  assertUpstreamSchemaError(() =>
    projectWithContract(invalidContract, {})
  );
});

test("malformed category, pricing, and tip arrays are typed schema errors", () => {
  const malformed = [
    () =>
      projectWithContract(contracts.menu, {
        menu_id: "menu-1",
        items: [],
        categories: { malformed: true }
      }),
    () =>
      projectWithContract(contracts.receipt, {
        order_uuid: "order-1",
        items: [],
        total_before_tip: { unit_amount: 2000 },
        line_items: { malformed: true }
      }),
    () =>
      projectWithContract(contracts.orderPreview, {
        ...preview(),
        quote: {
          ...preview().quote,
          tips_suggestion_details: { malformed: true }
        }
      })
  ];

  for (const callback of malformed) {
    assertUpstreamSchemaError(callback);
  }
});

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

async function mcpRequest(handler, auth, method, params) {
  const request = new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    })
  });
  const response = await handler.fetch(request, {
    authInfo: auth
  });
  const text = await response.text();
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "));
  return dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(text);
}

test("submit recognizes a nested terminal order status at app level", async () => {
  const securityStore = new SecurityStore({ databasePath: ":memory:" });
  const token = securityStore.createToken({
    name: "Purchase",
    allowPurchases: true
  });
  const tokenRecord = securityStore.verifyToken(token.token);
  const auth = {
    token: token.token,
    clientId: tokenRecord.id,
    scopes: tokenRecord.scopes,
    expiresAt: tokenRecord.expiresAt
  };
  const { mcpHandler } = createTestApp({
    securityStore,
    pollDelay: async () => {},
    runCli: async (args) => {
      if (args[0] === "order" && args[1] === "preview") {
        return cliResult(preview());
      }
      if (args[0] === "payment-method") {
        return cliResult({
          default_payment_method_id: "pm-1",
          cards: [
            {
              payment_method_id: "pm-1",
              brand: "Visa",
              last4: "4242"
            }
          ]
        });
      }
      if (args[0] === "order" && args[1] === "submit") {
        return cliResult({
          success: true,
          order_uuid: "order-1"
        });
      }
      if (args[0] === "order" && args[1] === "status") {
        return cliResult({
          result: {
            order: {
              order_uuid: "order-1",
              status: "successful",
              tracking_url: "https://doordash.test/order-1"
            }
          }
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });

  try {
    const response = await mcpRequest(
      mcpHandler,
      auth,
      "tools/call",
      {
        name: "order_submit",
        arguments: {
          cartUuid: "cart-1",
          expectedTotalBeforeTipCents: 2500,
          expectedDeliveryAddress:
            "21 Bay Forest Dr, Oakland, CA 94611",
          tipCents: 500,
          tipConfirmed: true,
          paymentConfirmation: {
            type: "card",
            brand: "Visa",
            last4: "4242"
          },
          confirmation: "PLACE ORDER",
          priority: false,
          applyCredits: true
        }
      }
    );

    assert.equal(response.result.isError, undefined);
    assert.equal(response.result.structuredContent.status, "successful");
    assert.equal(
      response.result.structuredContent.tracking_url,
      "https://doordash.test/order-1"
    );
    assert.equal(
      response.result.structuredContent.warnings,
      undefined
    );
    assert.equal(
      securityStore.getSubmissionAttempt("cart-1").status,
      "successful"
    );
  } finally {
    await mcpHandler.close();
    securityStore.close();
  }
});
