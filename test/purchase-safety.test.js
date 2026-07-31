import assert from "node:assert/strict";
import test from "node:test";

import { createDoorDashApp } from "../src/app.js";
import { SecurityStore } from "../src/security-store.js";

function createTestApp(options) {
  return createDoorDashApp({
    adminAccessToken: "test-admin-secret",
    pollDelay: async () => {},
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

async function mcpRequest(handler, authInfo, name, args, id = 1) {
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
      params: {
        name,
        arguments: args
      }
    })
  });
  const response = await handler.fetch(request, { authInfo });
  const text = await response.text();
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "));
  return dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(text);
}

function purchaseAuth(store) {
  const token = store.createToken({
    name: "Purchase safety",
    allowPurchases: true
  });
  const record = store.verifyToken(token.token);
  return {
    token: token.token,
    clientId: record.id,
    scopes: record.scopes,
    expiresAt: record.expiresAt
  };
}

function previewResult({
  cartUuid,
  remainingCents,
  teamId,
  budgetId,
  teamAccountId
}) {
  const workBudget =
    budgetId === undefined
      ? {}
      : {
          company_payment_info: {
            team_order_info: {
              team_id: teamId
            }
          },
          expense_order_options: {
            all_eligible_expense_order_budgets: [
              {
                id: budgetId,
                name: "Dinner",
                remaining_amount: {
                  unit_amount: remainingCents
                },
                team_account_id: teamAccountId,
                expense_code_mode: "optional",
                is_expense_note_required: false
              }
            ]
          }
        };
  return {
    success: true,
    cart_uuid: cartUuid,
    quote: {
      id: cartUuid,
      total_before_tip: {
        unit_amount: 2500
      },
      delivery_address: {
        printable_address: "21 Bay Forest Dr, Oakland, CA 94611"
      },
      ...workBudget,
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
                  name: "Dinner"
                },
                unit_price_monetary_fields: {
                  unit_amount: 2500
                }
              }
            ]
          }
        ]
      }
    }
  };
}

function personalSubmitArgs(context, paymentConfirmation) {
  return {
    ...context,
    tip: 5,
    tip_confirmed: true,
    payment_confirmation:
      paymentConfirmation ||
      {
        type: "account_default",
        acknowledgement: "USE ACCOUNT DEFAULT"
      },
    confirmation: "PLACE ORDER"
  };
}

function commandCount(calls, first, second) {
  return calls.filter(
    (args) => args[0] === first && args[1] === second
  ).length;
}

test("empty submit outcome is unknown and its ledger entry blocks every repeat", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = purchaseAuth(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "order" && args[1] === "preview") {
        return cliResult(previewResult({ cartUuid: "cart-empty" }));
      }
      if (args[0] === "order" && args[1] === "submit") {
        return cliResult(null);
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const preview = await mcpRequest(
    mcpHandler,
    auth,
    "preview_order",
    { cart_uuid: "cart-empty" }
  );
  const submitArgs = personalSubmitArgs(
    preview.result.structuredContent.submit_context
  );
  const first = await mcpRequest(
    mcpHandler,
    auth,
    "order_submit",
    submitArgs,
    2
  );

  assert.equal(first.result.isError, true);
  assert.equal(
    first.result.structuredContent.error.code,
    "SUBMISSION_OUTCOME_UNKNOWN"
  );
  assert.equal(store.getSubmissionAttempt("cart-empty").status, "unknown");
  assert.equal(commandCount(calls, "order", "submit"), 1);

  const beforeRepeat = calls.length;
  const repeated = await mcpRequest(
    mcpHandler,
    auth,
    "order_submit",
    submitArgs,
    3
  );
  assert.equal(repeated.result.isError, true);
  assert.equal(
    repeated.result.structuredContent.error.code,
    "SUBMISSION_ALREADY_ATTEMPTED"
  );
  assert.equal(calls.length, beforeRepeat);
  assert.equal(commandCount(calls, "order", "submit"), 1);
});

test("string success=false is a rejected submission, not acceptance", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = purchaseAuth(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "order" && args[1] === "preview") {
        return cliResult(previewResult({ cartUuid: "cart-rejected" }));
      }
      if (args[0] === "order" && args[1] === "submit") {
        return cliResult({
          success: "false",
          error_message: "Payment was declined."
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const preview = await mcpRequest(
    mcpHandler,
    auth,
    "preview_order",
    { cart_uuid: "cart-rejected" }
  );
  const response = await mcpRequest(
    mcpHandler,
    auth,
    "order_submit",
    personalSubmitArgs(preview.result.structuredContent.submit_context),
    2
  );

  assert.equal(response.result.isError, true);
  assert.equal(
    response.result.structuredContent.error.code,
    "SUBMISSION_REJECTED"
  );
  assert.equal(store.getSubmissionAttempt("cart-rejected").status, "failed");
  assert.equal(commandCount(calls, "order", "submit"), 1);
  assert.equal(commandCount(calls, "order", "status"), 0);
});

test("selected work-budget remaining drift requires a new preview before submit", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = purchaseAuth(store);
  const calls = [];
  let previewCount = 0;
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "order" && args[1] === "preview") {
        previewCount += 1;
        return cliResult(
          previewResult({
            cartUuid: "cart-budget-drift",
            remainingCents: previewCount === 1 ? 4000 : 3500,
            teamId: "team-1",
            budgetId: "budget-1",
            teamAccountId: "account-1"
          })
        );
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const preview = await mcpRequest(
    mcpHandler,
    auth,
    "preview_order",
    {
      cart_uuid: "cart-budget-drift",
      budget_id: "budget-1"
    }
  );
  const context = preview.result.structuredContent.submit_context;
  const response = await mcpRequest(
    mcpHandler,
    auth,
    "order_submit",
    {
      ...context,
      tip: 5,
      tip_confirmed: true,
      payment_confirmation: {
        type: "work_budget",
        name: "Dinner"
      },
      confirmation: "PLACE ORDER",
      team_id: "team-1",
      budget_id: "budget-1",
      team_account_id: "account-1"
    },
    2
  );

  assert.equal(response.result.isError, true);
  assert.equal(
    response.result.structuredContent.error.code,
    "ORDER_PREVIEW_CHANGED"
  );
  assert.equal(commandCount(calls, "order", "preview"), 2);
  assert.equal(commandCount(calls, "order", "submit"), 0);
  assert.equal(store.getSubmissionAttempt("cart-budget-drift"), null);
});

test("numeric work IDs copied from preview as strings remain valid", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = purchaseAuth(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "order" && args[1] === "preview") {
        return cliResult(
          previewResult({
            cartUuid: "cart-numeric-work",
            remainingCents: 5000,
            teamId: 7,
            budgetId: 9,
            teamAccountId: 11
          })
        );
      }
      if (args[0] === "order" && args[1] === "submit") {
        return cliResult({
          success: true,
          order_uuid: "order-numeric-work"
        });
      }
      if (args[0] === "order" && args[1] === "status") {
        return cliResult({
          order: {
            order_uuid: "order-numeric-work",
            status: "successful"
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

  const preview = await mcpRequest(
    mcpHandler,
    auth,
    "preview_order",
    {
      cart_uuid: "cart-numeric-work",
      budget_id: "9"
    }
  );
  const body = preview.result.structuredContent;
  assert.equal(body.work_benefits.team_id, "7");
  assert.equal(body.work_benefits.eligible_budgets[0].budget_id, "9");
  assert.equal(
    body.work_benefits.eligible_budgets[0].team_account_id,
    "11"
  );

  const submitted = await mcpRequest(
    mcpHandler,
    auth,
    "order_submit",
    {
      ...body.submit_context,
      tip: 5,
      tip_confirmed: true,
      payment_confirmation: {
        type: "work_budget",
        name: "Dinner"
      },
      confirmation: "PLACE ORDER",
      team_id: body.work_benefits.team_id,
      budget_id: body.work_benefits.eligible_budgets[0].budget_id,
      team_account_id:
        body.work_benefits.eligible_budgets[0].team_account_id
    },
    2
  );

  assert.equal(
    submitted.result.isError,
    undefined,
    JSON.stringify(submitted)
  );
  assert.equal(
    submitted.result.structuredContent.order_uuid,
    "order-numeric-work"
  );
  const submitCall = calls.find(
    (args) => args[0] === "order" && args[1] === "submit"
  );
  assert.deepEqual(submitCall.slice(submitCall.indexOf("--team-id")), [
    "--team-id",
    "7",
    "--budget-id",
    "9",
    "--team-account-id",
    "11"
  ]);
});

test("recorded submission blocks preview, payment, and submit before any CLI call", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = purchaseAuth(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "order" && args[1] === "preview") {
        return cliResult(previewResult({ cartUuid: "cart-recorded" }));
      }
      if (args[0] === "payment-method" && args[1] === "list") {
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
          order_uuid: "order-should-not-run"
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const preview = await mcpRequest(
    mcpHandler,
    auth,
    "preview_order",
    { cart_uuid: "cart-recorded" }
  );
  assert.equal(store.beginSubmission("cart-recorded"), true);
  store.finishSubmission("cart-recorded", {
    status: "accepted",
    orderUuid: "order-recorded"
  });
  const before = {
    preview: commandCount(calls, "order", "preview"),
    payment: commandCount(calls, "payment-method", "list"),
    submit: commandCount(calls, "order", "submit")
  };

  const response = await mcpRequest(
    mcpHandler,
    auth,
    "order_submit",
    {
      ...personalSubmitArgs(
        preview.result.structuredContent.submit_context,
        {
          type: "card",
          brand: "Visa",
          last4: "4242"
        }
      ),
      priority: true
    },
    2
  );

  assert.equal(response.result.isError, true);
  assert.equal(
    response.result.structuredContent.error.code,
    "SUBMISSION_ALREADY_ATTEMPTED"
  );
  assert.deepEqual(
    {
      preview: commandCount(calls, "order", "preview"),
      payment: commandCount(calls, "payment-method", "list"),
      submit: commandCount(calls, "order", "submit")
    },
    before
  );
});

test("malformed order UUID keeps the submission outcome unknown", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = purchaseAuth(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "order" && args[1] === "preview") {
        return cliResult(previewResult({ cartUuid: "cart-bad-uuid" }));
      }
      if (args[0] === "order" && args[1] === "submit") {
        return cliResult({
          success: true,
          order_uuid: { malformed: true }
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const preview = await mcpRequest(
    mcpHandler,
    auth,
    "preview_order",
    { cart_uuid: "cart-bad-uuid" }
  );
  const response = await mcpRequest(
    mcpHandler,
    auth,
    "order_submit",
    personalSubmitArgs(preview.result.structuredContent.submit_context),
    2
  );

  assert.equal(response.result.isError, true);
  assert.equal(
    response.result.structuredContent.error.code,
    "SUBMISSION_OUTCOME_UNKNOWN"
  );
  assert.equal(store.getSubmissionAttempt("cart-bad-uuid").status, "unknown");
  assert.equal(commandCount(calls, "order", "status"), 0);
});

test("numeric default-card IDs match their projected string form", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = purchaseAuth(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "order" && args[1] === "preview") {
        return cliResult(previewResult({ cartUuid: "cart-numeric-card" }));
      }
      if (args[0] === "payment-method" && args[1] === "list") {
        return cliResult({
          default_payment_method_id: 7,
          cards: [
            {
              payment_method_id: "7",
              brand: "Visa",
              last4: "4242"
            }
          ]
        });
      }
      if (args[0] === "order" && args[1] === "submit") {
        return cliResult({
          success: true,
          order_uuid: "order-numeric-card"
        });
      }
      if (args[0] === "order" && args[1] === "status") {
        return cliResult({
          order: {
            order_uuid: "order-numeric-card",
            status: "successful"
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

  const preview = await mcpRequest(
    mcpHandler,
    auth,
    "preview_order",
    { cart_uuid: "cart-numeric-card" }
  );
  const response = await mcpRequest(
    mcpHandler,
    auth,
    "order_submit",
    personalSubmitArgs(
      preview.result.structuredContent.submit_context,
      {
        type: "card",
        brand: "Visa",
        last4: "4242"
      }
    ),
    2
  );

  assert.equal(response.result.isError, undefined, JSON.stringify(response));
  assert.equal(
    response.result.structuredContent.order_uuid,
    "order-numeric-card"
  );
});

test("a selected budget without team_id yields a usable personal context", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = purchaseAuth(store);
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "order" && args[1] === "preview") {
        return cliResult(
          previewResult({
            cartUuid: "cart-no-team",
            remainingCents: 4000,
            teamId: undefined,
            budgetId: "budget-1",
            teamAccountId: "account-1"
          })
        );
      }
      if (args[0] === "order" && args[1] === "submit") {
        return cliResult({
          success: true,
          order_uuid: "order-no-team"
        });
      }
      if (args[0] === "order" && args[1] === "status") {
        return cliResult({
          order: {
            order_uuid: "order-no-team",
            status: "successful"
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

  const preview = await mcpRequest(
    mcpHandler,
    auth,
    "preview_order",
    {
      cart_uuid: "cart-no-team",
      budget_id: "budget-1"
    }
  );
  const body = preview.result.structuredContent;
  assert.equal(body.submit_context.budget_id, undefined);
  assert.match(
    body.warnings.join(" "),
    /work budgets without team_id/
  );

  const response = await mcpRequest(
    mcpHandler,
    auth,
    "order_submit",
    personalSubmitArgs(body.submit_context),
    2
  );
  assert.equal(response.result.isError, undefined, JSON.stringify(response));
  assert.equal(response.result.structuredContent.order_uuid, "order-no-team");
});

test("cart mutations cannot enter between submit revalidation and purchase", async (t) => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const auth = purchaseAuth(store);
  const calls = [];
  let previewCalls = 0;
  let releaseRevalidation;
  let markRevalidationStarted;
  const revalidationStarted = new Promise((resolve) => {
    markRevalidationStarted = resolve;
  });
  const holdRevalidation = new Promise((resolve) => {
    releaseRevalidation = resolve;
  });
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "order" && args[1] === "preview") {
        previewCalls += 1;
        if (previewCalls === 2) {
          markRevalidationStarted();
          await holdRevalidation;
        }
        return cliResult(previewResult({ cartUuid: "cart-locked" }));
      }
      if (args[0] === "order" && args[1] === "submit") {
        return cliResult({
          success: true,
          order_uuid: "order-locked"
        });
      }
      if (args[0] === "order" && args[1] === "status") {
        return cliResult({
          order: {
            order_uuid: "order-locked",
            status: "successful"
          }
        });
      }
      if (args[0] === "cart" && args[1] === "remove-item") {
        throw new Error("remove_cart_item must not reach the CLI.");
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  t.after(async () => {
    await mcpHandler.close();
    store.close();
  });

  const preview = await mcpRequest(
    mcpHandler,
    auth,
    "preview_order",
    { cart_uuid: "cart-locked" }
  );
  const submitting = mcpRequest(
    mcpHandler,
    auth,
    "order_submit",
    personalSubmitArgs(preview.result.structuredContent.submit_context),
    2
  );
  await revalidationStarted;

  const mutation = await mcpRequest(
    mcpHandler,
    auth,
    "remove_cart_item",
    {
      cart_uuid: "cart-locked",
      cart_item_id: "line-1"
    },
    3
  );
  assert.equal(mutation.result.isError, true);
  assert.equal(
    mutation.result.structuredContent.error.code,
    "CHECKOUT_STATE_CHANGE_IN_PROGRESS"
  );
  assert.equal(
    mutation.result.structuredContent.error.recovery_tool,
    "show_cart"
  );
  assert.equal(commandCount(calls, "cart", "remove-item"), 0);

  releaseRevalidation();
  const submitted = await submitting;
  assert.equal(submitted.result.isError, undefined, JSON.stringify(submitted));
  assert.equal(submitted.result.structuredContent.order_uuid, "order-locked");
});
