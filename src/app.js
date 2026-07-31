import { requireBearerAuth } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import express from "express";
import {
  createHash,
  createHmac,
  timingSafeEqual
} from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";

import { ActivityLog } from "./activity-log.js";
import { createAdminAuth } from "./admin-auth.js";
import { createTokenVerifier } from "./auth.js";
import {
  addCartItemsArgs,
  checkoutLinkArgs,
  itemDetailsArgs,
  listAddressesArgs,
  listCartsArgs,
  listOrdersArgs,
  listPaymentMethodsArgs,
  menuArgs,
  orderStatusArgs,
  previewOrderArgs,
  receiptArgs,
  restaurantItemDetailsArgs,
  reorderArgs,
  showCartArgs,
  storeDetailsArgs,
  submitOrderArgs
} from "./command-args.js";
import {
  DoorDashCliError,
  buildCliArguments,
  extractCliStructuredContent,
  runDoorDashCli
} from "./dd-cli.js";
import {
  contractForCommand,
  contracts,
  errorEnvelope,
  normalizeModifierGroupsForResolution,
  projectWithContract,
  toToolResult
} from "./response-contract.js";
import {
  resolveModifierSelections
} from "./modifier-resolution.js";
import { registerDoorDashTools } from "./tools.js";

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(SOURCE_DIR, "..", "public");
const LOGIN_PATH = path.join(PUBLIC_DIR, "login.html");
const LOGIN_SCRIPT_PATH = path.join(PUBLIC_DIR, "login.js");
const STYLES_PATH = path.join(PUBLIC_DIR, "styles.css");
const SERVER_VERSION = "0.5.1";
const TERMINAL_ORDER_STATUSES = new Set([
  "successful",
  "action_required",
  "failed",
  "not_found"
]);

function safeErrorResult(error) {
  const details =
    error instanceof DoorDashCliError
      ? error.details
      : {};
  return {
    error: error instanceof Error ? error.message : String(error),
    ...details
  };
}

function toolError(error, contract) {
  return toToolResult(errorEnvelope(contract, error), { isError: true });
}

function normalizedAddress(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/,\s*usa$/, "")
    .replace(/\s+/g, " ");
}

function normalizedTimestamp(value) {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : String(value);
}

function normalizedBudgetName(value) {
  return value ? String(value).trim().toLowerCase() : null;
}

function sortedJson(values) {
  return values.sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
}

function confirmedOptionState(options = []) {
  return sortedJson(
    options.map((option) => ({
      option_id: option.option_id || null,
      group_name: option.group_name || null,
      option_name: option.option_name || null,
      quantity: option.quantity ?? null,
      price: option.price ?? null,
      options: confirmedOptionState(option.options || [])
    }))
  );
}

function confirmedItemState(item) {
  return {
    item_id: item.item_id || null,
    cart_item_id: item.cart_item_id || null,
    name: item.name || null,
    quantity: item.quantity ?? null,
    price: item.price ?? null,
    purchase_type: item.purchase_type || null,
    measurement_unit: item.measurement_unit || null,
    increment: item.increment ?? null,
    selected_options: confirmedOptionState(item.selected_options || []),
    substitutions: sortedJson(
      (item.substitutions || []).map(confirmedItemState)
    )
  };
}

function selectedPreviewBudget(preview, budgetId) {
  if (!budgetId) {
    return undefined;
  }
  return preview.work_benefits?.eligible_budgets?.find(
    (budget) => budget.budget_id === budgetId
  );
}

function previewStateHash(preview, budgetId) {
  const budget = selectedPreviewBudget(preview, budgetId);
  const items = sortedJson(
    (preview.items || []).map(confirmedItemState)
  );
  const state = {
    store_id: preview.store?.store_id || null,
    items,
    work_budget: budget
      ? {
          team_id: preview.work_benefits?.team_id || null,
          budget_id: budget.budget_id,
          name: budget.name || null,
          remaining: budget.remaining ?? null,
          team_account_id: budget.team_account_id || null,
          expense_code_mode: budget.expense_code_mode || null,
          expense_note_required: budget.expense_note_required === true
        }
      : null
  };
  return createHash("sha256")
    .update(JSON.stringify(state), "utf8")
    .digest("base64url");
}

function previewConfirmationPayload({
  cartUuid,
  expectedTotalBeforeTip,
  expectedDeliveryAddress,
  scheduledTime,
  fulfillment,
  priority,
  applyCredits,
  pinHandoffRequired,
  budgetId,
  teamId,
  teamAccountId,
  budgetName,
  stateHash
}) {
  return {
    cart_uuid: cartUuid,
    expected_total_before_tip_cents: Math.round(
      Number(expectedTotalBeforeTip) * 100
    ),
    expected_delivery_address:
      expectedDeliveryAddress === null
        ? null
        : normalizedAddress(expectedDeliveryAddress),
    scheduled_time: normalizedTimestamp(scheduledTime),
    fulfillment,
    priority,
    apply_credits: applyCredits,
    pin_handoff_required: pinHandoffRequired,
    budget_id: budgetId || null,
    team_id: teamId || null,
    team_account_id: teamAccountId || null,
    budget_name: normalizedBudgetName(budgetName),
    state_hash: stateHash
  };
}

function projectedPreviewConfirmation(preview, stateHash) {
  const context = preview.submit_context;
  const budget = selectedPreviewBudget(preview, context.budget_id);
  return previewConfirmationPayload({
    cartUuid: context.cart_uuid,
    expectedTotalBeforeTip: context.expected_total_before_tip,
    expectedDeliveryAddress: context.expected_delivery_address,
    scheduledTime: context.scheduled_time,
    fulfillment: context.fulfillment,
    priority: context.priority,
    applyCredits: context.apply_credits,
    pinHandoffRequired: context.pin_handoff_required,
    budgetId: budget?.budget_id,
    teamId: budget ? preview.work_benefits?.team_id : undefined,
    teamAccountId: budget?.team_account_id,
    budgetName: budget?.name,
    stateHash
  });
}

function submittedPreviewConfirmation(input, stateHash) {
  const workPayment =
    input.paymentConfirmation?.type === "work_budget"
      ? input.paymentConfirmation
      : undefined;
  return previewConfirmationPayload({
    cartUuid: input.cartUuid,
    expectedTotalBeforeTip: input.expectedTotalBeforeTipCents / 100,
    expectedDeliveryAddress: input.expectedDeliveryAddress,
    scheduledTime: input.scheduledTime,
    fulfillment: input.fulfillment,
    priority: input.priority,
    applyCredits: input.applyCredits,
    pinHandoffRequired: input.pinHandoffRequired,
    budgetId: input.budgetId,
    teamId: input.teamId,
    teamAccountId: input.teamAccountId,
    budgetName: workPayment?.budgetName,
    stateHash
  });
}

function previewSignature(signingKey, payload) {
  return createHmac("sha256", signingKey)
    .update(JSON.stringify(payload), "utf8")
    .digest("base64url");
}

function createPreviewToken(signingKey, preview) {
  const stateHash = previewStateHash(
    preview,
    preview.submit_context?.budget_id
  );
  const payload = projectedPreviewConfirmation(preview, stateHash);
  return `${stateHash}.${previewSignature(signingKey, payload)}`;
}

function validPreviewToken(signingKey, input) {
  const [stateHash, suppliedSignature, ...extra] = String(
    input.previewToken || ""
  ).split(".");
  if (
    extra.length ||
    stateHash?.length !== 43 ||
    suppliedSignature?.length !== 43
  ) {
    return false;
  }
  const payload = submittedPreviewConfirmation(input, stateHash);
  const expectedSignature = previewSignature(signingKey, payload);
  const supplied = Buffer.from(suppliedSignature, "base64url");
  const expected = Buffer.from(expectedSignature, "base64url");
  return (
    supplied.length === expected.length &&
    timingSafeEqual(supplied, expected)
  );
}

function previewRecoveryArguments(input) {
  return {
    cart_uuid: input.cartUuid,
    ...(input.scheduledTime
      ? { scheduled_time: input.scheduledTime }
      : {}),
    fulfillment: input.fulfillment,
    priority: input.priority,
    include_work_benefits: true,
    ...(input.budgetId ? { budget_id: input.budgetId } : {}),
    apply_credits: input.applyCredits
  };
}

function defaultAddressCoordinates(addressList) {
  const defaultAddress = addressList?.addresses?.find(
    (address) => address.is_default === true
  );
  if (!defaultAddress) {
    throw new DoorDashCliError(
      "DoorDash did not identify a default saved address. Call list_addresses, ask the user which saved address to use, then call set_default_address with explicit confirmation.",
      { code: "DEFAULT_ADDRESS_MISSING" }
    );
  }

  if (
    !Number.isFinite(defaultAddress.latitude) ||
    !Number.isFinite(defaultAddress.longitude)
  ) {
    throw new DoorDashCliError(
      "The default DoorDash address has no usable coordinates. Update that address in DoorDash before searching again.",
      { code: "DEFAULT_ADDRESS_COORDINATES_MISSING" }
    );
  }

  return {
    lat: defaultAddress.latitude,
    lng: defaultAddress.longitude
  };
}

function normalizedChoiceText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function returnedRestaurantMenuId(data) {
  const source =
    data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const candidates = [
    source.menu_id,
    source.menuId,
    source.store?.menu_id,
    source.store?.menuId,
    source.item?.menu_id,
    source.item?.menuId
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) {
      const value = String(candidate).trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function rawItemDetails(data) {
  const source =
    data && typeof data === "object" && !Array.isArray(data)
      ? data
      : {};
  if (source.success === false || source.success === "false") {
    throw new DoorDashCliError(
      String(
        source.error_message ||
          source.fail_reason ||
          source.message ||
          source.error?.message ||
          "DoorDash item lookup failed."
      ),
      {
        code:
          source.error_reason ||
          source.code ||
          source.error?.code ||
          "DOORDASH_OPERATION_FAILED"
      }
    );
  }
  const item =
    source.item &&
    typeof source.item === "object" &&
    !Array.isArray(source.item)
      ? source.item
      : source;
  const itemId = item.item_id ?? item.menu_item_id ?? item.id;
  const name = item.name ?? item.item_name;
  if (itemId === undefined || itemId === null || !String(itemId).trim() || !name) {
    throw new DoorDashCliError(
      "DoorDash item details did not contain item_id and name.",
      {
        code: "UPSTREAM_SCHEMA_ERROR",
        itemLookupEndpointMismatch: true
      }
    );
  }
  const available =
    item.available === false ||
    item.is_available === false ||
    item.in_stock === false
      ? false
      : undefined;
  return {
    item_id: String(itemId),
    name: String(name),
    available
  };
}

function canRetryItemLookupOnRestaurantEndpoint(error) {
  const codes = [
    error?.code,
    error?.details?.code,
    error?.details?.data?.code,
    error?.details?.data?.error_reason,
    error?.details?.data?.error?.code
  ]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value).trim().toUpperCase());
  if (
    error?.details?.itemLookupEndpointMismatch === true ||
    codes.some(
      (code) =>
        code === "NOT_FOUND" ||
        code.endsWith("_ITEM_NOT_FOUND") ||
        code === "ITEM_NOT_FOUND"
    )
  ) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error || "");
  return /\b(?:not (?:a )?(?:retail|grocery) item|item (?:was )?not found|no (?:such|matching) item|unknown item)\b/i.test(
    message
  );
}

function rawCartReference(value) {
  const wrapper =
    value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  const cart =
    wrapper.cart &&
    typeof wrapper.cart === "object" &&
    !Array.isArray(wrapper.cart)
      ? wrapper.cart
      : wrapper;
  const cartUuid =
    cart.cart_uuid ?? cart.uuid ?? cart.id ?? wrapper.cart_uuid;
  const storeId =
    cart.store_id ??
    cart.store?.store_id ??
    cart.store?.id ??
    wrapper.store_id;
  const items = Array.isArray(cart.items)
    ? cart.items
    : Array.isArray(wrapper.items)
      ? wrapper.items
      : undefined;
  return {
    cart_uuid:
      cartUuid === undefined || cartUuid === null
        ? undefined
        : String(cartUuid),
    store_id:
      storeId === undefined || storeId === null
        ? undefined
        : String(storeId),
    items
  };
}

function comparableItemId(value) {
  return String(value || "").replace(/^i_/, "");
}

function selectedOptionsComparisonKey(options) {
  const normalized = (Array.isArray(options) ? options : [])
    .map((option) => {
      const nested = JSON.parse(
        selectedOptionsComparisonKey(option.options)
      );
      return {
        option_id: option.option_id || null,
        option_name: option.option_name || null,
        group_name: option.group_name || null,
        quantity: Number(option.quantity ?? 1),
        ...(nested.length ? { options: nested } : {})
      };
    })
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
  return JSON.stringify(normalized);
}

function itemComparisonSummary(items) {
  const summary = new Map();
  for (const item of items) {
    const itemId = comparableItemId(item.item_id);
    if (!itemId) {
      continue;
    }
    const current = summary.get(itemId) || {
      name: item.name || item.item_id,
      quantity: 0,
      variants: new Map()
    };
    const quantity = Number(item.quantity ?? 1);
    const variant = selectedOptionsComparisonKey(item.selected_options);
    current.quantity += quantity;
    current.variants.set(
      variant,
      (current.variants.get(variant) || 0) + quantity
    );
    summary.set(itemId, current);
  }
  return summary;
}

function variantSummariesMatch(left, right) {
  const leftTotal = [...left.values()].reduce(
    (total, quantity) => total + quantity,
    0
  );
  const rightTotal = [...right.values()].reduce(
    (total, quantity) => total + quantity,
    0
  );
  return (
    left.size === right.size &&
    [...left].every(([variant, quantity]) =>
      right.has(variant) &&
      quantity * rightTotal === right.get(variant) * leftTotal
    )
  );
}

function reorderComparisonWarnings(sourceItems = [], cartItems = []) {
  const cartById = itemComparisonSummary(cartItems);
  const sourceById = itemComparisonSummary(sourceItems);
  const warnings = [];

  for (const [itemId, source] of sourceById) {
    const current = cartById.get(itemId);
    if (!current) {
      warnings.push(
        `${source.name || itemId} was present in the source order but is missing from the reordered cart.`
      );
      continue;
    }
    const sourceQuantity = source.quantity;
    const currentQuantity = current.quantity;
    if (sourceQuantity !== currentQuantity) {
      warnings.push(
        `${source.name || itemId} changed from quantity ${sourceQuantity} in history to ${currentQuantity} in the reordered cart.`
      );
    }
    if (!variantSummariesMatch(source.variants, current.variants)) {
      warnings.push(
        `${source.name || itemId} has different modifier selections in the reordered cart than in the source order.`
      );
    }
  }

  for (const [itemId, current] of cartById) {
    if (!sourceById.has(itemId)) {
      warnings.push(
        `${current.name || itemId} appears in the reordered cart but not in the source order.`
      );
    }
  }
  return warnings;
}

function filterMenuByQuery(data, query) {
  const normalizedQuery = normalizedChoiceText(query);
  if (!normalizedQuery || !data || typeof data !== "object") {
    return data;
  }
  const compactQuery = normalizedQuery.replace(/\s+/g, "");
  const queryWordList = normalizedQuery.split(/\s+/);
  const queryWords = new Set(queryWordList);
  const matches = (item) => {
    const normalizedName = normalizedChoiceText(
      item?.name || item?.title || ""
    );
    const normalizedItem = normalizedChoiceText(
      `${normalizedName} ${item?.description || ""}`
    );
    const compactName = normalizedName.replace(/\s+/g, "");
    const itemWords = new Set(normalizedItem.split(/\s+/));
    const nameWords = normalizedName.split(/\s+/).filter(Boolean);
    const queryWordsInItem = queryWordList.every((word) =>
      itemWords.has(word)
    );
    const queryContainsWholeName =
      nameWords.length > 0 &&
      nameWords.every((word) => queryWords.has(word));
    const compactNameContainsQuery =
      compactQuery.length >= 4 &&
      compactName.includes(compactQuery);
    const compactQueryContainsName =
      compactName.length >= 4 &&
      compactQuery.includes(compactName) &&
      compactName.length / compactQuery.length >= 0.6;
    return (
      queryWordsInItem ||
      compactNameContainsQuery ||
      queryContainsWholeName ||
      compactQueryContainsName
    );
  };
  return {
    ...data,
    mcp_query: String(query).trim(),
    items: Array.isArray(data.items)
      ? data.items.filter(matches)
      : Array.isArray(data.categories)
        ? data.categories.flatMap((category) =>
            Array.isArray(category?.items)
              ? category.items.filter(matches)
              : []
          )
        : [],
    ...(Array.isArray(data.categories)
      ? {
          categories: data.categories
            .map((category) => ({
              ...category,
              ...(Array.isArray(category?.items)
                ? { items: category.items.filter(matches) }
                : {})
            }))
            .filter(
              (category) =>
                !Array.isArray(category.items) || category.items.length > 0
            )
        }
      : {})
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
  const value =
    submitResult?.order_uuid ||
    submitResult?.orderUuid ||
    submitResult?.order?.order_uuid ||
    null;
  if (
    typeof value !== "string" &&
    (typeof value !== "number" || !Number.isFinite(value))
  ) {
    return null;
  }
  return String(value).trim() || null;
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

function validateWorkPayment(input, preview, previewArguments) {
  const changedDetails = {
    code: "WORK_BUDGET_CHANGED",
    cartUuid: input.cartUuid,
    previewArguments
  };
  const hasTeamId = Boolean(input.teamId);
  const hasBudgetId = Boolean(input.budgetId);
  if (hasTeamId !== hasBudgetId) {
    throw new DoorDashCliError(
      "team_id and budget_id must be copied together from the same preview.",
      changedDetails
    );
  }

  if (!hasTeamId) {
    if (input.paymentConfirmation.type === "work_budget") {
      throw new DoorDashCliError(
        "Work-budget confirmation requires team_id and budget_id from the same preview.",
        changedDetails
      );
    }
    return;
  }

  if (input.paymentConfirmation.type !== "work_budget") {
    throw new DoorDashCliError(
      "A work-budget submission requires a work_budget payment confirmation.",
      changedDetails
    );
  }

  const quoteTeamId =
    preview?.quote?.company_payment_info?.team_order_info?.team_id;
  if (quoteTeamId && String(quoteTeamId) !== String(input.teamId)) {
    throw new DoorDashCliError(
      "The work-benefits team changed since confirmation.",
      changedDetails
    );
  }

  const budgets =
    preview?.quote?.expense_order_options
      ?.all_eligible_expense_order_budgets || [];
  const budget = budgets.find(
    (entry) => String(entry.id) === String(input.budgetId)
  );
  if (!budget) {
    throw new DoorDashCliError(
      "The selected work budget is no longer eligible. Review a new preview.",
      changedDetails
    );
  }
  if (
    budget.name !== undefined &&
    String(budget.name).trim().toLowerCase() !==
      input.paymentConfirmation.budgetName.trim().toLowerCase()
  ) {
    throw new DoorDashCliError(
      "The selected work budget name no longer matches.",
      changedDetails
    );
  }
  const teamAccountId = budget.team_account_id;
  if (
    teamAccountId &&
    String(teamAccountId) !== String(input.teamAccountId || "")
  ) {
    throw new DoorDashCliError(
      "Copy team_account_id from the selected work budget.",
      changedDetails
    );
  }
  const expenseCodeRequired =
    String(budget.expense_code_mode || "").trim().toLowerCase() ===
    "required";
  if (expenseCodeRequired && !input.expenseCode) {
    throw new DoorDashCliError(
      "The selected work budget requires expense_code. Ask the user for it, then call order_submit once with the same confirmed fields plus expense_code.",
      {
        code: "WORK_EXPENSE_DETAILS_REQUIRED",
        cartUuid: input.cartUuid
      }
    );
  }
  const expenseNoteRequired =
    budget.is_expense_note_required === true ||
    String(budget.is_expense_note_required || "").trim().toLowerCase() ===
      "true";
  if (expenseNoteRequired && !input.expenseNotes) {
    throw new DoorDashCliError(
      "The selected work budget requires expense_notes. Ask the user for them, then call order_submit once with the same confirmed fields plus expense_notes.",
      {
        code: "WORK_EXPENSE_DETAILS_REQUIRED",
        cartUuid: input.cartUuid
      }
    );
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
    (card) =>
      (defaultId !== undefined &&
        defaultId !== null &&
        card.payment_method_id !== undefined &&
        card.payment_method_id !== null &&
        String(card.payment_method_id) === String(defaultId)) ||
      ((defaultId === undefined || defaultId === null) &&
        card.is_default === true)
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
      "The default card changed since confirmation. Call list_payment_methods and ask the user to confirm the current default card.",
      { code: "PAYMENT_METHOD_CHANGED" }
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
  const previewSigningKey = createHash("sha256")
    .update(`doordash-mcp-preview-v1:${adminAccessToken}`, "utf8")
    .digest();
  const inFlightCartWrites = new Set();
  let activeCheckoutStateChange = null;

  function acquireCheckoutStateChange({
    operation,
    cartUuid,
    stateScope
  }) {
    if (activeCheckoutStateChange) {
      throw new DoorDashCliError(
        `Cannot start ${operation} while ${activeCheckoutStateChange.operation} is still changing checkout state. Wait for that call's result, then inspect state once; do not run either change again blindly.`,
        {
          code: "CHECKOUT_STATE_CHANGE_IN_PROGRESS",
          cartUuid,
          stateScope
        }
      );
    }
    const token = Symbol(operation);
    activeCheckoutStateChange = { token, operation };
    return token;
  }

  function releaseCheckoutStateChange(token) {
    if (activeCheckoutStateChange?.token === token) {
      activeCheckoutStateChange = null;
    }
  }

  function projectSignedPreview(data, input) {
    const projected = projectWithContract(contracts.orderPreview, {
      ...data,
      mcp_preview_token: "pending",
      mcp_preview_options: {
        scheduled_time: input.scheduledTime,
        fulfillment: input.fulfillment,
        priority: input.priority,
        apply_credits: input.applyCredits,
        budget_id: input.budgetId
      }
    });
    const previewToken = createPreviewToken(previewSigningKey, projected);
    return contracts.orderPreview.successSchema.parse({
      ...projected,
      submit_context: {
        ...projected.submit_context,
        preview_token: previewToken
      }
    });
  }

  async function executeCli(
    args,
    {
      allowPurchases = false,
      project = (data) => data
    } = {}
  ) {
    const command = buildCliArguments(args);
    const pending = activityLog.start(command);
    let data;

    try {
      const execution = await runCli(args, {
        allowPurchases,
        timeoutMs: cliTimeoutMs
      });
      data = extractCliStructuredContent(execution);
      const output = project(data);
      activityLog.succeed(pending, data);
      return output;
    } catch (error) {
      activityLog.fail(
        pending,
        data === undefined
          ? safeErrorResult(error)
          : {
              data,
              projection_error: safeErrorResult(error)
            }
      );
      throw error;
    }
  }

  async function inspectActiveCarts(storeId) {
    const rawCartList = await executeCli(
      listCartsArgs({ storeId }),
      { project: (data) => data }
    );
    projectWithContract(contracts.cartList, rawCartList);
    if (
      rawCartList.truncated === true ||
      (typeof rawCartList.truncated === "string" &&
        rawCartList.truncated.trim().toLowerCase() === "true")
    ) {
      throw new DoorDashCliError(
        "DoorDash returned a truncated active-cart list, so existing same-store cart contents cannot be ruled out. No cart mutation was attempted.",
        {
          code: "ACTIVE_CART_STATE_UNKNOWN",
          storeId
        }
      );
    }

    const carts = [];
    for (const rawCart of rawCartList.carts) {
      const reference = rawCartReference(rawCart);
      if (reference.store_id && reference.store_id !== storeId) {
        continue;
      }
      if (!reference.cart_uuid) {
        throw new DoorDashCliError(
          "DoorDash listed an active cart without the cart_uuid needed to inspect it. No cart mutation was attempted.",
          {
            code: "ACTIVE_CART_STATE_UNKNOWN",
            storeId
          }
        );
      }

      try {
        const cart = reference.items
          ? projectWithContract(contracts.cart, rawCart)
          : await executeCli(
              showCartArgs({ cartUuid: reference.cart_uuid }),
              {
                project: (data) =>
                  projectWithContract(contracts.cart, data)
              }
            );
        if (cart.cart_uuid !== reference.cart_uuid) {
          throw new DoorDashCliError(
            `DoorDash returned cart ${cart.cart_uuid} while inspecting active cart ${reference.cart_uuid}.`,
            { code: "UPSTREAM_SCHEMA_ERROR" }
          );
        }
        if (cart.store?.store_id && cart.store.store_id !== storeId) {
          throw new DoorDashCliError(
            `DoorDash returned store ${cart.store.store_id} while inspecting carts for store ${storeId}.`,
            { code: "UPSTREAM_SCHEMA_ERROR" }
          );
        }
        carts.push(cart);
      } catch (error) {
        throw new DoorDashCliError(
          `DoorDash listed active cart ${reference.cart_uuid}, but its contents could not be verified. No cart mutation was attempted.`,
          {
            code: "ACTIVE_CART_STATE_UNKNOWN",
            cartUuid: reference.cart_uuid,
            storeId,
            cause: error instanceof Error ? error.message : String(error)
          }
        );
      }
    }
    return carts;
  }

  async function invoke(args, options = {}, authInfo) {
    const contract = options.contract || contractForCommand(args);
    const transform = options.transform || ((data) => data);
    let stateChangeToken;
    try {
      if (options.requiresPurchaseAccess) {
        assertCurrentPurchaseAccess(securityStore, authInfo);
      }
      if (options.stateMutation) {
        stateChangeToken = acquireCheckoutStateChange(
          options.stateMutation
        );
      }
      const projected = await executeCli(args, {
        ...options,
        project: (data) => projectWithContract(contract, transform(data))
      });
      return toToolResult(projected);
    } catch (error) {
      const isLockConflict =
        error?.details?.code === "CHECKOUT_STATE_CHANGE_IN_PROGRESS";
      const isConfirmedFailure =
        error?.name === "DoorDashOperationError";
      if (
        options.mutationOutcome &&
        !isLockConflict &&
        !isConfirmedFailure
      ) {
        const outcome = options.mutationOutcome;
        return toolError(
          new DoorDashCliError(outcome.message, {
            code: outcome.code,
            cartUuid: outcome.cartUuid,
            addressId: outcome.addressId,
            stateScope: outcome.stateScope,
            cause: error instanceof Error ? error.message : String(error)
          }),
          contract
        );
      }
      return toolError(error, contract);
    } finally {
      releaseCheckoutStateChange(stateChangeToken);
    }
  }

  async function invokeAtDefaultAddress(
    input,
    buildArgs,
    authInfo
  ) {
    try {
      const addresses = await executeCli(listAddressesArgs(), {
        project: (data) => projectWithContract(contracts.addresses, data)
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

  async function resolveRestaurantMenuId(input) {
    if (input.menuId) {
      return input.menuId;
    }

    let storeDetails;
    try {
      storeDetails = await executeCli(
        storeDetailsArgs({ storeId: input.storeId }),
        { project: (data) => data }
      );
    } catch {
      // Restaurant item details accepts store_id as its menu context.
    }
    const storeMenuId =
      storeDetails?.success === false || storeDetails?.success === "false"
        ? undefined
        : returnedRestaurantMenuId(storeDetails);
    if (storeMenuId) {
      return storeMenuId;
    }
    return input.storeId;
  }

  async function getItemDetails(input) {
    const restaurantItem =
      input.itemId.startsWith("i_") || Boolean(input.menuId);
    if (!restaurantItem) {
      try {
        const projected = await executeCli(itemDetailsArgs(input), {
          project: (data) =>
            projectWithContract(contracts.itemDetails, {
              ...data,
              mcp_option_queries: input.optionQueries,
              store:
                data?.store ||
                (data?.store_id
                  ? undefined
                  : { store_id: input.storeId })
            })
        });
        return toToolResult(projected);
      } catch (error) {
        return toolError(error, contracts.itemDetails);
      }
    }

    try {
      const menuId = await resolveRestaurantMenuId(input);
      const projected = await executeCli(
        restaurantItemDetailsArgs({
          storeId: input.storeId,
          menuId,
          itemId: input.itemId
        }),
        {
          project: (data) => {
            const responseMenuId =
              returnedRestaurantMenuId(data) || menuId;
            return projectWithContract(contracts.itemDetails, {
              ...data,
              menu_id: responseMenuId,
              mcp_option_queries: input.optionQueries,
              store:
                data?.store ||
                (data?.store_id
                  ? undefined
                  : { store_id: input.storeId })
            });
          }
        }
      );
      return toToolResult(projected);
    } catch (error) {
      return toolError(error, contracts.itemDetails);
    }
  }

  async function reorder(input) {
    let stateChangeToken;
    try {
      stateChangeToken = acquireCheckoutStateChange({
        operation: "reorder",
        stateScope: "carts"
      });
      const sourceOrder = await executeCli(
        receiptArgs({ orderUuid: input.orderUuid }),
        {
          project: (data) =>
            projectWithContract(contracts.receipt, {
              ...data,
              mcp_order_uuid: input.orderUuid
            })
        }
      );
      if (sourceOrder.order_uuid !== input.orderUuid) {
        throw new DoorDashCliError(
          `DoorDash returned receipt ${sourceOrder.order_uuid || "without an order_uuid"} while inspecting order ${input.orderUuid}. No reorder was attempted.`,
          { code: "UPSTREAM_SCHEMA_ERROR" }
        );
      }
      const storeId = sourceOrder.store?.store_id;
      if (!storeId) {
        throw new DoorDashCliError(
          "DoorDash did not return the source order's store_id. No reorder was attempted.",
          { code: "UPSTREAM_SCHEMA_ERROR" }
        );
      }

      const activeCarts = await inspectActiveCarts(storeId);
      const nonemptyCart = activeCarts.find(
        (cart) => cart.items.length > 0
      );
      if (nonemptyCart) {
        throw new DoorDashCliError(
          `A nonempty DoorDash cart already exists at this store (${nonemptyCart.cart_uuid}). No reorder was attempted. Inspect that cart before choosing whether to extend or replace it.`,
          {
            code: "ACTIVE_CART_EXISTS",
            cartUuid: nonemptyCart.cart_uuid,
            storeId
          }
        );
      }

      let reordered;
      try {
        reordered = await executeCli(
          reorderArgs({ orderUuid: input.orderUuid }),
          {
            project: (data) => projectWithContract(contracts.reorder, data)
          }
        );
      } catch (error) {
        if (error?.name === "DoorDashOperationError") {
          throw error;
        }
        throw new DoorDashCliError(
          "DoorDash did not confirm the new reorder cart_uuid. Never reorder this order again blindly. Call list_carts once and inspect the newest cart.",
          {
            code: "REORDER_OUTCOME_UNKNOWN",
            storeId,
            stateScope: "carts",
            cause: error instanceof Error ? error.message : String(error)
          }
        );
      }

      try {
        const hydrated = await executeCli(
          showCartArgs({ cartUuid: reordered.cart_uuid }),
          {
            project: (data) => projectWithContract(contracts.cart, data)
          }
        );
        if (hydrated.cart_uuid !== reordered.cart_uuid) {
          throw new DoorDashCliError(
            `DoorDash returned cart ${hydrated.cart_uuid} while hydrating reordered cart ${reordered.cart_uuid}.`,
            { code: "UPSTREAM_SCHEMA_ERROR" }
          );
        }
        if (
          hydrated.store?.store_id &&
          hydrated.store.store_id !== storeId
        ) {
          throw new DoorDashCliError(
            `DoorDash returned store ${hydrated.store.store_id} while hydrating a reorder for store ${storeId}.`,
            { code: "UPSTREAM_SCHEMA_ERROR" }
          );
        }
        const warnings = [
          ...(reordered.warnings || []),
          ...(hydrated.warnings || []),
          ...reorderComparisonWarnings(sourceOrder.items, hydrated.items)
        ];
        return toToolResult(
          contracts.reorder.successSchema.parse({
            ...hydrated,
            schema: reordered.schema,
            version: reordered.version,
            kind: "reorder",
            cart_uuid: reordered.cart_uuid,
            ...(warnings.length ? { warnings: [...new Set(warnings)] } : {})
          })
        );
      } catch (error) {
        throw new DoorDashCliError(
          `DoorDash created cart ${reordered.cart_uuid}, but its contents could not be verified. Call show_cart once with this cart_uuid; do not reorder again.`,
          {
            code: "REORDER_HYDRATION_FAILED",
            cartUuid: reordered.cart_uuid,
            storeId,
            cause: error instanceof Error ? error.message : String(error)
          }
        );
      }
    } catch (error) {
      return toolError(error, contracts.reorder);
    } finally {
      releaseCheckoutStateChange(stateChangeToken);
    }
  }

  async function getMenu(input) {
    try {
      const projected = await executeCli(menuArgs(input), {
        project: (data) =>
          projectWithContract(
            contracts.menu,
            filterMenuByQuery(data, input.query)
          )
      });
      return toToolResult(projected);
    } catch (error) {
      if (error?.name === "DoorDashOperationError") {
        try {
          const history = await executeCli(
            listOrdersArgs({ max: 25, days: 365 }),
            {
              project: (data) =>
                projectWithContract(contracts.orderList, data)
            }
          );
          const storeOrders = history.orders.filter(
            (order) => order.store?.store_id === input.storeId
          );
          const seenItemIds = new Set();
          const historicalItems = [];
          for (const order of storeOrders) {
            for (const item of order.items || []) {
              if (
                !item.item_id ||
                !item.name ||
                seenItemIds.has(item.item_id)
              ) {
                continue;
              }
              seenItemIds.add(item.item_id);
              historicalItems.push(item);
            }
          }
          const matchingItems = input.query
            ? historicalItems.filter(
                (item) =>
                  normalizedChoiceText(item.name) ===
                  normalizedChoiceText(input.query)
              )
            : historicalItems.slice(0, 5);
          const currentItems = [];
          const authoritativeMenuIds = new Set();
          for (const item of matchingItems.slice(0, 5)) {
            try {
              let authoritativeMenuId;
              const details = await executeCli(
                restaurantItemDetailsArgs({
                  storeId: input.storeId,
                  menuId: input.storeId,
                  itemId: item.item_id
                }),
                {
                  project: (data) => {
                    authoritativeMenuId = returnedRestaurantMenuId(data);
                    const responseMenuId =
                      authoritativeMenuId || input.storeId;
                    return projectWithContract(contracts.itemDetails, {
                      ...data,
                      menu_id: responseMenuId,
                      store:
                        data?.store || {
                          store_id: input.storeId,
                          menu_id: responseMenuId,
                          name: storeOrders[0]?.store?.name
                        }
                    });
                  }
                }
              );
              if (
                comparableItemId(details.item.item_id) !==
                  comparableItemId(item.item_id) ||
                normalizedChoiceText(details.item.name) !==
                  normalizedChoiceText(item.name) ||
                (input.query &&
                  normalizedChoiceText(details.item.name) !==
                    normalizedChoiceText(input.query))
              ) {
                continue;
              }
              if (authoritativeMenuId) {
                authoritativeMenuIds.add(authoritativeMenuId);
              }
              currentItems.push(details.item);
            } catch {
              // Keep checking other exact history matches.
            }
          }
          if (currentItems.length) {
            const effectiveMenuId =
              authoritativeMenuIds.size === 1
                ? [...authoritativeMenuIds][0]
                : input.storeId;
            const projected = projectWithContract(contracts.menu, {
              success: true,
              menu_id: effectiveMenuId,
              store: {
                store_id: input.storeId,
                menu_id: effectiveMenuId,
                name: storeOrders[0]?.store?.name
              },
              items: currentItems,
              truncated: true,
              warning: input.query
                ? "DoorDash's full-menu lookup failed. Returned current details for exact-name matches recovered from bounded recent order history, with at most five matches checked; this is not an exhaustive menu search. store_id is the effective restaurant menu context."
                : "DoorDash's full-menu lookup failed. Returned up to five current items recovered from recent order history; this is not the store's complete menu. store_id is the effective restaurant menu context."
            });
            return toToolResult(projected);
          }
        } catch {
          // Preserve the original full-menu operational failure below.
        }
      }
      return toolError(error, contracts.menu);
    }
  }

  async function previewOrder(input, authInfo) {
    let stateChangeToken;
    try {
      stateChangeToken = acquireCheckoutStateChange({
        operation: "preview_order",
        cartUuid: input.cartUuid,
        stateScope: "cart"
      });
      const projected = await executeCli(previewOrderArgs(input), {
        project: (data) => projectSignedPreview(data, input)
      });
      return toToolResult(projected);
    } catch (error) {
      if (
        error?.details?.code ===
          "CHECKOUT_STATE_CHANGE_IN_PROGRESS" ||
        error?.name === "DoorDashOperationError"
      ) {
        return toolError(error, contracts.orderPreview);
      }
      return toolError(
        new DoorDashCliError(
          "DoorDash did not confirm the preview result or final cart mode. Do not repeat the preview blindly. Call show_cart once, then preview the intended mode again only if needed.",
          {
            code: "PREVIEW_OUTCOME_UNKNOWN",
            cartUuid: input.cartUuid,
            cause: error instanceof Error ? error.message : String(error)
          }
        ),
        contracts.orderPreview
      );
    } finally {
      releaseCheckoutStateChange(stateChangeToken);
    }
  }

  async function preflightCartItems(input) {
    const items = [];
    const itemErrors = [];
    const itemIdsNeedingDetails = [
      ...new Set(
        input.items
          .filter(
            (item) =>
              item.itemId.startsWith("i_") ||
              item.requestedOptions?.length ||
              item.nestedOptions?.length
          )
          .map((item) => item.itemId)
      )
    ];
    if (itemIdsNeedingDetails.length === 0) {
      return { items: input.items, itemErrors };
    }

    const loadPreflightDetails = async (itemId, restaurantItem) => {
      const rawDetails = await executeCli(
        restaurantItem
          ? restaurantItemDetailsArgs({
              storeId: input.storeId,
              menuId: input.menuId,
              itemId
            })
          : itemDetailsArgs({
              storeId: input.storeId,
              itemId
            }),
        { project: (data) => data }
      );
      const details = rawItemDetails(rawDetails);
      return {
        ...details,
        modifier_groups: normalizeModifierGroupsForResolution(
          rawDetails?.item || rawDetails
        )
      };
    };

    const detailEntries = [];
    for (let index = 0; index < itemIdsNeedingDetails.length; index += 4) {
      detailEntries.push(
        ...await Promise.all(
          itemIdsNeedingDetails
            .slice(index, index + 4)
            .map(async (itemId) => {
              const itemRequests = input.items.filter(
                (item) => item.itemId === itemId
              );
              const restaurantItem =
                itemId.startsWith("i_") ||
                itemRequests.some(
                  (item) => item.requestedOptions?.length
                );
              let details;
              let detailsSource;
              if (restaurantItem) {
                details = await loadPreflightDetails(itemId, true);
                detailsSource = "restaurant";
              } else {
                try {
                  details = await loadPreflightDetails(itemId, false);
                  detailsSource = "retail";
                } catch (error) {
                  if (!canRetryItemLookupOnRestaurantEndpoint(error)) {
                    throw error;
                  }
                  details = await loadPreflightDetails(itemId, true);
                  detailsSource = "restaurant";
                }

                const expectedNames = new Set(
                  itemRequests.map((item) =>
                    normalizedChoiceText(item.itemName)
                  )
                );
                if (
                  detailsSource === "retail" &&
                  !expectedNames.has(normalizedChoiceText(details.name))
                ) {
                  try {
                    const restaurantDetails =
                      await loadPreflightDetails(itemId, true);
                    if (
                      expectedNames.has(
                        normalizedChoiceText(restaurantDetails.name)
                      )
                    ) {
                      details = restaurantDetails;
                      detailsSource = "restaurant";
                    }
                  } catch {
                    // Keep the successful retail details for the name error.
                  }
                }
              }
              return [itemId, details];
            })
        )
      );
    }
    const detailsByItemId = new Map(detailEntries);

    for (const [requestIndex, requestedItem] of input.items.entries()) {
      const details = detailsByItemId.get(requestedItem.itemId);
      if (!details) {
        items.push(requestedItem);
        continue;
      }
      if (details.available === false) {
        const unavailableItem = {
          ...requestedItem,
          itemId: details.item_id || requestedItem.itemId,
          itemName: details.name || requestedItem.itemName
        };
        items.push(unavailableItem);
        itemErrors.push({
          request: {
            request_index: requestIndex,
            item_id: unavailableItem.itemId,
            item_name: unavailableItem.itemName,
            quantity: requestedItem.quantity,
            nested_options: requestedItem.nestedOptions
          },
          message:
            "This item is currently unavailable. Do not retry this item; choose a different item or use DoorDash checkout."
        });
        continue;
      }

      const hasWrongName =
        normalizedChoiceText(requestedItem.itemName) !==
        normalizedChoiceText(details.name);
      const resolution = resolveModifierSelections(
        details.modifier_groups,
        {
          requestedOptions: requestedItem.requestedOptions,
          nestedOptions: requestedItem.nestedOptions
        }
      );
      if (hasWrongName) {
        resolution.problems.push(
          `name must exactly match "${details.name}". Put all choices in requested_options or nested_options.`
        );
      }
      const resolvedItem = {
        ...requestedItem,
        itemId: details.item_id || requestedItem.itemId,
        itemName: details.name || requestedItem.itemName,
        nestedOptions: resolution.selections
      };
      items.push(resolvedItem);

      if (resolution.problems.length) {
        itemErrors.push({
          request: {
            request_index: requestIndex,
            item_id: resolvedItem.itemId,
            item_name: resolvedItem.itemName,
            quantity: requestedItem.quantity,
            nested_options: resolvedItem.nestedOptions
          },
          message: resolution.problems.join(" "),
          modifier_groups: resolution.modifier_groups
        });
      }
    }

    return { items, itemErrors };
  }

  async function addCartItems(input) {
    const writeKey = `store:${input.storeId}`;
    if (inFlightCartWrites.has(writeKey)) {
      return toolError(
        new DoorDashCliError(
          "Another cart write is already in progress for this target. Do not repeat this add. Inspect the cart after the first call finishes.",
          {
            code: "CART_WRITE_IN_PROGRESS",
            cartUuid: input.cartUuid,
            storeId: input.storeId
          }
        ),
        contracts.cart
      );
    }
    inFlightCartWrites.add(writeKey);
    let stateChangeToken;
    try {
      stateChangeToken = acquireCheckoutStateChange({
        operation: "add_cart_items",
        cartUuid: input.cartUuid,
        stateScope: "cart"
      });
      const preflight = await preflightCartItems(input);
      if (preflight.itemErrors.length) {
        const projected = projectWithContract(contracts.cart, {
          cart: { items: [] },
          item_errors: preflight.itemErrors,
          mcp_requested_items: preflight.items.map(
            (item, requestIndex) => ({
              request_index: requestIndex,
              item_id: item.itemId,
              name: item.itemName,
              quantity: item.quantity,
              nested_options: item.nestedOptions
            })
          )
        });
        return toToolResult(projected, { isError: true });
      }

      let addInput = {
        ...input,
        items: preflight.items
      };
      if (!addInput.cartUuid) {
        const activeCarts = await inspectActiveCarts(addInput.storeId);
        const existingCart =
          activeCarts.find((cart) => cart.items.length > 0) ||
          activeCarts[0];
        if (existingCart) {
          if (existingCart.items.length === 0) {
            addInput = {
              ...addInput,
              cartUuid: existingCart.cart_uuid
            };
          } else {
            throw new DoorDashCliError(
              `An active DoorDash cart already exists at this store (${existingCart.cart_uuid}). No items were added. Call show_cart with that cart_uuid first. If it already matches the request, call create_checkout_link; otherwise ask whether to extend it using that cart_uuid or replace it with delete_cart.`,
              {
                code: "ACTIVE_CART_EXISTS",
                cartUuid: existingCart.cart_uuid
              }
            );
          }
        }
      }

      let addResult;
      try {
        addResult = await executeCli(addCartItemsArgs(addInput), {
          project: (data) => data
        });
      } catch (error) {
        throw new DoorDashCliError(
          "The cart write returned an unknown outcome. Never resend this batch. Inspect the cart once to learn which lines, if any, were added.",
          {
            code: "CART_WRITE_OUTCOME_UNKNOWN",
            cartUuid: addInput.cartUuid,
            storeId: addInput.storeId,
            cause: error instanceof Error ? error.message : String(error)
          }
        );
      }
      let projected = projectWithContract(contracts.cart, {
        ...addResult,
        mcp_requested_items: addInput.items.map((item, requestIndex) => ({
          request_index: requestIndex,
          item_id: item.itemId,
          name: item.itemName,
          quantity: item.quantity,
          nested_options: item.nestedOptions
        }))
      });

      if (!projected.cart_uuid || projected.items.length === 0) {
        return toToolResult(projected);
      }

      try {
        const checkout = await executeCli(
          checkoutLinkArgs({ cartUuid: projected.cart_uuid }),
          {
            project: (data) =>
              projectWithContract(contracts.checkoutLink, data)
          }
        );
        projected = contracts.cart.outputSchema.parse({
          ...projected,
          checkout_url: checkout.checkout_url
        });
      } catch {
        projected = contracts.cart.outputSchema.parse({
          ...projected,
          warnings: [
            ...(projected.warnings || []),
            "Items were added, but DoorDash did not return a checkout URL. Call create_checkout_link with this cart_uuid."
          ]
        });
      }

      return toToolResult(projected);
    } catch (error) {
      return toolError(error, contracts.cart);
    } finally {
      releaseCheckoutStateChange(stateChangeToken);
      inFlightCartWrites.delete(writeKey);
    }
  }

  async function submitOrder(input, authInfo) {
    let stateChangeToken;
    try {
      assertCurrentPurchaseAccess(securityStore, authInfo);
      const recordedAttempt = securityStore.getSubmissionAttempt(
        input.cartUuid
      );
      if (recordedAttempt) {
        throw new DoorDashCliError(
          "This cart already has a recorded submission attempt. Refusing to risk a duplicate charge.",
          {
            code: "SUBMISSION_ALREADY_ATTEMPTED",
            cartUuid: input.cartUuid,
            submissionStatus: recordedAttempt.status || "unknown",
            orderUuid: recordedAttempt.order_uuid || null
          }
        );
      }
      if (!validPreviewToken(previewSigningKey, input)) {
        throw new DoorDashCliError(
          "preview_token does not match the other order_submit fields. No automatic recovery is returned because the mismatched settings cannot be trusted. Call preview_order again with the user's intended fulfillment, schedule, priority, credit use, and work budget, then copy every submit_context field exactly.",
          { code: "PREVIEW_CONFIRMATION_INVALID" }
        );
      }
      stateChangeToken = acquireCheckoutStateChange({
        operation: "order_submit",
        cartUuid: input.cartUuid,
        stateScope: "cart"
      });
      const recoveryArguments = previewRecoveryArguments(input);

      const previewArgs = previewOrderArgs({
        cartUuid: input.cartUuid,
        scheduledTime: input.scheduledTime,
        fulfillment: input.fulfillment,
        priority: input.priority,
        includeWorkBenefits: true,
        selectedBudgetId: input.budgetId,
        applyCredits: input.applyCredits
      });
      const preview = await executeCli(previewArgs, {
        project: (data) => data
      });

      const projectedPreview = projectSignedPreview(preview, input);
      const previewContext = projectedPreview.submit_context;
      if (
        previewContext.preview_token !== input.previewToken
      ) {
        throw new DoorDashCliError(
          "The cart contents, total, address, fulfillment, schedule, priority, credit use, PIN requirement, or selected work budget changed since confirmation. Review and confirm the new preview before submitting.",
          {
            code: "ORDER_PREVIEW_CHANGED",
            cartUuid: input.cartUuid,
            previewArguments: recoveryArguments
          }
        );
      }
      if (
        previewContext.pin_handoff_required &&
        input.pinHandoffAcknowledged !== true
      ) {
        throw new DoorDashCliError(
          "This delivery requires handing a PIN to the Dasher. Ask the user to accept that requirement, then submit with pin_handoff_acknowledged=true.",
          {
            code: "PIN_HANDOFF_CONFIRMATION_REQUIRED",
            cartUuid: input.cartUuid
          }
        );
      }

      validateWorkPayment(input, preview, recoveryArguments);
      if (
        !input.teamId &&
        input.paymentConfirmation.type === "card"
      ) {
        const paymentMethods = await executeCli(listPaymentMethodsArgs(), {
          project: (data) => data
        });
        validateCardPayment(input, paymentMethods);
      }

      assertCurrentPurchaseAccess(securityStore, authInfo);
      if (!securityStore.beginSubmission(input.cartUuid)) {
        const attempt = securityStore.getSubmissionAttempt(input.cartUuid);
        throw new DoorDashCliError(
          "This cart already has a recorded submission attempt. Refusing to risk a duplicate charge.",
          {
            code: "SUBMISSION_ALREADY_ATTEMPTED",
            cartUuid: input.cartUuid,
            submissionStatus: attempt?.status || "unknown",
            orderUuid: attempt?.order_uuid || null
          }
        );
      }

      let submitted;
      try {
        submitted = await executeCli(submitOrderArgs(input), {
          allowPurchases: true,
          project: (data) => data
        });
      } catch (error) {
        securityStore.finishSubmission(input.cartUuid, {
          status: "unknown",
          errorMessage: error instanceof Error ? error.message : String(error)
        });
        const upstreamCode =
          error?.details?.data?.error_reason ||
          error?.details?.data?.error?.code ||
          error?.details?.data?.structuredContent?.error_reason ||
          error?.details?.data?.structuredContent?.error?.code ||
          error?.details?.code;
        if (upstreamCode === "AGENTIC_RESTRICTED_ITEM_NOT_ALLOWED") {
          throw new DoorDashCliError(
            "DoorDash rejected agentic submission because this cart requires browser verification. Do not submit it again through MCP; finish through the checkout link.",
            {
              code: upstreamCode,
              cartUuid: input.cartUuid,
              cause: error instanceof Error ? error.message : String(error)
            }
          );
        }
        throw new DoorDashCliError(
          "Order submission returned an unknown outcome. Never submit this cart again. Check order history once.",
          {
            code: "SUBMISSION_OUTCOME_UNKNOWN",
            cartUuid: input.cartUuid,
            cause: error instanceof Error ? error.message : String(error)
          }
        );
      }

      const orderUuid = orderUuidFromSubmit(submitted);
      const submittedSuccess =
        submitted?.success === true ||
        String(submitted?.success || "").trim().toLowerCase() === "true"
          ? true
          : submitted?.success === false ||
              String(submitted?.success || "").trim().toLowerCase() ===
                "false"
            ? false
            : undefined;
      if (submittedSuccess === false) {
        securityStore.finishSubmission(input.cartUuid, {
          status: "failed",
          orderUuid,
          errorMessage:
            submitted.error_message || submitted.message || "Submission failed."
        });
        throw new DoorDashCliError(
          `${submitted.error_message || submitted.message || "Order submission failed."} This cart cannot be submitted again through MCP; finish in browser checkout or create a new cart.`,
          {
            code: "SUBMISSION_REJECTED",
            cartUuid: input.cartUuid
          }
        );
      }
      if (submittedSuccess !== true || !orderUuid) {
        securityStore.finishSubmission(input.cartUuid, {
          status: "unknown",
          orderUuid,
          errorMessage:
            "DoorDash did not return explicit success with an order UUID."
        });
        throw new DoorDashCliError(
          "Order submission returned an ambiguous response without explicit success and an order UUID. Never submit this cart again. Check order history once.",
          {
            code: "SUBMISSION_OUTCOME_UNKNOWN",
            cartUuid: input.cartUuid
          }
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
                project: (data) => data
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
            : "The order was accepted and is still pending after five status checks. Report it as pending; do not poll again in this request.");
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
    } finally {
      releaseCheckoutStateChange(stateChangeToken);
    }
  }

  function createDoorDashServer(factoryContext = {}) {
    const authInfo = factoryContext.authInfo;
    const server = new McpServer({
      name: "doordash-cli",
      version: SERVER_VERSION
    });

    registerDoorDashTools(server, {
      authInfo,
      addCartItems,
      getItemDetails,
      getMenu,
      previewOrder: (input) => previewOrder(input, authInfo),
      reorder,
      invoke: (args, options) => invoke(args, options, authInfo),
      invokeAtDefaultAddress: (input, buildArgs) =>
        invokeAtDefaultAddress(input, buildArgs, authInfo),
      submitOrder: (input) => submitOrder(input, authInfo)
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
