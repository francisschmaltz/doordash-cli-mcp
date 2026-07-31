function option(args, flag, value) {
  if (value !== undefined && value !== null && value !== "") {
    args.push(flag, String(value));
  }
  return args;
}

function booleanFlag(args, flag, enabled) {
  if (enabled) {
    args.push(flag);
  }
  return args;
}

function nestedOptionToCli(optionValue) {
  return {
    id: optionValue.id,
    name: optionValue.name,
    quantity: optionValue.quantity ?? 1,
    ...(optionValue.options?.length
      ? { options: optionValue.options.map(nestedOptionToCli) }
      : {})
  };
}

function cartItemToCli(item) {
  return {
    item_id: item.itemId,
    item_name: item.itemName,
    quantity: item.quantity ?? 1,
    ...(item.nestedOptions?.length
      ? { nested_options: item.nestedOptions.map(nestedOptionToCli) }
      : {})
  };
}

export function listAddressesArgs() {
  return ["address", "list"];
}

export function setAddressArgs({ addressId }) {
  return ["address", "set", "--address-id", addressId, "--yes"];
}

export function buildGroceryListArgs({
  items,
  storeId,
  desiredMerchantName,
  servings
}) {
  const args = [
    "build-grocery-list",
    "--items-json",
    JSON.stringify(
      items.map((item) => ({
        name: item.name,
        ...(item.quantity !== undefined ? { quantity: item.quantity } : {})
      }))
    )
  ];
  option(args, "--store-id", storeId);
  option(args, "--desired-mx-name", desiredMerchantName);
  option(args, "--servings", servings);
  return args;
}

export function findItemsArgs({ storeId, queries }) {
  const args = ["find-items", "--store-id", storeId];
  for (const query of queries) {
    option(args, "--query", query);
  }
  return args;
}

export function findNearbyStoresArgs({ vertical, max, lat, lng }) {
  const args = ["find-nearby-stores", "--vertical", vertical];
  option(args, "--max", max);
  option(args, "--lat", lat);
  option(args, "--lng", lng);
  return args;
}

export function itemDetailsArgs({ storeId, itemId }) {
  return ["item-details", "--store-id", storeId, "--item-id", itemId];
}

export function menuArgs({ storeId }) {
  return ["menu", "--store-id", storeId];
}

export function restaurantItemDetailsArgs({ storeId, menuId, itemId }) {
  const args = [
    "restaurant-item-details",
    "--store-id",
    storeId,
    "--menu-id",
    menuId,
    "--item-id",
    itemId.replace(/^i_/, "")
  ];
  return args;
}

export function searchRestaurantsArgs({ query, lat, lng, limit }) {
  const args = ["search", "--query", query];
  option(args, "--lat", lat);
  option(args, "--lng", lng);
  option(args, "--limit", limit);
  return args;
}

export function storeDetailsArgs({ storeId }) {
  return ["store-details", "--store-id", storeId];
}

export function addCartItemsArgs({
  storeId,
  menuId,
  items,
  cartUuid,
  fulfillment,
  groupCart,
  spendLimitCents
}) {
  const args = [
    "cart",
    "add-items",
    "--store-id",
    storeId,
    "--menu-id",
    menuId,
    "--items-json",
    JSON.stringify(items.map(cartItemToCli))
  ];
  option(args, "--cart-uuid", cartUuid);
  option(args, "--fulfillment", fulfillment);
  booleanFlag(args, "--group-cart", groupCart);
  option(args, "--spend-limit-cents", spendLimitCents);
  return args;
}

export function deleteCartArgs({ cartUuid }) {
  return ["cart", "delete", "--cart-uuid", cartUuid];
}

export function listCartsArgs({ storeId } = {}) {
  const args = ["cart", "list"];
  option(args, "--store-id", storeId);
  return args;
}

export function removeCartItemArgs({ cartUuid, cartItemId }) {
  return [
    "cart",
    "remove-item",
    "--cart-uuid",
    cartUuid,
    "--cart-item-id",
    cartItemId
  ];
}

export function showCartArgs({ cartUuid }) {
  return ["cart", "show", "--cart-uuid", cartUuid];
}

export function checkoutLinkArgs({ cartUuid }) {
  return ["order", "checkout-url", "--cart-uuid", cartUuid];
}

export function listOrdersArgs({ max, days }) {
  return [
    "order",
    "history",
    "--max",
    String(max),
    "--days",
    String(days)
  ];
}

export function previewOrderArgs({
  cartUuid,
  scheduledTime,
  fulfillment,
  priority,
  includeWorkBenefits,
  selectedBudgetId,
  applyCredits = true
}) {
  const args = ["order", "preview", "--cart-uuid", cartUuid];
  option(args, "--scheduled-time", scheduledTime);
  option(args, "--fulfillment", fulfillment);
  booleanFlag(args, "--priority", priority);
  booleanFlag(args, "--include-work-benefits", includeWorkBenefits);
  option(args, "--selected-budget-id", selectedBudgetId);
  booleanFlag(args, "--no-apply-credits", !applyCredits);
  return args;
}

export function receiptArgs({ orderUuid }) {
  return ["order", "receipt", "--order-uuid", orderUuid];
}

export function reorderArgs({ orderUuid }) {
  return ["order", "reorder", "--order-uuid", orderUuid];
}

export function orderStatusArgs({ orderUuid }) {
  return ["order", "status", "--order-uuid", orderUuid];
}

export function submitOrderArgs({
  cartUuid,
  tipCents,
  scheduledTime,
  fulfillment,
  priority,
  teamId,
  budgetId,
  teamAccountId,
  expenseCode,
  expenseNotes,
  applyCredits = true
}) {
  const args = [
    "order",
    "submit",
    "--cart-uuid",
    cartUuid,
    "--tip-cents",
    String(tipCents),
    "--yes"
  ];
  option(args, "--scheduled-time", scheduledTime);
  option(args, "--fulfillment", fulfillment);
  booleanFlag(args, "--priority", priority);
  option(args, "--team-id", teamId);
  option(args, "--budget-id", budgetId);
  option(args, "--team-account-id", teamAccountId);
  option(args, "--expense-code", expenseCode);
  option(args, "--expense-notes", expenseNotes);
  booleanFlag(args, "--no-apply-credits", !applyCredits);
  return args;
}

export function listPaymentMethodsArgs() {
  return ["payment-method", "list"];
}

export function listPromosArgs({ storeId }) {
  return ["promo", "list", "--store-id", storeId];
}

function promoMutationArgs(command, {
  cartUuid,
  promoCode,
  campaignId,
  adGroupId,
  adId
}) {
  const args = [
    "promo",
    command,
    "--cart-uuid",
    cartUuid,
    "--promo-code",
    promoCode
  ];
  option(args, "--campaign-id", campaignId);
  option(args, "--ad-group-id", adGroupId);
  option(args, "--ad-id", adId);
  return args;
}

export function applyPromoArgs(input) {
  return promoMutationArgs("apply", input);
}

export function removePromoArgs(input) {
  return promoMutationArgs("remove", input);
}
