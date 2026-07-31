import { requireBearerAuth } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";

import { ActivityLog } from "./activity-log.js";
import { createAdminAuth } from "./admin-auth.js";
import { createTokenVerifier } from "./auth.js";
import {
  listAddressesArgs,
  listPaymentMethodsArgs,
  orderStatusArgs,
  previewOrderArgs,
  submitOrderArgs
} from "./command-args.js";
import {
  DoorDashCliError,
  assertGenericCommandAllowed,
  buildCliArguments,
  extractCliStructuredContent,
  runDoorDashCli
} from "./dd-cli.js";
import {
  redactForActivity,
  sanitizeCommandForActivity
} from "./projections.js";
import {
  contractForCommand,
  contracts,
  errorEnvelope,
  projectWithContract,
  toToolResult
} from "./response-contract.js";
import { registerDoorDashTools } from "./tools.js";

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(SOURCE_DIR, "..", "public");
const LOGIN_PATH = path.join(PUBLIC_DIR, "login.html");
const LOGIN_SCRIPT_PATH = path.join(PUBLIC_DIR, "login.js");
const STYLES_PATH = path.join(PUBLIC_DIR, "styles.css");
const SERVER_VERSION = "0.3.0";
const TERMINAL_ORDER_STATUSES = new Set([
  "successful",
  "action_required",
  "failed",
  "not_found"
]);

function safeErrorResult(error) {
  const details =
    error instanceof DoorDashCliError
      ? redactForActivity(error.details)
      : {};
  return {
    error: error instanceof Error ? error.message : String(error),
    ...details
  };
}

function toolError(error, contract) {
  return toToolResult(errorEnvelope(contract, error), { isError: true });
}

function activityErrorResult(error, contract) {
  if (!contract) {
    return safeErrorResult(error);
  }
  try {
    return errorEnvelope(contract, error);
  } catch {
    return safeErrorResult(error);
  }
}

function normalizedAddress(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/,\s*usa$/, "")
    .replace(/\s+/g, " ");
}

function quoteTotalCents(preview) {
  return (
    preview?.quote?.total_before_tip?.unit_amount ??
    preview?.quote?.net_total_before_tip?.unit_amount ??
    null
  );
}

function quoteAddress(preview) {
  return preview?.quote?.delivery_address?.printable_address || null;
}

function defaultAddressCoordinates(addressList) {
  const defaultAddress = addressList?.addresses?.find(
    (address) => address.is_default === true
  );
  if (!defaultAddress) {
    throw new DoorDashCliError(
      "DoorDash did not identify a default saved address. Pass lat and lng together, or set a default address first."
    );
  }

  if (
    !Number.isFinite(defaultAddress.latitude) ||
    !Number.isFinite(defaultAddress.longitude)
  ) {
    throw new DoorDashCliError(
      "The default DoorDash address has no usable coordinates. Pass lat and lng together, or update the default address in DoorDash."
    );
  }

  return {
    lat: defaultAddress.latitude,
    lng: defaultAddress.longitude
  };
}

function statusValue(statusResult) {
  const status = (
    statusResult?.status ||
    statusResult?.order_status ||
    statusResult?.order?.status ||
    statusResult?.order?.order_status ||
    statusResult?.result?.status ||
    statusResult?.result?.order_status ||
    statusResult?.result?.order?.status ||
    statusResult?.result?.order?.order_status ||
    null
  );
  return status ? String(status).toLowerCase() : null;
}

function orderUuidFromSubmit(submitResult) {
  return (
    submitResult?.order_uuid ||
    submitResult?.orderUuid ||
    submitResult?.order?.order_uuid ||
    null
  );
}

function requireJson(req, res, next) {
  if (!req.is("application/json")) {
    res.status(415).json({ error: "Content-Type must be application/json." });
    return;
  }
  next();
}

function applySecurityHeaders(_req, res, next) {
  res.set({
    "Content-Security-Policy":
      "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  });
  next();
}

function assertCurrentPurchaseAccess(securityStore, authInfo) {
  const current = securityStore.verifyToken(authInfo?.token);
  if (!current?.allowPurchases) {
    throw new DoorDashCliError(
      "This bearer token does not allow checkout or card details. Enable its checkbox in the local UI."
    );
  }
  return current;
}

function validateWorkPayment(input, preview) {
  const hasTeamId = Boolean(input.teamId);
  const hasBudgetId = Boolean(input.budgetId);
  if (hasTeamId !== hasBudgetId) {
    throw new DoorDashCliError("teamId and budgetId must be provided together.");
  }

  if (!hasTeamId) {
    if (input.paymentConfirmation.type === "work_budget") {
      throw new DoorDashCliError(
        "Work-budget confirmation requires teamId and budgetId."
      );
    }
    return;
  }

  if (input.paymentConfirmation.type !== "work_budget") {
    throw new DoorDashCliError(
      "A work-budget submission requires a work_budget payment confirmation."
    );
  }

  const quoteTeamId =
    preview?.quote?.company_payment_info?.team_order_info?.team_id;
  if (quoteTeamId && quoteTeamId !== input.teamId) {
    throw new DoorDashCliError("The work-benefits team changed since confirmation.");
  }

  const budgets =
    preview?.quote?.expense_order_options
      ?.all_eligible_expense_order_budgets || [];
  const budget = budgets.find((entry) => entry.id === input.budgetId);
  if (
    budget?.name &&
    budget.name.trim().toLowerCase() !==
      input.paymentConfirmation.budgetName.trim().toLowerCase()
  ) {
    throw new DoorDashCliError("The selected work budget name no longer matches.");
  }
}

function validateCardPayment(input, paymentMethods) {
  if (input.paymentConfirmation.type === "account_default") {
    return;
  }

  if (input.paymentConfirmation.type !== "card") {
    throw new DoorDashCliError(
      "Personal checkout requires a card or account-default confirmation."
    );
  }

  const defaultId = paymentMethods?.default_payment_method_id;
  const defaultCard = (paymentMethods?.cards || []).find(
    (card) => card.payment_method_id === defaultId
  );
  if (!defaultCard) {
    throw new DoorDashCliError(
      "DoorDash did not expose a default card. Use account_default confirmation only after the user explicitly accepts the unseen account default, or use browser checkout."
    );
  }

  if (
    String(defaultCard.last4) !== input.paymentConfirmation.last4 ||
    String(defaultCard.brand || "").trim().toLowerCase() !==
      input.paymentConfirmation.brand.trim().toLowerCase()
  ) {
    throw new DoorDashCliError(
      "The default card changed since confirmation. Preview the payment methods again."
    );
  }
}

export function createDoorDashApp({
  securityStore,
  adminAccessToken,
  cliTimeoutMs = 120_000,
  runCli = runDoorDashCli,
  activityLog = new ActivityLog({ capacity: 100 }),
  startedAt = new Date(),
  pollDelay = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds))
}) {
  if (!securityStore) {
    throw new Error("createDoorDashApp requires securityStore.");
  }

  async function executeCli(
    args,
    {
      allowPurchases = false,
      generic = false,
      project = (data) => data,
      activityProject = project,
      activityContract = null
    } = {}
  ) {
    const command = buildCliArguments(args);
    const pending = activityLog.start(sanitizeCommandForActivity(command));

    try {
      if (generic) {
        assertGenericCommandAllowed(args);
      }

      const execution = await runCli(args, {
        allowPurchases,
        timeoutMs: cliTimeoutMs
      });
      const data = extractCliStructuredContent(execution);
      const output = project(data);
      activityLog.succeed(
        pending,
        redactForActivity(activityProject(data))
      );
      return output;
    } catch (error) {
      activityLog.fail(
        pending,
        redactForActivity(activityErrorResult(error, activityContract))
      );
      throw error;
    }
  }

  async function invoke(args, options = {}, authInfo) {
    const contract = options.contract || contractForCommand(args);
    try {
      if (options.requiresPurchaseAccess) {
        assertCurrentPurchaseAccess(securityStore, authInfo);
      }
      const projected = await executeCli(args, {
        ...options,
        project: (data) => projectWithContract(contract, data),
        activityProject: (data) => projectWithContract(contract, data),
        activityContract: contract
      });
      return toToolResult(projected);
    } catch (error) {
      return toolError(error, contract);
    }
  }

  async function invokeWithDefaultAddressLocation(
    input,
    buildArgs,
    authInfo
  ) {
    if (input.lat !== undefined && input.lng !== undefined) {
      return invoke(buildArgs(input), {}, authInfo);
    }

    try {
      const addresses = await executeCli(listAddressesArgs(), {
        project: (data) => projectWithContract(contracts.addresses, data),
        activityProject: (data) =>
          projectWithContract(contracts.addresses, data),
        activityContract: contracts.addresses
      });
      const coordinates = defaultAddressCoordinates(addresses);
      return invoke(
        buildArgs({
          ...input,
          ...coordinates
        }),
        {},
        authInfo
      );
    } catch (error) {
      return toolError(error, contracts.storeSearch);
    }
  }

  async function submitOrder(input, authInfo) {
    try {
      assertCurrentPurchaseAccess(securityStore, authInfo);

      const previewArgs = previewOrderArgs({
        cartUuid: input.cartUuid,
        scheduledTime: input.scheduledTime,
        fulfillment: input.fulfillment,
        priority: input.priority,
        includeWorkBenefits: Boolean(input.teamId || input.budgetId),
        selectedBudgetId: input.budgetId,
        applyCredits: input.applyCredits
      });
      const preview = await executeCli(previewArgs, {
        project: (data) => data,
        activityProject: (data) =>
          projectWithContract(contracts.orderPreview, data),
        activityContract: contracts.orderPreview
      });

      if (!preview?.success) {
        throw new DoorDashCliError(
          preview?.error_message || preview?.message || "Order preview failed."
        );
      }

      const currentTotal = quoteTotalCents(preview);
      if (currentTotal !== input.expectedTotalBeforeTipCents) {
        throw new DoorDashCliError(
          `Order total changed from ${input.expectedTotalBeforeTipCents} cents to ${currentTotal} cents. Review and confirm the new preview before submitting.`
        );
      }

      const currentAddress = quoteAddress(preview);
      if (
        normalizedAddress(currentAddress) !==
        normalizedAddress(input.expectedDeliveryAddress)
      ) {
        throw new DoorDashCliError(
          "The delivery address changed since confirmation. Review the new preview before submitting.",
          { currentDeliveryAddress: currentAddress }
        );
      }

      validateWorkPayment(input, preview);
      if (
        !input.teamId &&
        input.paymentConfirmation.type === "card"
      ) {
        const paymentMethods = await executeCli(listPaymentMethodsArgs(), {
          project: (data) => data,
          activityProject: (data) =>
            projectWithContract(contracts.paymentMethods, data),
          activityContract: contracts.paymentMethods
        });
        validateCardPayment(input, paymentMethods);
      }

      assertCurrentPurchaseAccess(securityStore, authInfo);
      if (!securityStore.beginSubmission(input.cartUuid)) {
        const attempt = securityStore.getSubmissionAttempt(input.cartUuid);
        throw new DoorDashCliError(
          "This cart already has a recorded submission attempt. Refusing to risk a duplicate charge.",
          {
            submissionStatus: attempt?.status || "unknown",
            orderUuid: attempt?.order_uuid || null
          }
        );
      }

      let submitted;
      try {
        submitted = await executeCli(submitOrderArgs(input), {
          allowPurchases: true,
          project: (data) => data,
          activityProject: (data) =>
            projectWithContract(contracts.orderSubmitAccepted, data),
          activityContract: contracts.orderSubmitAccepted
        });
      } catch (error) {
        securityStore.finishSubmission(input.cartUuid, {
          status: "unknown",
          errorMessage: error instanceof Error ? error.message : String(error)
        });
        throw new DoorDashCliError(
          "Order submission did not return a safe, retryable outcome. Do not submit this cart again; check order history/status or finish in the DoorDash app.",
          {
            cause: error instanceof Error ? error.message : String(error)
          }
        );
      }

      const orderUuid = orderUuidFromSubmit(submitted);
      if (submitted?.success === false) {
        securityStore.finishSubmission(input.cartUuid, {
          status: "failed",
          orderUuid,
          errorMessage:
            submitted.error_message || submitted.message || "Submission failed."
        });
        throw new DoorDashCliError(
          submitted.error_message || submitted.message || "Order submission failed."
        );
      }

      securityStore.finishSubmission(input.cartUuid, {
        status: "accepted",
        orderUuid
      });

      let finalStatus = null;
      let statusWarning = null;
      if (orderUuid) {
        try {
          for (let attempt = 0; attempt < 5; attempt += 1) {
            const statusResult = await executeCli(
              orderStatusArgs({ orderUuid }),
              {
                project: (data) => data,
                activityProject: (data) =>
                  projectWithContract(contracts.orderStatus, data),
                activityContract: contracts.orderStatus
              }
            );
            finalStatus = statusResult;
            const status = statusValue(statusResult);
            if (TERMINAL_ORDER_STATUSES.has(status)) {
              break;
            }
            if (status !== "pending") {
              break;
            }
            await pollDelay(1_000);
          }
        } catch (error) {
          statusWarning = `DoorDash accepted the submission, but status verification failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      } else {
        statusWarning =
          "DoorDash accepted the submission without returning an order UUID. Check order history before taking any further action.";
      }

      const terminalStatus = statusValue(finalStatus);
      if (terminalStatus) {
        securityStore.finishSubmission(input.cartUuid, {
          status: terminalStatus,
          orderUuid
        });
      }

      const warning =
        statusWarning ||
        (terminalStatus && terminalStatus !== "successful"
          ? "The order was submitted but is not confirmed successful. Follow the returned status instructions."
          : terminalStatus === "successful"
            ? null
            : "The order was submitted but is still pending. Check order_status before reporting success.");
      const projected = projectWithContract(contracts.orderSubmit, {
        submitted,
        preview,
        finalStatus,
        orderUuid,
        terminalStatus,
        tipCents: input.tipCents,
        payment: input.paymentConfirmation,
        warning
      });
      return toToolResult(projected);
    } catch (error) {
      return toolError(error, contracts.orderSubmit);
    }
  }

  function createDoorDashServer(factoryContext = {}) {
    const authInfo = factoryContext.authInfo;
    const server = new McpServer({
      name: "doordash-cli",
      version: SERVER_VERSION
    });

    registerDoorDashTools(server, {
      activityLog,
      authInfo,
      invoke: (args, options) => invoke(args, options, authInfo),
      invokeWithDefaultAddressLocation: (input, buildArgs) =>
        invokeWithDefaultAddressLocation(input, buildArgs, authInfo),
      submitOrder: (input) => submitOrder(input, authInfo),
      toolResult: (value, contract) =>
        toToolResult(projectWithContract(contract, value))
    });

    return server;
  }

  const mcpHandler = createMcpHandler(createDoorDashServer);
  const nodeHandler = toNodeHandler(mcpHandler);
  const app = express();
  app.use(express.json());
  const adminAuth = createAdminAuth({
    accessToken: adminAccessToken
  });
  const bearerAuth = requireBearerAuth({
    verifier: createTokenVerifier(securityStore),
    requiredScopes: ["doordash:tools"]
  });

  app.use(applySecurityHeaders);

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      service: "doordash-cli-mcp",
      version: SERVER_VERSION
    });
  });

  app.all("/mcp", bearerAuth, (req, res) => {
    void nodeHandler(req, res, req.body);
  });

  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.get("/styles.css", (_req, res) => {
    res.sendFile(STYLES_PATH);
  });

  app.get("/login.js", (_req, res) => {
    res.sendFile(LOGIN_SCRIPT_PATH);
  });

  app.get("/login", adminAuth.redirectAuthenticated, (_req, res) => {
    res.sendFile(LOGIN_PATH);
  });

  app.post("/api/admin/session", requireJson, adminAuth.login);
  app.delete(
    "/api/admin/session",
    adminAuth.requireAdmin,
    adminAuth.logout
  );

  app.use(adminAuth.requireAdmin);

  app.get("/api/status", (_req, res) => {
    res.json({
      ok: true,
      service: "doordash-cli-mcp",
      version: SERVER_VERSION,
      transport: "streamable-http",
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1_000),
      activityCount: activityLog.size,
      activityCapacity: 100,
      mcpAuthRequired: true,
      activeTokenCount: securityStore.activeTokenCount,
      purchaseTokenCount: securityStore.purchaseTokenCount
    });
  });

  app.get("/api/tokens", (_req, res) => {
    res.json({
      tokens: securityStore.listTokens()
    });
  });

  app.post("/api/tokens", requireJson, (req, res) => {
    const parsed = z
      .object({
        name: z.string().min(1).max(80),
        allowPurchases: z.boolean().default(false)
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid token request.",
        issues: parsed.error.issues
      });
      return;
    }

    const token = securityStore.createToken(parsed.data);
    res.status(201).json(token);
  });

  app.patch("/api/tokens/:id", requireJson, (req, res) => {
    const parsed = z
      .object({
        allowPurchases: z.boolean()
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid token update.",
        issues: parsed.error.issues
      });
      return;
    }

    const updated = securityStore.setPurchaseAccess(
      req.params.id,
      parsed.data.allowPurchases
    );
    if (!updated) {
      res.status(404).json({ error: "Token not found." });
      return;
    }

    mcpHandler.notify.toolsChanged();
    res.json({
      updated: true,
      tokens: securityStore.listTokens()
    });
  });

  app.delete("/api/tokens/:id", (req, res) => {
    const revoked = securityStore.revokeToken(req.params.id);
    if (!revoked) {
      res.status(404).json({ error: "Token not found." });
      return;
    }

    mcpHandler.notify.toolsChanged();
    res.json({ revoked: true });
  });

  app.get("/activity", (req, res) => {
    const requestedLimit = Number.parseInt(String(req.query.limit || "100"), 10);
    const limit = Number.isInteger(requestedLimit) ? requestedLimit : 100;
    res.json({
      count: activityLog.size,
      entries: activityLog.list(limit)
    });
  });

  app.use(
    express.static(PUBLIC_DIR, {
      etag: true,
      index: "index.html",
      maxAge: 0
    })
  );

  return {
    app,
    activityLog,
    mcpHandler
  };
}
