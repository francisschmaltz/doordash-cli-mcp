import * as z from "zod/v4";

import {
  addCartItemsArgs,
  applyPromoArgs,
  buildGroceryListArgs,
  checkoutLinkArgs,
  deleteCartArgs,
  findNearbyStoresArgs,
  listAddressesArgs,
  listCartsArgs,
  listOrdersArgs,
  listPaymentMethodsArgs,
  listPromosArgs,
  orderStatusArgs,
  receiptArgs,
  removePromoArgs,
  searchRestaurantsArgs,
  setAddressArgs,
  showCartArgs,
  storeDetailsArgs
} from "./command-args.js";
import { hasPurchaseAccess } from "./auth.js";
import {
  publicOutputSchemaForTool
} from "./response-contract.js";

const idSchema = z.string().min(1).max(128);
const fulfillmentSchema = z.enum(["delivery", "pickup"]);
const verticalSchema = z.enum([
  "grocery",
  "alcohol",
  "convenience",
  "pets",
  "retail",
  "nv"
]);

const legacyInputAliases = [
  ["address_id", ["addressId"]],
  ["store_id", ["storeId"]],
  ["menu_id", ["menuId"]],
  ["option_queries", ["optionQueries"]],
  ["item_id", ["itemId"]],
  ["cart_uuid", ["cartUuid"]],
  ["cart_item_id", ["cartItemId"]],
  ["replacement_cart_item_id", ["replacementCartItemId"]],
  ["confirm_delete_without_replacement", ["confirmDeleteWithoutReplacement"]],
  ["order_uuid", ["orderUuid"]],
  ["promo_code", ["promoCode"]],
  ["campaign_id", ["campaignId"]],
  ["ad_group_id", ["adGroupId"]],
  ["ad_id", ["adId"]],
  ["scheduled_time", ["scheduledTime"]],
  ["budget_id", ["budgetId", "selected_budget_id", "selectedBudgetId"]],
  ["team_id", ["teamId"]],
  ["team_account_id", ["teamAccountId"]],
  ["expense_code", ["expenseCode"]],
  ["expense_notes", ["expenseNotes"]],
  ["desired_merchant_name", ["desiredMerchantName"]],
  ["include_work_benefits", ["includeWorkBenefits"]],
  ["apply_credits", ["applyCredits"]],
  ["group_cart", ["groupCart"]],
  ["spend_limit", ["spendLimit"]],
  ["expected_delivery_address", ["expectedDeliveryAddress"]],
  ["preview_token", ["previewToken"]],
  ["tip_confirmed", ["tipConfirmed"]],
  ["payment_confirmation", ["paymentConfirmation"]],
  ["pin_handoff_required", ["pinHandoffRequired"]],
  ["pin_handoff_acknowledged", ["pinHandoffAcknowledged"]]
];

const internalInputNames = [
  ["address_id", "addressId"],
  ["store_id", "storeId"],
  ["menu_id", "menuId"],
  ["option_queries", "optionQueries"],
  ["item_id", "itemId"],
  ["cart_uuid", "cartUuid"],
  ["cart_item_id", "cartItemId"],
  ["replacement_cart_item_id", "replacementCartItemId"],
  ["confirm_delete_without_replacement", "confirmDeleteWithoutReplacement"],
  ["order_uuid", "orderUuid"],
  ["promo_code", "promoCode"],
  ["campaign_id", "campaignId"],
  ["ad_group_id", "adGroupId"],
  ["ad_id", "adId"],
  ["scheduled_time", "scheduledTime"],
  ["budget_id", "budgetId"],
  ["team_id", "teamId"],
  ["team_account_id", "teamAccountId"],
  ["expense_code", "expenseCode"],
  ["expense_notes", "expenseNotes"],
  ["desired_merchant_name", "desiredMerchantName"],
  ["include_work_benefits", "includeWorkBenefits"],
  ["apply_credits", "applyCredits"],
  ["group_cart", "groupCart"],
  ["expected_delivery_address", "expectedDeliveryAddress"],
  ["preview_token", "previewToken"],
  ["tip_confirmed", "tipConfirmed"],
  ["payment_confirmation", "paymentConfirmation"],
  ["pin_handoff_required", "pinHandoffRequired"],
  ["pin_handoff_acknowledged", "pinHandoffAcknowledged"]
];

function sameInputValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalObject(shape, extraAliases = []) {
  const aliases = [...legacyInputAliases, ...extraAliases].filter(
    ([canonicalName]) => Object.hasOwn(shape, canonicalName)
  );
  return z.preprocess((value, context) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const normalized = { ...value };
    for (const [canonicalName, aliasNames] of aliases) {
      const supplied = [
        [canonicalName, normalized[canonicalName]],
        ...aliasNames.map((aliasName) => [aliasName, normalized[aliasName]])
      ].filter(([, aliasValue]) => aliasValue !== undefined);
      if (
        supplied.length > 1 &&
        supplied.some(([, aliasValue]) =>
          !sameInputValue(aliasValue, supplied[0][1])
        )
      ) {
        context.addIssue({
          code: "custom",
          path: [canonicalName],
          message: `${supplied.map(([name]) => name).join(", ")} must match when more than one is provided.`
        });
        return z.NEVER;
      }
      if (normalized[canonicalName] === undefined && supplied.length) {
        normalized[canonicalName] = supplied[0][1];
      }
      for (const aliasName of aliasNames) {
        delete normalized[aliasName];
      }
    }
    return normalized;
  }, z.strictObject(shape));
}

function normalizeToolInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const normalized = { ...input };
  for (const [canonicalName, internalName] of internalInputNames) {
    if (
      normalized[internalName] === undefined &&
      normalized[canonicalName] !== undefined
    ) {
      normalized[internalName] = normalized[canonicalName];
    }
  }
  if (Array.isArray(normalized.items)) {
    normalized.items = normalized.items.map((value) => ({
      ...value,
      itemId: value.item_id,
      itemName: value.name,
      requestedOptions: value.requested_options,
      nestedOptions: value.nested_options
    }));
  }
  if (
    normalized.paymentConfirmation &&
    typeof normalized.paymentConfirmation === "object"
  ) {
    normalized.paymentConfirmation = {
      ...normalized.paymentConfirmation,
      budgetName:
        normalized.paymentConfirmation.budgetName ??
        normalized.paymentConfirmation.name
    };
  }
  normalized.selectedBudgetId = normalized.budget_id;
  if (normalized.expected_total_before_tip !== undefined) {
    normalized.expectedTotalBeforeTipCents = Math.round(
      normalized.expected_total_before_tip * 100
    );
  }
  if (normalized.tip !== undefined) {
    normalized.tipCents = Math.round(normalized.tip * 100);
  }
  if (normalized.spend_limit !== undefined) {
    normalized.spendLimitCents = Math.round(normalized.spend_limit * 100);
  }
  return normalized;
}

const selectedCartOptionSchema = z.lazy(() =>
  canonicalObject(
    {
      option_id: idSchema.describe(
        "Copy option_id from item details or item_errors."
      ),
      name: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe("Optional copied option name."),
      quantity: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(1)
        .describe("Selection count; defaults to one."),
      options: z
        .array(selectedCartOptionSchema)
        .max(50)
        .optional()
        .describe("Selections from this option's nested groups.")
    },
    [["option_id", ["optionId", "id"]]]
  ).refine((option) => !option.option_id.startsWith("e_"), {
    message:
      "option_id must identify a selectable option, not a modifier group."
  })
);

const requestedCartOptionSchema = z
  .strictObject({
    name: z
      .string()
      .min(1)
      .max(300)
      .describe(
        "Exact returned option name. Use a qualified error candidate such as Sauce Ranch when needed."
      ),
    quantity: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Selection count; omit for one."),
    option_id: idSchema
      .optional()
      .describe(
        "Copy option_id to disambiguate duplicate names. Pair reused IDs with the qualified returned name."
      )
  })
  .refine(
    (option) =>
      option.option_id === undefined || !option.option_id.startsWith("e_"),
    {
      message:
        "option_id must identify a selectable option, not a modifier group."
    }
  );

const cartItemSchema = canonicalObject(
  {
    item_id: idSchema.describe(
      "Copy item_id from a DoorDash response."
    ),
    name: z
      .string()
      .min(1)
      .max(500)
      .describe("Copy the item's exact name, without choices."),
    quantity: z.number().int().min(1).max(10_000).default(1),
    requested_options: z
      .array(requestedCartOptionSchema)
      .max(50)
      .optional()
      .describe(
        "Restaurant choices by exact name. quantity repeats a choice; option_id resolves ambiguity. Ask about multiple item_error candidates."
      ),
    nested_options: z
      .array(selectedCartOptionSchema)
      .max(100)
      .optional()
      .describe(
        "Selected option_id tree. Include every required group; never send group IDs."
      )
  },
  [
    ["name", ["item_name", "itemName"]],
    ["requested_options", ["requestedOptions"]],
    ["nested_options", ["nestedOptions"]]
  ]
);

const previewOptionsSchema = {
  scheduled_time: z.string().datetime({ offset: true }).optional(),
  fulfillment: fulfillmentSchema
    .optional()
    .describe(
      "Optional. Omit to preserve the cart's current mode; passing delivery or pickup changes it."
    ),
  priority: z.boolean().default(false),
  include_work_benefits: z
    .boolean()
    .default(true)
    .describe("Keep true to return any eligible work budgets."),
  budget_id: idSchema
    .optional()
    .describe(
      "Work payment uses two previews: first omit budget_id to list eligible budgets, then call preview_order again with the chosen budget_id."
    ),
  apply_credits: z.boolean().default(true)
};

const promoInputSchema = {
  cart_uuid: idSchema.describe("Copy cart_uuid from a cart response."),
  promo_code: z
    .string()
    .min(1)
    .max(200)
    .describe("Copy promo_code from list_promos or the user."),
  campaign_id: idSchema
    .optional()
    .describe("Copy campaign_id from the same list_promos entry."),
  ad_group_id: idSchema
    .optional()
    .describe("Copy ad_group_id from the same list_promos entry."),
  ad_id: idSchema
    .optional()
    .describe("Copy ad_id from the same list_promos entry.")
};

const workBudgetConfirmationSchema = z.strictObject({
  type: z.literal("work_budget"),
  name: z
    .string()
    .min(1)
    .max(300)
    .describe(
      "Copy name from preview_order work_benefits.eligible_budgets."
    )
});

function orderSubmitInputSchema(shape) {
  return z.preprocess((value, context) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const normalized = { ...value };
    const paymentValues = [
      ["payment_confirmation", normalized.payment_confirmation],
      ["paymentConfirmation", normalized.paymentConfirmation]
    ].filter(([, paymentValue]) => paymentValue !== undefined);
    if (
      paymentValues.length > 1 &&
      !sameInputValue(paymentValues[0][1], paymentValues[1][1])
    ) {
      context.addIssue({
        code: "custom",
        path: ["payment_confirmation"],
        message:
          "payment_confirmation and paymentConfirmation must match when both are provided."
      });
      return z.NEVER;
    }
    if (paymentValues.length) {
      const payment = { ...paymentValues[0][1] };
      if (payment.type === "work_budget") {
        const names = [
          ["name", payment.name],
          ["budget_name", payment.budget_name],
          ["budgetName", payment.budgetName]
        ].filter(([, nameValue]) => nameValue !== undefined);
        if (
          names.length > 1 &&
          names.some(([, nameValue]) => nameValue !== names[0][1])
        ) {
          context.addIssue({
            code: "custom",
            path: ["payment_confirmation", "name"],
            message:
              "name, budget_name, and budgetName must match when more than one is provided."
          });
          return z.NEVER;
        }
        payment.name = names[0]?.[1];
        delete payment.budget_name;
        delete payment.budgetName;
      }
      normalized.payment_confirmation = payment;
      delete normalized.paymentConfirmation;
    }
    for (const [canonicalName, legacyName] of [
      ["expected_total_before_tip", "expectedTotalBeforeTipCents"],
      ["tip", "tipCents"]
    ]) {
      const legacyCents = normalized[legacyName];
      if (legacyCents === undefined) {
        continue;
      }
      const legacyDollars = Number(legacyCents) / 100;
      if (
        normalized[canonicalName] !== undefined &&
        normalized[canonicalName] !== legacyDollars
      ) {
        context.addIssue({
          code: "custom",
          path: [canonicalName],
          message: `${canonicalName} and ${legacyName} must represent the same amount.`
        });
        return z.NEVER;
      }
      normalized[canonicalName] = legacyDollars;
      delete normalized[legacyName];
    }
    return normalized;
  }, canonicalObject(shape));
}

function cartInputSchema(shape) {
  return z.preprocess((value, context) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const normalized = { ...value };
    const legacyValues = [
      ["spend_limit_cents", normalized.spend_limit_cents],
      ["spendLimitCents", normalized.spendLimitCents]
    ].filter(([, legacyValue]) => legacyValue !== undefined);
    if (legacyValues.length) {
      const legacyDollars = Number(legacyValues[0][1]) / 100;
      if (
        legacyValues.some(([, legacyValue]) =>
          Number(legacyValue) / 100 !== legacyDollars
        ) ||
        (normalized.spend_limit !== undefined &&
          normalized.spend_limit !== legacyDollars)
      ) {
        context.addIssue({
          code: "custom",
          path: ["spend_limit"],
          message:
            "spend_limit and legacy spend-limit fields must represent the same amount."
        });
        return z.NEVER;
      }
      normalized.spend_limit = legacyDollars;
    }
    delete normalized.spend_limit_cents;
    delete normalized.spendLimitCents;
    return normalized;
  }, canonicalObject(shape));
}

function orderReferenceSchema() {
  return canonicalObject({
    order_uuid: idSchema.describe(
      "Copy order_uuid exactly from list_orders or order_submit."
    )
  });
}

function orderUuidFromInput(input) {
  return input.order_uuid;
}

function annotations({
  readOnly,
  destructive = false,
  idempotent = readOnly
}) {
  return {
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    idempotentHint: idempotent,
    openWorldHint: true
  };
}

function register(server, name, config, handler) {
  return server.registerTool(
    name,
    {
      ...config,
      outputSchema: publicOutputSchemaForTool(name)
    },
    (input, ...args) => handler(normalizeToolInput(input), ...args)
  );
}

export function registerDoorDashTools(server, context) {
  register(
    server,
    "list_addresses",
    {
      title: "List DoorDash Addresses",
      description:
        "List saved delivery addresses and identify the account-wide default. Address data is sensitive.",
      inputSchema: canonicalObject({}),
      annotations: annotations({ readOnly: true })
    },
    async () => context.invoke(listAddressesArgs())
  );

  register(
    server,
    "set_default_address",
    {
      title: "Set Default DoorDash Address",
      description:
        "Set the account-wide default address. Copy address_id from list_addresses and use the exact confirmation text. This changes searches, previews, and future DoorDash checkouts.",
      inputSchema: canonicalObject({
        address_id: idSchema.describe("Copy address_id from list_addresses."),
        confirmation: z.literal("SET DEFAULT ADDRESS")
      }),
      annotations: annotations({
        readOnly: false,
        idempotent: true
      })
    },
    async (input) =>
      context.invoke(setAddressArgs(input), {
        transform: (data) => ({
          ...data,
          address_id: data?.address_id || input.addressId
        }),
        stateMutation: {
          operation: "set_default_address",
          stateScope: "address"
        },
        mutationOutcome: {
          code: "ADDRESS_MUTATION_OUTCOME_UNKNOWN",
          message:
            "DoorDash did not confirm whether the default address changed. Do not repeat the update. Call list_addresses once and inspect is_default.",
          addressId: input.addressId,
          stateScope: "address"
        }
      })
  );

  register(
    server,
    "build_grocery_list",
    {
      title: "Build DoorDash Grocery List",
      description:
        "Resolve a complete grocery or household shopping list into products. This is stateless and does not create a cart.",
      inputSchema: canonicalObject({
        items: z
          .array(
            z.strictObject({
              name: z.string().min(1).max(300),
              quantity: z.number().positive().max(10_000).optional()
            })
          )
          .min(1)
          .max(20),
        store_id: idSchema
          .optional()
          .describe("Optional store_id from find_nearby_stores."),
        desired_merchant_name: z.string().min(1).max(300).optional(),
        servings: z.number().int().min(1).max(1_000).optional()
      }),
      annotations: annotations({ readOnly: true })
    },
    async (input) => context.invoke(buildGroceryListArgs(input))
  );

  register(
    server,
    "find_items",
    {
      title: "Find DoorDash Grocery or Retail Products",
      description:
        "Search a grocery or retail store. For restaurant food, use get_menu with store_id and a dish query.",
      inputSchema: canonicalObject({
        store_id: idSchema.describe(
          "Copy a non-restaurant store_id from a store result."
        ),
        queries: z.array(z.string().min(1).max(300)).min(1).max(10)
      }),
      annotations: annotations({ readOnly: true })
    },
    async (input) => context.findItems(input)
  );

  register(
    server,
    "find_nearby_stores",
    {
      title: "Find Nearby DoorDash Stores",
      description:
        "Discover non-restaurant stores using the account-wide default address. Choose grocery, alcohol, convenience, pets, or retail; nv means all non-restaurant types. Location overrides are not accepted.",
      inputSchema: canonicalObject({
        vertical: verticalSchema,
        max: z.number().int().min(1).max(100).default(25)
      }),
      annotations: annotations({ readOnly: true })
    },
    async (input) =>
      context.invokeAtDefaultAddress(input, findNearbyStoresArgs)
  );

  register(
    server,
    "get_item_details",
    {
      title: "Get DoorDash Item Details",
      description:
        "Return current pricing and option_id values. IDs prefixed i_ and bare IDs paired with a restaurant menu_id use restaurant modifiers; other IDs use retail lookup. An omitted menu_id stays omitted. Use option_queries for compact matching paths.",
      inputSchema: canonicalObject({
        store_id: idSchema.describe(
          "Copy store_id from the search, menu, or item-search result."
        ),
        item_id: idSchema.describe(
          "Copy item_id from get_menu, find_items, or list_orders."
        ),
        menu_id: idSchema
          .optional()
          .describe(
            "Restaurant menu_id from a menu, order, cart, or reorder; routes bare history IDs."
          ),
        option_queries: z
          .array(z.string().min(1).max(300))
          .min(1)
          .max(10)
          .optional()
          .describe(
            "Option names to find; returns bounded paths and ambiguities."
          )
      }),
      annotations: annotations({ readOnly: true })
    },
    async (input) => context.getItemDetails(input)
  );

  register(
    server,
    "get_menu",
    {
      title: "Get DoorDash Restaurant Menu",
      description:
        "Return the complete restaurant menu for store_id, including its authoritative menu_id for item-detail and cart handoff. Use query to filter that menu to one dish. This makes exactly one read-only DoorDash menu call and never reads or changes cart state.",
      inputSchema: canonicalObject({
        store_id: idSchema.describe(
          "Copy store_id from search_restaurants or get_store_details."
        ),
        query: z
          .string()
          .trim()
          .min(1)
          .max(300)
          .optional()
          .describe("Optional dish-name filter, such as Spicy TanTan.")
      }),
      annotations: annotations({ readOnly: true })
    },
    async (input) => context.getMenu(input)
  );

  register(
    server,
    "search_restaurants",
    {
      title: "Search DoorDash Restaurants",
      description:
        "Find nearby restaurants using the account-wide default saved DoorDash address. This tool always resolves that address through list_addresses and does not accept a location override.",
      inputSchema: canonicalObject({
        query: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(50).default(10)
      }),
      annotations: annotations({ readOnly: true })
    },
    async (input) =>
      context.invokeAtDefaultAddress(input, searchRestaurantsArgs)
  );

  register(
    server,
    "get_store_details",
    {
      title: "Get DoorDash Store Details",
      description:
        "Return store metadata, address, and fulfillment capabilities.",
      inputSchema: canonicalObject({
        store_id: idSchema.describe(
          "Copy store_id from search_restaurants or find_nearby_stores."
        )
      }),
      annotations: annotations({ readOnly: true })
    },
    async (input) => context.invoke(storeDetailsArgs(input))
  );

  register(
    server,
    "add_cart_items",
    {
      title: "Add DoorDash Cart Items",
      description:
        "Add the complete requested batch once. Copy store_id, menu_id, item_id, and exact item name. Put choices in structured requested_options or nested_options; use option_id when a name is ambiguous and repeated choices with quantity. Satisfy every required modifier group. A preflight error makes no cart change; fix it, then retry once. A partial-add result may have written items; never resend. Success normally returns checkout_url.",
      inputSchema: cartInputSchema({
          store_id: idSchema.describe(
            "Copy store_id from get_menu, build_grocery_list, or get_item_details."
          ),
          menu_id: idSchema.describe(
            "Copy menu_id from get_menu or build_grocery_list. For a retail search result, call get_item_details first."
          ),
          items: z
            .array(cartItemSchema)
            .min(1)
            .max(20)
            .describe(
              "Up to 20 lines. Split different options; quantity repeats identical lines."
            ),
          cart_uuid: idSchema
            .optional()
            .describe("Cart to extend after show_cart inspection."),
          fulfillment: fulfillmentSchema
            .optional()
            .describe(
              "Optional. Omit to preserve an existing cart's mode; pass delivery or pickup only when explicitly chosen."
            ),
          group_cart: z.boolean().default(false),
          spend_limit: z
            .number()
            .min(0.01)
            .max(21_474_836.47)
            .multipleOf(0.01)
            .describe(
              "Per-person group-cart limit in dollars. Requires group_cart=true and no cart_uuid."
            )
            .optional()
        })
        .refine(
          (value) =>
            value.spend_limit === undefined ||
            (value.group_cart && value.cart_uuid === undefined),
          {
            message:
              "spend_limit requires group_cart=true and cannot extend an existing cart_uuid."
          }
        ),
      annotations: annotations({
        readOnly: false,
        idempotent: false
      })
    },
    async (input) => context.addCartItems(input)
  );

  register(
    server,
    "delete_cart",
    {
      title: "Delete DoorDash Cart",
      description:
        "Permanently empty an open cart only after the user explicitly chooses replacement. Copy cart_uuid from show_cart and use the exact confirmation text.",
      inputSchema: canonicalObject({
        cart_uuid: idSchema.describe(
          "Copy cart_uuid from list_carts or show_cart."
        ),
        confirmation: z.literal("DELETE CART")
      }),
      annotations: annotations({
        readOnly: false,
        destructive: true,
        idempotent: false
      })
    },
    async (input) =>
      context.invoke(deleteCartArgs(input), {
        transform: (data) => ({
          ...data,
          cart_uuid: data?.cart_uuid || input.cartUuid
        }),
        stateMutation: {
          operation: "delete_cart",
          cartUuid: input.cartUuid,
          stateScope: "cart"
        },
        mutationOutcome: {
          code: "CART_MUTATION_OUTCOME_UNKNOWN",
          message:
            "DoorDash did not confirm whether the cart was deleted. Do not call delete_cart again. Call show_cart once with this cart_uuid; a not-found result confirms deletion.",
          cartUuid: input.cartUuid,
          stateScope: "cart"
        }
      })
  );

  register(
    server,
    "list_carts",
    {
      title: "List DoorDash Carts",
      description:
        "List up to 25 active unsubmitted carts and 10 lines per cart, optionally filtered by store. add_cart_items checks automatically; use this only to inspect or recover, then call show_cart for one cart's expanded detail.",
      inputSchema: canonicalObject({
        store_id: idSchema.optional().describe("Optional store_id filter.")
      }),
      annotations: annotations({ readOnly: true })
    },
    async (input) => context.invoke(listCartsArgs(input))
  );

  register(
    server,
    "remove_cart_item",
    {
      title: "Remove DoorDash Cart Item",
      description:
        "Remove one line and return the hydrated cart. For replacement, add it first and pass replacement_cart_item_id; both lines must exist. For deletion, set confirm_delete_without_replacement=true.",
      inputSchema: canonicalObject({
        cart_uuid: idSchema.describe("Copy cart_uuid from show_cart."),
        cart_item_id: idSchema.describe(
          "Copy the old line's items[].cart_item_id from show_cart."
        ),
        replacement_cart_item_id: idSchema
          .optional()
          .describe(
            "Already-added replacement line's cart_item_id from show_cart."
          ),
        confirm_delete_without_replacement: z
          .literal(true)
          .optional()
          .describe(
            "True only for deletion without replacement."
          )
      }).refine(
        (input) =>
          Boolean(input.replacement_cart_item_id) !==
          Boolean(input.confirm_delete_without_replacement),
        {
          message:
            "Provide replacement_cart_item_id or confirm_delete_without_replacement=true, but not both."
        }
      ),
      annotations: annotations({
        readOnly: false,
        destructive: true,
        idempotent: false
      })
    },
    async (input) => context.removeCartItem(input)
  );

  register(
    server,
    "show_cart",
    {
      title: "Show DoorDash Cart",
      description:
        "Return up to 100 cart lines. Check warnings and items_truncation; never use item_id as cart_item_id. Use preview_order for final pricing and address.",
      inputSchema: canonicalObject({
        cart_uuid: idSchema.describe(
          "Copy cart_uuid from list_carts, reorder, or add_cart_items."
        )
      }),
      annotations: annotations({ readOnly: true })
    },
    async (input) => context.invoke(showCartArgs(input))
  );

  register(
    server,
    "create_checkout_link",
    {
      title: "Create DoorDash Checkout Link",
      description:
        "Create a browser checkout URL from cart_uuid without submitting or charging. The URL does not pin an address; DoorDash uses the account-wide default at checkout.",
      inputSchema: canonicalObject({
        cart_uuid: idSchema.describe(
          "Copy cart_uuid from a cart response."
        )
      }),
      annotations: annotations({ readOnly: true })
    },
    async (input) => context.invoke(checkoutLinkArgs(input))
  );

  register(
    server,
    "list_orders",
    {
      title: "List DoorDash Orders",
      description:
        "Return up to 25 recent orders with 10 item lines each. Use items_truncation and get_receipt for one order's detail.",
      inputSchema: canonicalObject({
        max: z.number().int().min(1).max(25).default(10),
        days: z.number().int().min(0).max(365).default(90)
      }),
      annotations: annotations({ readOnly: true })
    },
    async (input) => context.invoke(listOrdersArgs(input))
  );

  register(
    server,
    "preview_order",
    {
      title: "Preview DoorDash Order",
      description:
        "Return authoritative cart contents, pricing, address, ETA, tips, and work budgets. Before order_submit, show the user these values and copy submit_context exactly. Passing fulfillment changes the cart mode.",
      inputSchema: canonicalObject({
          cart_uuid: idSchema.describe("Copy cart_uuid from a cart response."),
          ...previewOptionsSchema
      }),
      annotations: annotations({
        readOnly: false,
        idempotent: true
      })
    },
    async (input) => context.previewOrder(input)
  );

  register(
    server,
    "get_receipt",
    {
      title: "Get DoorDash Receipt",
      description:
        "Fetch one past order's itemized receipt, fees, tax, tip, total, credits, and masked payment information. Copy order_uuid from list_orders.",
      inputSchema: orderReferenceSchema(),
      annotations: annotations({ readOnly: true })
    },
    async (input) => {
      const orderUuid = orderUuidFromInput(input);
      return context.invoke(receiptArgs({ orderUuid }), {
        transform: (data) => ({
          ...data,
          mcp_order_uuid: orderUuid
        })
      });
    }
  );

  register(
    server,
    "reorder",
    {
      title: "Reorder DoorDash Order",
      description:
        "Safely create one cart from a past order using order_uuid from list_orders. The server inspects the source order and refuses to merge into a nonempty same-store cart, executes reorder once, then returns a verified hydrated cart and any item, quantity, or modifier differences. If hydration fails, call the returned show_cart recovery once; never reorder again to inspect the outcome.",
      inputSchema: orderReferenceSchema(),
      annotations: annotations({
        readOnly: false,
        idempotent: false
      })
    },
    async (input) => context.reorder(input)
  );

  register(
    server,
    "order_status",
    {
      title: "Check DoorDash Order Status",
      description:
        "Check once whether a submitted order is pending, successful, action required, failed, or not found. Copy order_uuid from list_orders or order_submit. If it is still pending, report that state; do not poll repeatedly in one request.",
      inputSchema: orderReferenceSchema(),
      annotations: annotations({ readOnly: true })
    },
    async (input) =>
      context.invoke(
        orderStatusArgs({ orderUuid: orderUuidFromInput(input) })
      )
  );

  register(
    server,
    "list_promos",
    {
      title: "List DoorDash Promotions",
      description:
        "List consumer- and store-specific campaign promotions eligible at store_id.",
      inputSchema: canonicalObject({
        store_id: idSchema.describe(
          "Copy store_id from a store, menu, or search result."
        )
      }),
      annotations: annotations({ readOnly: true })
    },
    async (input) => context.invoke(listPromosArgs(input))
  );

  register(
    server,
    "apply_promo",
    {
      title: "Apply DoorDash Promotion",
      description:
        "Apply a typed or campaign promo to cart_uuid. Copy promo_code and campaign identifiers directly from list_promos.",
      inputSchema: canonicalObject(promoInputSchema),
      annotations: annotations({
        readOnly: false,
        idempotent: false
      })
    },
    async (input) =>
      context.invoke(applyPromoArgs(input), {
        transform: (data) => ({
          ...data,
          cart_uuid: data?.cart_uuid || input.cartUuid,
          promo_code: data?.promo_code || input.promoCode
        }),
        stateMutation: {
          operation: "apply_promo",
          cartUuid: input.cartUuid,
          stateScope: "cart"
        },
        mutationOutcome: {
          code: "PROMO_MUTATION_OUTCOME_UNKNOWN",
          message:
            "DoorDash did not confirm whether the promo was applied. Do not apply it again. Create the checkout link once and verify the promotion in DoorDash checkout.",
          cartUuid: input.cartUuid,
          stateScope: "cart"
        }
      })
  );

  register(
    server,
    "remove_promo",
    {
      title: "Remove DoorDash Promotion",
      description:
        "Remove a promo using the same promo_code and campaign IDs returned by list_promos and used when it was applied.",
      inputSchema: canonicalObject(promoInputSchema),
      annotations: annotations({
        readOnly: false,
        destructive: true,
        idempotent: false
      })
    },
    async (input) =>
      context.invoke(removePromoArgs(input), {
        transform: (data) => ({
          ...data,
          cart_uuid: data?.cart_uuid || input.cartUuid,
          promo_code: data?.promo_code || input.promoCode
        }),
        stateMutation: {
          operation: "remove_promo",
          cartUuid: input.cartUuid,
          stateScope: "cart"
        },
        mutationOutcome: {
          code: "PROMO_MUTATION_OUTCOME_UNKNOWN",
          message:
            "DoorDash did not confirm whether the promo was removed. Do not remove it again. Create the checkout link once and verify the promotion in DoorDash checkout.",
          cartUuid: input.cartUuid,
          stateScope: "cart"
        }
      })
  );

  if (hasPurchaseAccess(context.authInfo)) {
    register(
      server,
      "list_payment_methods",
      {
        title: "List DoorDash Payment Cards",
        description:
          "List masked saved cards: brand, last four, expiry, and default status. Wallets and full card numbers are not available.",
        inputSchema: canonicalObject({}),
        annotations: annotations({ readOnly: true })
      },
      async () =>
        context.invoke(listPaymentMethodsArgs(), {
          requiresPurchaseAccess: true
        })
    );

    register(
      server,
      "order_submit",
      {
        title: "Submit DoorDash Order",
        description:
          "Place one confirmed cart. Call preview_order and copy every submit_context field, including preview_token. For a personal card, also call list_payment_methods and copy brand/last4 from the is_default card after user confirmation. expected_total_before_tip and tip are dollars. Never call this twice for one cart.",
        inputSchema: orderSubmitInputSchema({
          cart_uuid: idSchema.describe("Copy cart_uuid from preview_order."),
          preview_token: z
            .string()
            .regex(
              /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/,
              "Copy preview_token exactly from preview_order submit_context."
            )
            .describe(
              "Copy submit_context.preview_token exactly. It binds the confirmed cart contents, total, address, fulfillment, schedule, priority, credits, PIN requirement, and selected work budget."
            ),
          expected_total_before_tip: z
            .number()
            .min(0)
            .multipleOf(0.01)
            .describe(
              "Copy submit_context.expected_total_before_tip from preview_order."
            ),
          expected_delivery_address: z
            .union([z.string().min(5).max(1_000), z.null()])
            .describe(
              "Copy submit_context.expected_delivery_address exactly. It is null for pickup when DoorDash returns no delivery address."
            ),
          tip: z
            .number()
            .min(0)
            .max(10_000)
            .multipleOf(0.01)
            .describe(
              "Confirmed tip in dollars. Copy a tip_suggestions[].amount or use the user's explicit amount."
            ),
          tip_confirmed: z.literal(true),
          payment_confirmation: z.union([
            z.strictObject({
              type: z.literal("card"),
              brand: z.string().min(1).max(80),
              last4: z.string().regex(/^\d{4}$/)
            }),
            z.strictObject({
              type: z.literal("account_default"),
              acknowledgement: z.literal("USE ACCOUNT DEFAULT")
            }).describe(
              "Only after list_payment_methods cannot identify the default, browser checkout was offered, and the user explicitly accepts that unseen default."
            ),
            workBudgetConfirmationSchema
          ]),
          confirmation: z.literal("PLACE ORDER"),
          scheduled_time: z
            .string()
            .datetime({ offset: true })
            .optional()
            .describe("Copy submit_context.scheduled_time when present."),
          fulfillment: fulfillmentSchema.describe(
            "Copy submit_context.fulfillment."
          ),
          priority: z
            .boolean()
            .describe("Copy submit_context.priority."),
          apply_credits: z
            .boolean()
            .describe("Copy submit_context.apply_credits."),
          pin_handoff_required: z
            .boolean()
            .describe("Copy submit_context.pin_handoff_required."),
          pin_handoff_acknowledged: z
            .literal(true)
            .optional()
            .describe(
              "Required only when submit_context.pin_handoff_required is true, after the user accepts handing the delivery PIN to the Dasher."
            ),
          team_id: idSchema
            .optional()
            .describe("Copy work_benefits.team_id from preview_order."),
          budget_id: idSchema
            .optional()
            .describe(
              "For work payment, call preview_order with the chosen budget_id, then copy submit_context.budget_id."
            ),
          team_account_id: idSchema
            .optional()
            .describe(
              "Copy team_account_id from the same eligible budget."
            ),
          expense_code: z
            .string()
            .min(1)
            .max(500)
            .optional()
            .describe(
              "Required when the selected budget has expense_code_mode \"required\"; ask the user for the value."
            ),
          expense_notes: z
            .string()
            .min(1)
            .max(2_000)
            .optional()
            .describe(
              "Required when the selected budget has expense_note_required true; ask the user for the note."
            )
        }),
        annotations: annotations({
          readOnly: false,
          destructive: true,
          idempotent: false
        })
      },
      async (input) => context.submitOrder(input)
    );
  }

}
