import * as z from "zod/v4";

import {
  addCartItemsArgs,
  applyPromoArgs,
  buildGroceryListArgs,
  checkoutLinkArgs,
  deleteCartArgs,
  findItemsArgs,
  findNearbyStoresArgs,
  listAddressesArgs,
  listCartsArgs,
  listOrdersArgs,
  listPaymentMethodsArgs,
  listPromosArgs,
  menuArgs,
  orderStatusArgs,
  previewOrderArgs,
  receiptArgs,
  removeCartItemArgs,
  removePromoArgs,
  reorderArgs,
  restaurantItemDetailsArgs,
  searchRestaurantsArgs,
  setAddressArgs,
  showCartArgs,
  storeDetailsArgs
} from "./command-args.js";
import { hasPurchaseAccess } from "./auth.js";
import { contractForTool, contracts } from "./response-contract.js";

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

const inputAliasPairs = [
  ["address_id", "addressId"],
  ["store_id", "storeId"],
  ["menu_id", "menuId"],
  ["item_id", "itemId"],
  ["cart_uuid", "cartUuid"],
  ["cart_item_id", "cartItemId"],
  ["order_uuid", "orderUuid"],
  ["promo_code", "promoCode"],
  ["campaign_id", "campaignId"],
  ["ad_group_id", "adGroupId"],
  ["ad_id", "adId"],
  ["scheduled_time", "scheduledTime"],
  ["selected_budget_id", "selectedBudgetId"],
  ["team_id", "teamId"],
  ["budget_id", "budgetId"],
  ["team_account_id", "teamAccountId"],
  ["expense_code", "expenseCode"],
  ["expense_notes", "expenseNotes"]
];

function aliasFields(
  snakeName,
  camelName,
  schema = idSchema,
  source = "a previous tool response"
) {
  return {
    [snakeName]: schema
      .optional()
      .describe(`Preferred: copy ${snakeName} exactly from ${source}.`),
    [camelName]: schema
      .optional()
      .describe(`Camel-case alias for ${snakeName}.`)
  };
}

function aliasedObject(shape, {
  required = [],
  optional = []
} = {}) {
  const references = [...required, ...optional];
  return z.object(shape).superRefine((value, context) => {
    for (const [snakeName, camelName, label = snakeName] of references) {
      const snakeValue = value[snakeName];
      const camelValue = value[camelName];
      if (
        snakeValue !== undefined &&
        camelValue !== undefined &&
        snakeValue !== camelValue
      ) {
        context.addIssue({
          code: "custom",
          path: [snakeName],
          message: `${snakeName} and ${camelName} must match when both are provided.`
        });
      }
      if (
        required.some(
          ([requiredSnake, requiredCamel]) =>
            requiredSnake === snakeName && requiredCamel === camelName
        ) &&
        snakeValue === undefined &&
        camelValue === undefined
      ) {
        context.addIssue({
          code: "custom",
          path: [snakeName],
          message: `Provide ${snakeName} (preferred) or ${camelName} for ${label}.`
        });
      }
    }
  });
}

function normalizeAliases(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const normalized = { ...value };
  for (const [snakeName, camelName] of inputAliasPairs) {
    if (
      normalized[camelName] === undefined &&
      normalized[snakeName] !== undefined
    ) {
      normalized[camelName] = normalized[snakeName];
    }
  }
  return normalized;
}

function normalizeToolInput(input) {
  const normalized = normalizeAliases(input);
  if (!normalized || typeof normalized !== "object") {
    return normalized;
  }
  if (Array.isArray(normalized.items)) {
    normalized.items = normalized.items.map((value) => {
      const item = normalizeAliases(value);
      item.itemName =
        item.name ?? item.item_name ?? item.itemName;
      item.requestedOptions =
        item.requested_options ?? item.requestedOptions;
      item.nestedOptions =
        item.nested_options ?? item.nestedOptions;
      return item;
    });
  }
  if (
    normalized.paymentConfirmation &&
    typeof normalized.paymentConfirmation === "object"
  ) {
    normalized.paymentConfirmation = {
      ...normalized.paymentConfirmation,
      budgetName:
        normalized.paymentConfirmation.budgetName ??
        normalized.paymentConfirmation.budget_name ??
        normalized.paymentConfirmation.name
    };
  }
  normalized.selectedBudgetId =
    normalized.selectedBudgetId ??
    normalized.selected_budget_id ??
    normalized.budget_id ??
    normalized.budgetId;
  return normalized;
}

function selectedOptionId(option) {
  return option.option_id || option.optionId || option.id;
}

const selectedCartOptionSchema = z.lazy(() =>
  z
    .object({
      option_id: idSchema
        .optional()
        .describe(
          "Preferred: copy option_id exactly from the chosen modifier option returned by get_menu, get_restaurant_item_details, or item_errors."
        ),
      optionId: idSchema
        .optional()
        .describe("Camel-case alias for option_id."),
      id: idSchema
        .optional()
        .describe("Legacy alias for option_id."),
      name: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          "The selected option name. Optional; when omitted, the wrapper uses the option ID."
        ),
      quantity: z.number().int().min(1).default(1),
      options: z
        .array(selectedCartOptionSchema)
        .max(50)
        .optional()
        .describe(
          "Only for a selected option that itself exposes nested modifier groups: include the selected child options here."
        )
    })
    .refine((option) => Boolean(selectedOptionId(option)), {
      message:
        "Each nested_options entry requires option_id (preferred), optionId, or id."
    })
    .refine((option) => !selectedOptionId(option)?.startsWith("e_"), {
      message:
        "nested_options entries must be selected option IDs, not modifier-group IDs such as e_...."
    })
);

const cartItemSchema = aliasedObject({
  ...aliasFields(
    "item_id",
    "itemId",
    idSchema,
    "get_menu, get_item_details, find_items, or list_orders"
  ),
  itemName: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Camel-case item-name alias. Prefer name from the menu response."
    ),
  item_name: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Snake-case alias for name."),
  name: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Preferred when copying an item from a tool response."),
  quantity: z.number().positive().max(10_000).default(1),
  requestedOptions: z
    .array(z.string().min(1).max(300))
    .max(50)
    .optional()
    .describe(
      "Camel-case alias for requested_options."
    ),
  requested_options: z
    .array(z.string().min(1).max(300))
    .max(50)
    .optional()
    .describe(
      "Current option names explicitly requested for this line, such as Sweet Corn, Rotisserie Chicken, or Utensils. The server resolves them before changing the cart and rejects unmatched choices."
    ),
  nestedOptions: z
    .array(selectedCartOptionSchema)
    .max(100)
    .optional()
    .describe(
      "Camel-case alias for nested_options."
    ),
  nested_options: z
    .array(selectedCartOptionSchema)
    .max(100)
    .optional()
    .describe(
      "Selected options only. Copy option_id and name from each chosen option. Include enough entries to satisfy every modifier group whose min_selections is greater than zero. Keep ordinary selections in this top-level list; never include group_id or extra_id nodes."
    )
}, {
  required: [["item_id", "itemId", "item ID"]]
}).superRefine((item, context) => {
  if (!item.itemName && !item.item_name && !item.name) {
    context.addIssue({
      code: "custom",
      path: ["name"],
      message: "Provide name (preferred), item_name, or itemName."
    });
  }
  const names = [item.name, item.item_name, item.itemName].filter(
    (entry) => entry !== undefined
  );
  if (new Set(names).size > 1) {
    context.addIssue({
      code: "custom",
      path: ["name"],
      message:
        "name, item_name, and itemName must match when more than one is provided."
    });
  }
  for (const [snakeName, camelName] of [
    ["requested_options", "requestedOptions"],
    ["nested_options", "nestedOptions"]
  ]) {
    if (
      item[snakeName] !== undefined &&
      item[camelName] !== undefined &&
      JSON.stringify(item[snakeName]) !== JSON.stringify(item[camelName])
    ) {
      context.addIssue({
        code: "custom",
        path: [snakeName],
        message: `${snakeName} and ${camelName} must match when both are provided.`
      });
    }
  }
});

const previewOptionsSchema = {
  ...aliasFields(
    "scheduled_time",
    "scheduledTime",
    z.string().datetime({ offset: true }),
    "preview_order or an earlier scheduling choice"
  ),
  fulfillment: fulfillmentSchema.optional(),
  priority: z.boolean().default(false),
  includeWorkBenefits: z.boolean().default(false),
  ...aliasFields(
    "selected_budget_id",
    "selectedBudgetId",
    idSchema,
    "preview_order work_benefits.eligible_budgets"
  ),
  ...aliasFields(
    "budget_id",
    "budgetId",
    idSchema,
    "preview_order work_benefits.eligible_budgets"
  ),
  applyCredits: z.boolean().default(true)
};

const promoInputSchema = {
  ...aliasFields("cart_uuid", "cartUuid", idSchema, "show_cart or list_carts"),
  ...aliasFields(
    "promo_code",
    "promoCode",
    z.string().min(1).max(200),
    "list_promos"
  ),
  ...aliasFields("campaign_id", "campaignId", idSchema, "list_promos"),
  ...aliasFields("ad_group_id", "adGroupId", idSchema, "list_promos"),
  ...aliasFields("ad_id", "adId", idSchema, "list_promos")
};

const workBudgetConfirmationSchema = z
  .object({
    type: z.literal("work_budget"),
    name: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe(
        "Preferred: copy name from preview_order work_benefits.eligible_budgets."
      ),
    ...aliasFields(
      "budget_name",
      "budgetName",
      z.string().min(1).max(300),
      "preview_order or the user's confirmation"
    )
  })
  .superRefine((value, context) => {
    const names = [value.name, value.budget_name, value.budgetName].filter(
      (entry) => entry !== undefined
    );
    if (names.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message:
          "Provide name (preferred), budget_name, or budgetName for the work budget."
      });
    }
    if (new Set(names).size > 1) {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message:
          "name, budget_name, and budgetName must match when more than one is provided."
      });
    }
  });

function orderReferenceSchema() {
  return aliasedObject(
    aliasFields(
      "order_uuid",
      "orderUuid",
      idSchema,
      "list_orders or order_submit"
    ),
    {
      required: [["order_uuid", "orderUuid", "order"]]
    }
  );
}

function orderUuidFromInput(input) {
  return input.order_uuid || input.orderUuid;
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
      outputSchema: contractForTool(name).outputSchema
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
      inputSchema: z.object({}),
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
        "Change the DoorDash account-wide default address using address_id from list_addresses. This affects the app, website, searches, previews, and future checkout links; there is no per-cart address override.",
      inputSchema: aliasedObject(
        {
          ...aliasFields(
            "address_id",
            "addressId",
            idSchema,
            "list_addresses"
          ),
          confirmation: z.literal("SET DEFAULT ADDRESS")
        },
        {
          required: [["address_id", "addressId", "address"]]
        }
      ),
      annotations: annotations({
        readOnly: false,
        idempotent: true
      })
    },
    async (input) => context.invoke(setAddressArgs(input))
  );

  register(
    server,
    "build_grocery_list",
    {
      title: "Build DoorDash Grocery List",
      description:
        "Resolve a complete grocery or household shopping list into products. This is stateless and does not create a cart.",
      inputSchema: aliasedObject({
        items: z
          .array(
            z.object({
              name: z.string().min(1).max(300),
              quantity: z.number().positive().max(10_000).optional()
            })
          )
          .min(1)
          .max(20),
        ...aliasFields(
          "store_id",
          "storeId",
          idSchema,
          "find_nearby_stores or a previous grocery result"
        ),
        desiredMerchantName: z.string().min(1).max(300).optional(),
        servings: z.number().int().min(1).max(1_000).optional()
      }, {
        optional: [["store_id", "storeId", "store"]]
      }),
      annotations: annotations({ readOnly: true })
    },
    async (input) => context.invoke(buildGroceryListArgs(input))
  );

  register(
    server,
    "find_items",
    {
      title: "Find DoorDash Store Items",
      description:
        "Search for one or more grocery or retail products inside a specific store. Results are capped to keep catalog payloads usable.",
      inputSchema: aliasedObject({
        ...aliasFields(
          "store_id",
          "storeId",
          idSchema,
          "find_nearby_stores or build_grocery_list"
        ),
        queries: z.array(z.string().min(1).max(300)).min(1).max(10)
      }, {
        required: [["store_id", "storeId", "store"]]
      }),
      annotations: annotations({ readOnly: true })
    },
    async (input) => context.invoke(findItemsArgs(input))
  );

  register(
    server,
    "find_nearby_stores",
    {
      title: "Find Nearby DoorDash Stores",
      description:
        "Discover grocery, retail, convenience, pet, alcohol, or NV stores using the account-wide default saved DoorDash address. This tool always resolves that address through list_addresses and does not accept a location override.",
      inputSchema: z.object({
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
        "Return current item pricing and options. Item IDs prefixed i_ are restaurant menu items and automatically use restaurant modifier lookup; other IDs use grocery or retail lookup. For restaurant items, menu_id is optional because the server can resolve it.",
      inputSchema: aliasedObject({
        ...aliasFields(
          "store_id",
          "storeId",
          idSchema,
          "search, menu, or item-search results"
        ),
        ...aliasFields(
          "item_id",
          "itemId",
          idSchema,
          "get_menu, find_items, or list_orders"
        ),
        ...aliasFields(
          "menu_id",
          "menuId",
          idSchema,
          "get_menu or build_grocery_list"
        )
      }, {
        required: [
          ["store_id", "storeId", "store"],
          ["item_id", "itemId", "item"]
        ],
        optional: [["menu_id", "menuId", "menu"]]
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
        "Return a restaurant menu and menu ID. Items with has_modifiers require get_item_details or get_restaurant_item_details before adding so optional add-ons are not lost and every required group is satisfied.",
      inputSchema: aliasedObject({
        ...aliasFields(
          "store_id",
          "storeId",
          idSchema,
          "search_restaurants or get_store_details"
        )
      }, {
        required: [["store_id", "storeId", "store"]]
      }),
      annotations: annotations({ readOnly: true })
    },
    async (input) => context.invoke(menuArgs(input))
  );

  register(
    server,
    "get_restaurant_item_details",
    {
      title: "Get DoorDash Restaurant Item Modifiers",
      description:
        "RESTAURANT ITEMS ONLY. Return pricing and every recursive modifier choice, including optional add-ons. Modifier groups describe constraints and must not be sent as cart selections. For add_cart_items, send chosen option_id nodes or plain-language requested_options and satisfy every group whose min_selections is greater than zero.",
      inputSchema: aliasedObject({
        ...aliasFields("store_id", "storeId", idSchema, "get_menu"),
        ...aliasFields("menu_id", "menuId", idSchema, "get_menu"),
        ...aliasFields("item_id", "itemId", idSchema, "get_menu")
      }, {
        required: [
          ["store_id", "storeId", "store"],
          ["menu_id", "menuId", "menu"],
          ["item_id", "itemId", "item"]
        ]
      }),
      annotations: annotations({ readOnly: true })
    },
    async (input) => context.invoke(restaurantItemDetailsArgs(input))
  );

  register(
    server,
    "search_restaurants",
    {
      title: "Search DoorDash Restaurants",
      description:
        "Find nearby restaurants using the account-wide default saved DoorDash address. This tool always resolves that address through list_addresses and does not accept a location override.",
      inputSchema: z.object({
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
        "Return store identity, business metadata, physical location, and fulfillment capabilities.",
      inputSchema: aliasedObject({
        ...aliasFields(
          "store_id",
          "storeId",
          idSchema,
          "search_restaurants or find_nearby_stores"
        )
      }, {
        required: [["store_id", "storeId", "store"]]
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
        "Send every requested line together in one call; never add one item at a time. Copy store_id, menu_id, item_id, and name directly from menu tools. The server preflights all i_-prefixed restaurant items and every modifier group before making one DoorDash cart write, resolves requested_options such as Sweet Corn, and returns all modifier groups without changing the cart when a required choice is missing. Name labels do not customize items. You may instead copy exact selected option_id entries as nested_options: [{\"option_id\":\"o_...\",\"name\":\"Chosen option\"}]; include every group whose min_selections is greater than zero, never pass group_id or extra_id nodes such as e_..., and recurse only when a selected option exposes nested groups. After success, the tool automatically returns checkout_url. Delivery uses the account-wide default address. Quantities are additive and this is not idempotent. With no cart_uuid, an empty same-store cart is safely reused; a nonempty cart returns ACTIVE_CART_EXISTS so it cannot be duplicated.",
      inputSchema: z
        .object({
          ...aliasFields("store_id", "storeId", idSchema, "get_menu"),
          ...aliasFields("menu_id", "menuId", idSchema, "get_menu"),
          items: z
            .array(cartItemSchema)
            .min(1)
            .max(100)
            .describe(
              "The complete batch of every requested cart line. Put differently customized copies on separate lines; use quantity only for truly identical copies."
            ),
          ...aliasFields(
            "cart_uuid",
            "cartUuid",
            idSchema,
            "show_cart or list_carts"
          ),
          fulfillment: fulfillmentSchema.default("delivery"),
          groupCart: z.boolean().default(false),
          spendLimitCents: z
            .number()
            .int()
            .min(1)
            .max(2_147_483_647)
            .optional()
        })
        .superRefine((value, context) => {
          for (const [snakeName, camelName, label] of [
            ["store_id", "storeId", "store"],
            ["menu_id", "menuId", "menu"]
          ]) {
            if (!value[snakeName] && !value[camelName]) {
              context.addIssue({
                code: "custom",
                path: [snakeName],
                message: `Provide ${snakeName} (preferred) or ${camelName} for ${label}.`
              });
            }
            if (
              value[snakeName] &&
              value[camelName] &&
              value[snakeName] !== value[camelName]
            ) {
              context.addIssue({
                code: "custom",
                path: [snakeName],
                message: `${snakeName} and ${camelName} must match when both are provided.`
              });
            }
          }
          if (
            value.cart_uuid &&
            value.cartUuid &&
            value.cart_uuid !== value.cartUuid
          ) {
            context.addIssue({
              code: "custom",
              path: ["cart_uuid"],
              message:
                "cart_uuid and cartUuid must match when both are provided."
            });
          }
        })
        .refine(
          (value) =>
            value.spendLimitCents === undefined ||
            (value.groupCart &&
              value.cartUuid === undefined &&
              value.cart_uuid === undefined),
          {
            message:
              "spendLimitCents requires a new group cart and cannot be used with cartUuid."
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
        "Empty and abandon an open cart using cart_uuid from list_carts or show_cart. Start a fresh cart after deletion.",
      inputSchema: aliasedObject({
        ...aliasFields(
          "cart_uuid",
          "cartUuid",
          idSchema,
          "list_carts or show_cart"
        )
      }, {
        required: [["cart_uuid", "cartUuid", "cart"]]
      }),
      annotations: annotations({
        readOnly: false,
        destructive: true,
        idempotent: false
      })
    },
    async (input) => context.invoke(deleteCartArgs(input))
  );

  register(
    server,
    "list_carts",
    {
      title: "List DoorDash Carts",
      description:
        "List active unsubmitted carts, optionally filtered by store. Use this before additive cart mutations.",
      inputSchema: aliasedObject({
        ...aliasFields(
          "store_id",
          "storeId",
          idSchema,
          "search_restaurants, find_nearby_stores, or get_menu"
        )
      }, {
        optional: [["store_id", "storeId", "store"]]
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
        "Remove one complete cart line. Copy cart_uuid and items[].cart_item_id from show_cart; cart_item_id is not the menu item ID.",
      inputSchema: aliasedObject({
        ...aliasFields("cart_uuid", "cartUuid", idSchema, "show_cart"),
        ...aliasFields(
          "cart_item_id",
          "cartItemId",
          idSchema,
          "show_cart items"
        )
      }, {
        required: [
          ["cart_uuid", "cartUuid", "cart"],
          ["cart_item_id", "cartItemId", "cart line"]
        ]
      }),
      annotations: annotations({
        readOnly: false,
        destructive: true,
        idempotent: false
      })
    },
    async (input) => context.invoke(removeCartItemArgs(input))
  );

  register(
    server,
    "show_cart",
    {
      title: "Show DoorDash Cart",
      description:
        "Return cart contents and cart-line IDs using cart_uuid from list_carts, reorder, or add_cart_items. This does not return authoritative pricing or delivery address; use preview for those.",
      inputSchema: aliasedObject({
        ...aliasFields(
          "cart_uuid",
          "cartUuid",
          idSchema,
          "list_carts, reorder, or add_cart_items"
        )
      }, {
        required: [["cart_uuid", "cartUuid", "cart"]]
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
      inputSchema: aliasedObject({
        ...aliasFields(
          "cart_uuid",
          "cartUuid",
          idSchema,
          "show_cart, list_carts, reorder, or add_cart_items"
        )
      }, {
        required: [["cart_uuid", "cartUuid", "cart"]]
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
        "Return recent order history. Large 365-day/100-order requests may fail upstream; use narrower windows when needed.",
      inputSchema: z.object({
        max: z.number().int().min(1).max(100).default(50),
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
        "Return authoritative items, pricing, total, delivery address, ETA, tip suggestions, credits, and work budgets for cart_uuid. Delivery uses the account-wide default DoorDash address. Passing fulfillment changes cart mode.",
      inputSchema: aliasedObject(
        {
          ...aliasFields(
            "cart_uuid",
            "cartUuid",
            idSchema,
            "show_cart, list_carts, reorder, or add_cart_items"
          ),
          ...previewOptionsSchema
        },
        {
          required: [["cart_uuid", "cartUuid", "cart"]],
          optional: [
            ["scheduled_time", "scheduledTime", "schedule"],
            ["selected_budget_id", "selectedBudgetId", "work budget"],
            ["budget_id", "budgetId", "work budget"]
          ]
        }
      ).superRefine((value, context) => {
        const budgetIds = [
          value.selected_budget_id,
          value.selectedBudgetId,
          value.budget_id,
          value.budgetId
        ].filter((entry) => entry !== undefined);
        if (new Set(budgetIds).size > 1) {
          context.addIssue({
            code: "custom",
            path: ["budget_id"],
            message:
              "budget_id, budgetId, selected_budget_id, and selectedBudgetId must match when more than one is provided."
          });
        }
      }),
      annotations: annotations({
        readOnly: false,
        idempotent: true
      })
    },
    async (input) => context.invoke(previewOrderArgs(input))
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
    async (input) =>
      context.invoke(
        receiptArgs({ orderUuid: orderUuidFromInput(input) })
      )
  );

  register(
    server,
    "reorder",
    {
      title: "Reorder DoorDash Order",
      description:
        "Create a new cart from a past order using order_uuid from list_orders. Compare the new cart with history because unavailable items can be silently dropped.",
      inputSchema: orderReferenceSchema(),
      annotations: annotations({
        readOnly: false,
        idempotent: false
      })
    },
    async (input) =>
      context.invoke(
        reorderArgs({ orderUuid: orderUuidFromInput(input) })
      )
  );

  register(
    server,
    "order_status",
    {
      title: "Check DoorDash Order Status",
      description:
        "Check whether a submitted order is pending, successful, action required, failed, or not found. Copy order_uuid exactly from list_orders or order_submit; orderUuid remains accepted as an alias.",
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
      inputSchema: aliasedObject({
        ...aliasFields(
          "store_id",
          "storeId",
          idSchema,
          "search_restaurants, find_nearby_stores, or get_menu"
        )
      }, {
        required: [["store_id", "storeId", "store"]]
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
      inputSchema: aliasedObject(promoInputSchema, {
        required: [
          ["cart_uuid", "cartUuid", "cart"],
          ["promo_code", "promoCode", "promotion"]
        ],
        optional: [
          ["campaign_id", "campaignId", "campaign"],
          ["ad_group_id", "adGroupId", "ad group"],
          ["ad_id", "adId", "advertisement"]
        ]
      }),
      annotations: annotations({
        readOnly: false,
        idempotent: false
      })
    },
    async (input) => context.invoke(applyPromoArgs(input))
  );

  register(
    server,
    "remove_promo",
    {
      title: "Remove DoorDash Promotion",
      description:
        "Remove a promo using the same promo_code and campaign IDs returned by list_promos and used when it was applied.",
      inputSchema: aliasedObject(promoInputSchema, {
        required: [
          ["cart_uuid", "cartUuid", "cart"],
          ["promo_code", "promoCode", "promotion"]
        ],
        optional: [
          ["campaign_id", "campaignId", "campaign"],
          ["ad_group_id", "adGroupId", "ad group"],
          ["ad_id", "adId", "advertisement"]
        ]
      }),
      annotations: annotations({
        readOnly: false,
        destructive: true,
        idempotent: false
      })
    },
    async (input) => context.invoke(removePromoArgs(input))
  );

  if (hasPurchaseAccess(context.authInfo)) {
    register(
      server,
      "list_payment_methods",
      {
        title: "List DoorDash Payment Cards",
        description:
          "List masked saved cards: brand, last four, expiry, and default status. Wallets and full card numbers are not available.",
        inputSchema: z.object({}),
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
          "DANGEROUS: re-preview and then place cart_uuid using the account-wide default delivery address and charging the confirmed default payment method or work budget. Copy work-benefit IDs from preview_order. Never retry the same cart.",
        inputSchema: aliasedObject({
          ...aliasFields(
            "cart_uuid",
            "cartUuid",
            idSchema,
            "preview_order"
          ),
          expectedTotalBeforeTipCents: z.number().int().min(0),
          expectedDeliveryAddress: z.string().min(5).max(1_000),
          tipCents: z.number().int().min(0).max(1_000_000),
          tipConfirmed: z.literal(true),
          paymentConfirmation: z.union([
            z.object({
              type: z.literal("card"),
              brand: z.string().min(1).max(80),
              last4: z.string().regex(/^\d{4}$/)
            }),
            z.object({
              type: z.literal("account_default"),
              acknowledgement: z.literal("USE ACCOUNT DEFAULT")
            }),
            workBudgetConfirmationSchema
          ]),
          confirmation: z.literal("PLACE ORDER"),
          ...aliasFields(
            "scheduled_time",
            "scheduledTime",
            z.string().datetime({ offset: true }),
            "preview_order or an earlier scheduling choice"
          ),
          fulfillment: fulfillmentSchema.optional(),
          priority: z.boolean().default(false),
          applyCredits: z.boolean().default(true),
          ...aliasFields(
            "team_id",
            "teamId",
            idSchema,
            "preview_order work_benefits"
          ),
          ...aliasFields(
            "budget_id",
            "budgetId",
            idSchema,
            "preview_order eligible_budgets"
          ),
          ...aliasFields(
            "team_account_id",
            "teamAccountId",
            idSchema,
            "preview_order eligible_budgets"
          ),
          ...aliasFields(
            "expense_code",
            "expenseCode",
            z.string().min(1).max(500),
            "the user's work-expense choice"
          ),
          ...aliasFields(
            "expense_notes",
            "expenseNotes",
            z.string().min(1).max(2_000),
            "the user's work-expense choice"
          )
        }, {
          required: [["cart_uuid", "cartUuid", "cart"]],
          optional: [
            ["scheduled_time", "scheduledTime", "schedule"],
            ["team_id", "teamId", "work-benefits team"],
            ["budget_id", "budgetId", "work budget"],
            ["team_account_id", "teamAccountId", "team account"],
            ["expense_code", "expenseCode", "expense code"],
            ["expense_notes", "expenseNotes", "expense notes"]
          ]
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

  register(
    server,
    "activity",
    {
      title: "DoorDash Activity",
      description:
        "Return recent MCP-routed DoorDash CLI calls and complete unredacted results, newest first.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20)
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ limit }) =>
      context.toolResult(
        {
          count: context.activityLog.size,
          entries: context.activityLog.list(limit)
        },
        contracts.activity
      )
  );

  register(
    server,
    "run",
    {
      title: "Run Safe DoorDash CLI Command",
      description:
        "Debug fallback for future CLI commands without typed tools. Login, help, version, payment methods, and order submission are permanently blocked here.",
      inputSchema: z.object({
        args: z
          .array(z.string().min(1).max(4_096))
          .min(1)
          .max(64)
      }),
      annotations: annotations({
        readOnly: false,
        destructive: true,
        idempotent: false
      })
    },
    async ({ args }) =>
      context.invoke(args, {
        contract: contracts.rawCli,
        generic: true
      })
  );
}
