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
        "Each nestedOptions entry requires option_id (preferred), optionId, or id."
    })
    .refine((option) => !selectedOptionId(option)?.startsWith("e_"), {
      message:
        "nestedOptions entries must be selected option IDs, not modifier-group IDs such as e_...."
    })
);

const cartItemSchema = z.object({
  itemId: idSchema,
  itemName: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "The menu item's real name, not a customization label. Put choices such as Sweet Corn in requestedOptions or nestedOptions."
    ),
  quantity: z.number().positive().max(10_000).default(1),
  requestedOptions: z
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
      "Selected options only. Copy option_id and name from each chosen option. Include enough entries to satisfy every modifier group whose min_selections is greater than zero. Keep ordinary selections in this top-level list; never include group_id or extra_id nodes."
    )
});

const previewOptionsSchema = {
  scheduledTime: z.string().datetime({ offset: true }).optional(),
  fulfillment: fulfillmentSchema.optional(),
  priority: z.boolean().default(false),
  includeWorkBenefits: z.boolean().default(false),
  selectedBudgetId: idSchema.optional(),
  applyCredits: z.boolean().default(true)
};

const promoInputSchema = {
  cartUuid: idSchema,
  promoCode: z.string().min(1).max(200),
  campaignId: idSchema.optional(),
  adGroupId: idSchema.optional(),
  adId: idSchema.optional()
};

function orderReferenceSchema() {
  return z
    .object({
      order_uuid: idSchema
        .optional()
        .describe(
          "Preferred: copy order_uuid exactly from list_orders or order_submit."
        ),
      orderUuid: idSchema
        .optional()
        .describe("Camel-case alias for order_uuid.")
    })
    .refine((value) => Boolean(value.order_uuid || value.orderUuid), {
      message: "Provide order_uuid (preferred) or orderUuid."
    });
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
    handler
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
        "Change the DoorDash account-wide default address. This affects the app, website, searches, previews, and future checkout links; there is no per-cart address override.",
      inputSchema: z.object({
        addressId: idSchema,
        confirmation: z.literal("SET DEFAULT ADDRESS")
      }),
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
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              name: z.string().min(1).max(300),
              quantity: z.number().positive().max(10_000).optional()
            })
          )
          .min(1)
          .max(20),
        storeId: idSchema.optional(),
        desiredMerchantName: z.string().min(1).max(300).optional(),
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
      title: "Find DoorDash Store Items",
      description:
        "Search for one or more grocery or retail products inside a specific store. Results are capped to keep catalog payloads usable.",
      inputSchema: z.object({
        storeId: idSchema,
        queries: z.array(z.string().min(1).max(300)).min(1).max(10)
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
        "Return current item pricing and options. Item IDs prefixed i_ are restaurant menu items and automatically use restaurant modifier lookup; other IDs use grocery or retail lookup. For restaurant items, menuId is optional because the server can resolve it.",
      inputSchema: z.object({
        storeId: idSchema,
        itemId: idSchema,
        menuId: idSchema.optional()
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
      inputSchema: z.object({
        storeId: idSchema
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
        "RESTAURANT ITEMS ONLY. Return pricing and every recursive modifier choice, including optional add-ons. Modifier groups describe constraints and must not be sent as cart selections. For add_cart_items, send chosen option_id nodes or plain-language requestedOptions and satisfy every group whose min_selections is greater than zero.",
      inputSchema: z.object({
        storeId: idSchema,
        menuId: idSchema,
        itemId: idSchema
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
      inputSchema: z.object({
        storeId: idSchema
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
        "Send every requested line together in one call; never add one item at a time. The server preflights all i_-prefixed restaurant items and every modifier group before making one DoorDash cart write, resolves requestedOptions such as Sweet Corn, and returns all modifier groups without changing the cart when a required choice is missing. itemName labels do not customize items. You may instead copy exact selected option_id entries as nestedOptions: [{\"option_id\":\"o_...\",\"name\":\"Chosen option\"}]; include every group whose min_selections is greater than zero, never pass group_id or extra_id nodes such as e_..., and recurse only when a selected option exposes nested groups. After success, the tool automatically returns checkout_url. Delivery uses the account-wide default address. Quantities are additive and this is not idempotent. With no cartUuid, an empty same-store cart is safely reused; a nonempty cart returns ACTIVE_CART_EXISTS so it cannot be duplicated.",
      inputSchema: z
        .object({
          storeId: idSchema,
          menuId: idSchema,
          items: z
            .array(cartItemSchema)
            .min(1)
            .max(100)
            .describe(
              "The complete batch of every requested cart line. Put differently customized copies on separate lines; use quantity only for truly identical copies."
            ),
          cartUuid: idSchema.optional(),
          fulfillment: fulfillmentSchema.default("delivery"),
          groupCart: z.boolean().default(false),
          spendLimitCents: z
            .number()
            .int()
            .min(1)
            .max(2_147_483_647)
            .optional()
        })
        .refine(
          (value) =>
            value.spendLimitCents === undefined ||
            (value.groupCart && value.cartUuid === undefined),
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
        "Empty and abandon an open cart. Start a fresh cart after deletion.",
      inputSchema: z.object({
        cartUuid: idSchema
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
      inputSchema: z.object({
        storeId: idSchema.optional()
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
        "Remove one complete cart line. cartItemId is items[].id from show cart, not the menu item ID.",
      inputSchema: z.object({
        cartUuid: idSchema,
        cartItemId: idSchema
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
        "Return cart contents and cart-line IDs. This does not return authoritative pricing or delivery address; use preview for those.",
      inputSchema: z.object({
        cartUuid: idSchema
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
        "Create a browser checkout URL without submitting or charging. The URL does not pin an address; DoorDash uses the account-wide default at checkout.",
      inputSchema: z.object({
        cartUuid: idSchema
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
        "Return authoritative items, pricing, total, delivery address, ETA, tip suggestions, credits, and work budgets. Delivery uses the account-wide default DoorDash address. Passing fulfillment changes cart mode.",
      inputSchema: z.object({
        cartUuid: idSchema,
        ...previewOptionsSchema
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
        "List consumer- and store-specific campaign promotions eligible at a store.",
      inputSchema: z.object({
        storeId: idSchema
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
        "Apply a typed or campaign promo to a cart. Campaign promos require all IDs returned by list promos.",
      inputSchema: z.object(promoInputSchema),
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
        "Remove a promo using the same code and campaign IDs used when it was applied.",
      inputSchema: z.object(promoInputSchema),
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
          "DANGEROUS: re-preview and then place a DoorDash order using the account-wide default delivery address and charging the confirmed default payment method or work budget. Never retry the same cart.",
        inputSchema: z.object({
          cartUuid: idSchema,
          expectedTotalBeforeTipCents: z.number().int().min(0),
          expectedDeliveryAddress: z.string().min(5).max(1_000),
          tipCents: z.number().int().min(0).max(1_000_000),
          tipConfirmed: z.literal(true),
          paymentConfirmation: z.discriminatedUnion("type", [
            z.object({
              type: z.literal("card"),
              brand: z.string().min(1).max(80),
              last4: z.string().regex(/^\d{4}$/)
            }),
            z.object({
              type: z.literal("account_default"),
              acknowledgement: z.literal("USE ACCOUNT DEFAULT")
            }),
            z.object({
              type: z.literal("work_budget"),
              budgetName: z.string().min(1).max(300)
            })
          ]),
          confirmation: z.literal("PLACE ORDER"),
          scheduledTime: z.string().datetime({ offset: true }).optional(),
          fulfillment: fulfillmentSchema.optional(),
          priority: z.boolean().default(false),
          applyCredits: z.boolean().default(true),
          teamId: idSchema.optional(),
          budgetId: idSchema.optional(),
          teamAccountId: idSchema.optional(),
          expenseCode: z.string().min(1).max(500).optional(),
          expenseNotes: z.string().min(1).max(2_000).optional()
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
