import assert from "node:assert/strict";
import test from "node:test";

import { createDoorDashApp } from "../src/app.js";
import { SecurityStore } from "../src/security-store.js";

function createTestApp(options) {
  return createDoorDashApp({
    adminAccessToken: "test-admin-secret",
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

async function mcpRequest(handler, authInfo, method, params, id = 1) {
  const body = {
    jsonrpc: "2.0",
    id,
    method,
    params
  };
  const request = new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25"
    },
    body: JSON.stringify(body)
  });
  const response = await handler.fetch(request, {
    authInfo
  });
  const text = await response.text();
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "));
  return {
    status: response.status,
    body: dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(text)
  };
}

function authInfo(store, token) {
  const record = store.verifyToken(token);
  return {
    token,
    clientId: record.id,
    scopes: record.scopes,
    expiresAt: record.expiresAt
  };
}

function assertTypedOutputSchema(tool) {
  assert.equal(tool.outputSchema?.type, "object");
  assert.equal(tool.outputSchema?.anyOf?.length, 2);
  const branches = tool.outputSchema.anyOf;
  assert.equal(branches.every((schema) => schema.type === "object"), true);
  assert.equal(
    branches.filter((schema) => schema.properties?.error).length,
    1
  );
  assert.equal(
    branches.filter((schema) => !schema.properties?.error).length,
    1
  );
}

test("purchase tools appear only for tokens with the checkbox enabled", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async () => {
      throw new Error("CLI should not run during tools/list.");
    }
  });

  const safeList = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/list",
    {}
  );
  const safeNames = safeList.body.result.tools.map((tool) => tool.name);
  assert.equal(safeNames.includes("list_payment_methods"), false);
  assert.equal(safeNames.includes("order_submit"), false);
  for (const tool of safeList.body.result.tools) {
    assertTypedOutputSchema(tool);
  }

  store.setPurchaseAccess(token.id, true);
  const purchaseList = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/list",
    {},
    2
  );
  const purchaseNames = purchaseList.body.result.tools.map((tool) => tool.name);
  assert.equal(purchaseNames.length, 25);
  assert.ok(
    JSON.stringify(purchaseList.body.result.tools).length < 55_000,
    "purchase-enabled tools/list should stay below 55 KB"
  );
  assert.equal(purchaseNames.includes("list_payment_methods"), true);
  assert.equal(purchaseNames.includes("order_submit"), true);
  assert.match(
    JSON.stringify(
      purchaseList.body.result.tools.find(
        (tool) => tool.name === "order_submit"
      ).inputSchema
    ),
    /Only after list_payment_methods cannot identify the default/
  );
  const orderListMax = purchaseList.body.result.tools.find(
    (tool) => tool.name === "list_orders"
  ).inputSchema.properties.max;
  assert.equal(orderListMax.default, 10);
  assert.equal(orderListMax.maximum, 25);
  assert.equal(
    purchaseNames.some((name) => name.startsWith("doordash_")),
    false
  );
  for (const tool of purchaseList.body.result.tools) {
    assertTypedOutputSchema(tool);
  }
  const successSchema = (name) =>
    purchaseList.body.result.tools
      .find((tool) => tool.name === name)
      .outputSchema.anyOf.find((schema) => !schema.properties?.error);
  assert.ok(
    successSchema("get_item_details").properties.item.properties
      .modifier_groups
  );
  assert.ok(successSchema("get_item_details").properties.menu_id);
  assert.ok(successSchema("build_grocery_list").properties.store);
  assert.ok(successSchema("build_grocery_list").properties.available_stores);
  assert.ok(successSchema("add_cart_items").properties.item_errors);
  assert.ok(successSchema("add_cart_items").properties.fulfillment);
  assert.ok(successSchema("preview_order").properties.submit_context);
  assert.ok(successSchema("preview_order").properties.work_benefits);
  assert.ok(successSchema("order_submit").properties.order_uuid);
  const previewTool = purchaseList.body.result.tools.find(
    (tool) => tool.name === "preview_order"
  );
  const addTool = purchaseList.body.result.tools.find(
    (tool) => tool.name === "add_cart_items"
  );
  assert.equal(
    addTool.inputSchema.properties.fulfillment.default,
    undefined
  );
  assert.equal(
    previewTool.inputSchema.properties.fulfillment.default,
    undefined
  );

  await mcpHandler.close();
  store.close();
});

test("required work expense details fail before the one-shot submit lock", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Purchase",
    allowPurchases: true
  });
  const calls = [];
  const previewResult = {
    success: true,
    cart_uuid: "cart-work",
    quote: {
      total_before_tip: { unit_amount: 3000 },
      delivery_address: {
        printable_address: "123 Main St, Oakland, CA 94611"
      },
      company_payment_info: {
        team_order_info: {
          team_id: "team-1"
        }
      },
      expense_order_options: {
        all_eligible_expense_order_budgets: [
          {
            id: "budget-1",
            name: "Dinner",
            team_account_id: "account-1",
            expense_code_mode: "required",
            is_expense_note_required: true
          }
        ]
      },
      store_order_cart: {
        orders: []
      }
    }
  };
  const { mcpHandler } = createTestApp({
    securityStore: store,
    pollDelay: async () => {},
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "order" && args[1] === "preview") {
        return cliResult(previewResult);
      }
      if (args[0] === "order" && args[1] === "submit") {
        return cliResult({
          success: true,
          order_uuid: "order-work"
        });
      }
      if (args[0] === "order" && args[1] === "status") {
        return cliResult({
          order: {
            order_uuid: "order-work",
            status: "successful"
          }
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  const auth = authInfo(store, token.token);
  const preview = await mcpRequest(
    mcpHandler,
    auth,
    "tools/call",
    {
      name: "preview_order",
      arguments: {
        cart_uuid: "cart-work",
        fulfillment: "delivery",
        priority: false,
        budget_id: "budget-1",
        apply_credits: true
      }
    }
  );
  const context = preview.body.result.structuredContent.submit_context;
  assert.equal(context.budget_id, "budget-1");
  const confirmedArguments = {
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
  };

  const missingDetails = await mcpRequest(
    mcpHandler,
    auth,
    "tools/call",
    {
      name: "order_submit",
      arguments: confirmedArguments
    },
    2
  );
  assert.equal(missingDetails.body.result.isError, true);
  assert.equal(
    missingDetails.body.result.structuredContent.error.code,
    "WORK_EXPENSE_DETAILS_REQUIRED"
  );
  assert.equal(store.getSubmissionAttempt("cart-work"), null);

  const submitted = await mcpRequest(
    mcpHandler,
    auth,
    "tools/call",
    {
      name: "order_submit",
      arguments: {
        ...confirmedArguments,
        expense_code: "TEAM-DINNER",
        expense_notes: "Customer workshop"
      }
    },
    3
  );
  assert.equal(
    submitted.body.result.isError,
    undefined,
    JSON.stringify(submitted.body)
  );
  assert.equal(
    store.getSubmissionAttempt("cart-work").status,
    "successful"
  );
  assert.equal(
    calls.filter(
      (args) => args[0] === "order" && args[1] === "submit"
    ).length,
    1
  );

  await mcpHandler.close();
  store.close();
});

test("discovery exposes no location override and documents the default address", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async () => {
      throw new Error("CLI should not run during tools/list.");
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/list",
    {}
  );

  for (const name of ["search_restaurants", "find_nearby_stores"]) {
    const tool = response.body.result.tools.find((entry) => entry.name === name);
    assert.ok(tool);
    assert.equal("lat" in tool.inputSchema.properties, false);
    assert.equal("lng" in tool.inputSchema.properties, false);
    assert.match(tool.description, /account-wide default/);
    assert.match(tool.description, /[Ll]ocation overrides? (?:are|is) not accepted|does not accept a location override/);
  }

  await mcpHandler.close();
  store.close();
});

test("cart tools instruct callers to satisfy required options and return checkout", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async () => {
      throw new Error("CLI should not run during tools/list.");
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/list",
    {}
  );
  const addTool = response.body.result.tools.find(
    (tool) => tool.name === "add_cart_items"
  );
  const genericDetailTool = response.body.result.tools.find(
    (tool) => tool.name === "get_item_details"
  );

  assert.ok(addTool);
  assert.match(addTool.description, /complete requested batch once/);
  assert.match(addTool.description, /exact item name/);
  assert.match(addTool.description, /requested_options or nested_options/);
  assert.match(addTool.description, /every required modifier group/);
  assert.match(addTool.description, /preflight error makes no cart change/);
  assert.match(addTool.description, /partial-add result.*never resend/);
  assert.match(addTool.description, /Success normally returns checkout_url/);
  assert.match(JSON.stringify(addTool.inputSchema), /"option_id"/);
  assert.ok(addTool.inputSchema.properties.items);
  assert.equal(addTool.inputSchema.properties.items.maxItems, 20);
  assert.equal(
    JSON.stringify(addTool.inputSchema).includes('"requestedOptions"'),
    false
  );
  assert.ok(genericDetailTool);
  assert.match(genericDetailTool.description, /prefixed i_/);
  assert.ok(genericDetailTool.inputSchema.properties.menu_id);
  assert.equal(
    "menuId" in genericDetailTool.inputSchema.properties,
    false
  );
  for (const tool of [genericDetailTool, addTool]) {
    const modifierGroup = Object.values(tool.outputSchema.$defs || {}).find(
      (schema) =>
        schema.properties?.options?.items?.properties?.modifier_groups
    );
    assert.ok(modifierGroup, `${tool.name} must advertise nested modifiers`);
    assert.equal(
      modifierGroup.properties.options.items.properties.option_id.type,
      "string"
    );
    assert.match(
      modifierGroup.properties.options.items.properties.modifier_groups
        .items.$ref,
      /^#\/\$defs\//
    );
  }

  await mcpHandler.close();
  store.close();
});

test("generic item details auto-routes restaurant IDs and resolves the menu", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "menu") {
        return cliResult({
          menu_id: "menu-1",
          items: []
        });
      }
      if (args[0] === "restaurant-item-details") {
        return cliResult({
          item: {
            item_id: "i_12901175286",
            name: "Spicy TanTan",
            has_modifiers: true,
            extras: [
              {
                extra_id: "e_utensils",
                title: "Utensils",
                min_num_options: 1,
                max_num_options: 1,
                options: [
                  {
                    option_id: "o_yes",
                    name: "Utensils : Yes"
                  },
                  {
                    option_id: "o_no",
                    name: "Utensils : No"
                  }
                ]
              }
            ]
          }
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "get_item_details",
      arguments: {
        storeId: "store-1",
        itemId: "i_12901175286"
      }
    }
  );

  assert.equal(response.body.result.isError, undefined);
  assert.equal(
    response.body.result.structuredContent.item.name,
    "Spicy TanTan"
  );
  assert.equal(
    response.body.result.structuredContent.item.has_required_modifiers,
    true
  );
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["menu", "restaurant-item-details"]
  );
  assert.equal(
    calls[1][calls[1].indexOf("--item-id") + 1],
    "12901175286"
  );

  await mcpHandler.close();
  store.close();
});

test("get_menu query returns only matching menu items", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      assert.deepEqual(args, ["menu", "--store-id", "store-1"]);
      return cliResult({
        menu_id: "menu-1",
        items: [
          {
            item_id: "i_ramen",
            name: "Spicy TanTan",
            description: "Sesame broth"
          },
          {
            item_id: "i_rice",
            name: "Chashu Rice Bowl"
          }
        ]
      });
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "get_menu",
      arguments: {
        store_id: "store-1",
        query: "Spicy Tan Tan Men"
      }
    }
  );

  assert.equal(response.body.result.isError, undefined);
  assert.deepEqual(
    response.body.result.structuredContent.items.map((item) => item.item_id),
    ["i_ramen"]
  );

  await mcpHandler.close();
  store.close();
});

test("get_menu query does not reverse-match shorter item names", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async () =>
      cliResult({
        menu_id: "menu-1",
        items: [
          { item_id: "i_tea", name: "Tea" },
          { item_id: "i_steak", name: "Steak Frites" }
        ]
      })
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "get_menu",
      arguments: {
        store_id: "store-1",
        query: "steak"
      }
    }
  );

  assert.deepEqual(
    response.body.result.structuredContent.items.map(
      (item) => item.item_id
    ),
    ["i_steak"]
  );
  const teaResponse = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "get_menu",
      arguments: {
        store_id: "store-1",
        query: "tea"
      }
    },
    2
  );
  assert.deepEqual(
    teaResponse.body.result.structuredContent.items.map(
      (item) => item.item_id
    ),
    ["i_tea"]
  );

  await mcpHandler.close();
  store.close();
});

test("get_menu returns an empty result for a valid category-only query miss", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async () =>
      cliResult({
        menu_id: "menu-1",
        categories: [
          {
            name: "Rice",
            items: [
              {
                item_id: "i_rice",
                name: "Chashu Rice Bowl"
              }
            ]
          }
        ]
      })
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "get_menu",
      arguments: {
        store_id: "store-1",
        query: "Spicy Tan Tan Men"
      }
    }
  );

  assert.equal(response.body.result.isError, undefined);
  assert.deepEqual(response.body.result.structuredContent.items, []);
  assert.match(
    response.body.result.content[0].text,
    /Do not repeat it unchanged.*without query/
  );

  await mcpHandler.close();
  store.close();
});

test("order status accepts order_uuid copied from list_orders", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      return cliResult({
        order_uuid: "order-1",
        status: "successful"
      });
    }
  });

  const list = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/list",
    {}
  );
  const statusTool = list.body.result.tools.find(
    (tool) => tool.name === "order_status"
  );
  assert.ok(statusTool.inputSchema.properties.order_uuid);
  assert.equal(
    "orderUuid" in statusTool.inputSchema.properties,
    false
  );
  assert.match(
    statusTool.description,
    /Copy order_uuid from list_orders or order_submit/
  );

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "order_status",
      arguments: {
        order_uuid: "order-1"
      }
    }
  );

  assert.equal(response.body.result.isError, undefined);
  assert.equal(
    response.body.result.structuredContent.order_uuid,
    "order-1"
  );
  assert.deepEqual(calls[0], [
    "order",
    "status",
    "--order-uuid",
    "order-1"
  ]);

  await mcpHandler.close();
  store.close();
});

test("every emitted identifier is accepted by its consuming tool", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Purchase",
    allowPurchases: true
  });
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async () => {
      throw new Error("CLI should not run during tools/list.");
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/list",
    {}
  );
  const tools = new Map(
    response.body.result.tools.map((tool) => [tool.name, tool])
  );
  const expectedFields = {
    set_default_address: ["address_id"],
    build_grocery_list: ["store_id"],
    find_items: ["store_id"],
    get_item_details: ["store_id", "item_id", "menu_id"],
    get_menu: ["store_id"],
    get_store_details: ["store_id"],
    add_cart_items: ["store_id", "menu_id", "cart_uuid"],
    delete_cart: ["cart_uuid", "confirmation"],
    list_carts: ["store_id"],
    remove_cart_item: ["cart_uuid", "cart_item_id"],
    show_cart: ["cart_uuid"],
    create_checkout_link: ["cart_uuid"],
    preview_order: [
      "cart_uuid",
      "scheduled_time",
      "budget_id"
    ],
    get_receipt: ["order_uuid"],
    reorder: ["order_uuid"],
    order_status: ["order_uuid"],
    list_promos: ["store_id"],
    apply_promo: [
      "cart_uuid",
      "promo_code",
      "campaign_id",
      "ad_group_id",
      "ad_id"
    ],
    remove_promo: [
      "cart_uuid",
      "promo_code",
      "campaign_id",
      "ad_group_id",
      "ad_id"
    ],
    order_submit: [
      "cart_uuid",
      "preview_token",
      "expected_total_before_tip",
      "expected_delivery_address",
      "tip",
      "tip_confirmed",
      "payment_confirmation",
      "confirmation",
      "scheduled_time",
      "fulfillment",
      "priority",
      "apply_credits",
      "pin_handoff_required",
      "pin_handoff_acknowledged",
      "team_id",
      "budget_id",
      "team_account_id",
      "expense_code",
      "expense_notes"
    ]
  };

  for (const [toolName, fields] of Object.entries(expectedFields)) {
    const tool = tools.get(toolName);
    assert.ok(tool, `${toolName} should be registered`);
    for (const field of fields) {
      assert.ok(
        tool.inputSchema.properties[field],
        `${toolName} should accept ${field}`
      );
    }
  }
  assert.ok(
    tools.get("order_submit").inputSchema.required.includes("preview_token")
  );

  const addSchema = JSON.stringify(tools.get("add_cart_items").inputSchema);
  for (const field of [
    "item_id",
    "name",
    "requested_options",
    "nested_options",
    "option_id"
  ]) {
    assert.match(addSchema, new RegExp(`"${field}"`));
  }
  for (const removedTool of [
    "activity",
    "get_restaurant_item_details",
    "run"
  ]) {
    assert.equal(tools.has(removedTool), false);
  }

  const publicSchemas = JSON.stringify(
    [...tools.values()].map((tool) => tool.inputSchema)
  );
  for (const hiddenLegacyName of [
    "cartUuid",
    "itemId",
    "menuId",
    "previewToken",
    "requestedOptions",
    "selectedBudgetId",
    "storeId",
    "tipCents"
  ]) {
    assert.equal(
      publicSchemas.includes(`"${hiddenLegacyName}"`),
      false,
      `${hiddenLegacyName} must not appear in tools/list`
    );
  }

  await mcpHandler.close();
  store.close();
});

test("snake-case IDs route through address, item, cart, and promo tools", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "address") {
        return cliResult({
          success: true,
          address_id: "address-1"
        });
      }
      if (args[0] === "restaurant-item-details") {
        return cliResult({
          item: {
            item_id: "i_item-1",
            name: "Item"
          }
        });
      }
      if (args[0] === "order" && args[1] === "preview") {
        return cliResult({
          success: true,
          cart_uuid: "cart-1",
          quote: {
            total_before_tip: {
              unit_amount: 2500,
              display_string: "$25.00"
            },
            delivery_address: {
              printable_address: "21 Bay Forest Dr, Oakland, CA 94611"
            },
            store_order_cart: {
              orders: []
            }
          }
        });
      }
      return cliResult({
        success: true,
        message: "Updated."
      });
    }
  });
  const auth = authInfo(store, token.token);

  const requests = [
    {
      name: "set_default_address",
      arguments: {
        address_id: "address-1",
        confirmation: "SET DEFAULT ADDRESS"
      }
    },
    {
      name: "get_item_details",
      arguments: {
        store_id: "store-1",
        menu_id: "menu-1",
        item_id: "i_item-1"
      }
    },
    {
      name: "remove_cart_item",
      arguments: {
        cart_uuid: "cart-1",
        cart_item_id: "line-1"
      }
    },
    {
      name: "apply_promo",
      arguments: {
        cart_uuid: "cart-1",
        promo_code: "SAVE",
        campaign_id: "campaign-1",
        ad_group_id: "group-1",
        ad_id: "ad-1"
      }
    },
    {
      name: "preview_order",
      arguments: {
        cart_uuid: "cart-1",
        budget_id: "budget-1",
        fulfillment: "delivery"
      }
    }
  ];

  for (const [index, request] of requests.entries()) {
    const response = await mcpRequest(
      mcpHandler,
      auth,
      "tools/call",
      request,
      index + 1
    );
    assert.equal(
      response.body.result.isError,
      undefined,
      response.body.result.content[0].text
    );
  }

  assert.deepEqual(calls, [
    ["address", "set", "--address-id", "address-1", "--yes"],
    [
      "restaurant-item-details",
      "--store-id",
      "store-1",
      "--menu-id",
      "menu-1",
      "--item-id",
      "item-1"
    ],
    [
      "cart",
      "remove-item",
      "--cart-uuid",
      "cart-1",
      "--cart-item-id",
      "line-1"
    ],
    [
      "promo",
      "apply",
      "--cart-uuid",
      "cart-1",
      "--promo-code",
      "SAVE",
      "--campaign-id",
      "campaign-1",
      "--ad-group-id",
      "group-1",
      "--ad-id",
      "ad-1"
    ],
    [
      "order",
      "preview",
      "--cart-uuid",
      "cart-1",
      "--fulfillment",
      "delivery",
      "--include-work-benefits",
      "--selected-budget-id",
      "budget-1"
    ]
  ]);

  await mcpHandler.close();
  store.close();
});

test("conflicting snake-case and camel-case IDs fail before the CLI", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  let cliCalls = 0;
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async () => {
      cliCalls += 1;
      return cliResult({});
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "show_cart",
      arguments: {
        cart_uuid: "cart-1",
        cartUuid: "cart-2"
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.match(
    response.body.result.content[0].text,
    /cart_uuid, cartUuid must match/
  );
  assert.equal(cliCalls, 0);

  await mcpHandler.close();
  store.close();
});

test("legacy camel-case aliases work without appearing in tools/list", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      return cliResult({
        cart_uuid: "cart-legacy",
        cart: {
          id: "cart-legacy",
          items: []
        }
      });
    }
  });
  const auth = authInfo(store, token.token);

  const list = await mcpRequest(mcpHandler, auth, "tools/list", {});
  const showCart = list.body.result.tools.find(
    (tool) => tool.name === "show_cart"
  );
  assert.ok(showCart.inputSchema.properties.cart_uuid);
  assert.equal("cartUuid" in showCart.inputSchema.properties, false);

  const response = await mcpRequest(
    mcpHandler,
    auth,
    "tools/call",
    {
      name: "show_cart",
      arguments: {
        cartUuid: "cart-legacy"
      }
    },
    2
  );

  assert.equal(response.body.result.isError, undefined);
  assert.equal(
    response.body.result.structuredContent.cart_uuid,
    "cart-legacy"
  );
  assert.deepEqual(calls, [
    ["cart", "show", "--cart-uuid", "cart-legacy"]
  ]);

  await mcpHandler.close();
  store.close();
});

test("unknown mutation fields are rejected before the CLI", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  let cliCalls = 0;
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async () => {
      cliCalls += 1;
      return cliResult({});
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "apply_promo",
      arguments: {
        cart_uuid: "cart-1",
        promo_code: "SAVE",
        retry: true
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.match(response.body.result.content[0].text, /retry/);
  assert.equal(cliCalls, 0);

  await mcpHandler.close();
  store.close();
});

test("delete_cart requires explicit confirmation before deleting", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      return cliResult({
        success: true,
        cart_uuid: "cart-1",
        message: "Cart deleted."
      });
    }
  });
  const auth = authInfo(store, token.token);

  const rejected = await mcpRequest(
    mcpHandler,
    auth,
    "tools/call",
    {
      name: "delete_cart",
      arguments: {
        cart_uuid: "cart-1"
      }
    }
  );
  assert.equal(rejected.body.result.isError, true);
  assert.match(rejected.body.result.content[0].text, /confirmation/);
  assert.deepEqual(calls, []);

  const confirmed = await mcpRequest(
    mcpHandler,
    auth,
    "tools/call",
    {
      name: "delete_cart",
      arguments: {
        cart_uuid: "cart-1",
        confirmation: "DELETE CART"
      }
    },
    2
  );
  assert.equal(confirmed.body.result.isError, undefined);
  assert.deepEqual(calls, [
    ["cart", "delete", "--cart-uuid", "cart-1"]
  ]);

  await mcpHandler.close();
  store.close();
});

test("add cart returns a checkout URL after adding fully selected items", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "restaurant-item-details") {
        return cliResult({
          item: {
            item_id: "i_10523709271",
            name: "Enchiladas Verdes",
            extras: [
              {
                extra_id: "e_beans",
                title: "Choice of Beans",
                min_num_options: 1,
                max_num_options: 1,
                options: [
                  {
                    option_id: "o_31172333376",
                    name: "Oaxacan Refried Black"
                  }
                ]
              },
              {
                extra_id: "e_protein",
                title: "Choice of Protein",
                min_num_options: 1,
                max_num_options: 1,
                options: [
                  {
                    option_id: "o_42978512124",
                    name: "Rotisserie Chicken"
                  }
                ]
              }
            ]
          }
        });
      }
      if (args[0] === "cart" && args[1] === "list") {
        return cliResult({ carts: [] });
      }
      if (args[0] === "cart" && args[1] === "add-items") {
        return cliResult({
          success: true,
          cart_uuid: "cart-1",
          cart: {
            id: "cart-1",
            store_id: "store-1",
            store_name: "Mercado",
            items: [
              {
                id: "line-1",
                item_id: "10523709271",
                name: "Enchiladas Verdes",
                quantity: 2
              }
            ]
          }
        });
      }
      if (args[0] === "order" && args[1] === "checkout-url") {
        return cliResult({
          cart_uuid: "cart-1",
          checkout_url: "https://www.doordash.test/checkout/cart-1"
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "add_cart_items",
      arguments: {
        storeId: "store-1",
        menuId: "menu-1",
        items: [
          {
            itemId: "i_10523709271",
            itemName: "Enchiladas Verdes",
            quantity: 2,
            nestedOptions: [
              {
                option_id: "o_31172333376",
                name: "Oaxacan Refried Black"
              },
              {
                option_id: "o_42978512124"
              }
            ]
          }
        ]
      }
    }
  );

  assert.equal(response.body.result.isError, undefined);
  assert.equal(
    response.body.result.structuredContent.checkout_url,
    "https://www.doordash.test/checkout/cart-1"
  );
  assert.match(
    response.body.result.content[0].text,
    /Checkout: https:\/\/www\.doordash\.test\/checkout\/cart-1/
  );
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2)),
    [
      ["restaurant-item-details", "--store-id"],
      ["cart", "list"],
      ["cart", "add-items"],
      ["order", "checkout-url"]
    ]
  );
  const addCall = calls.find(
    (args) => args[0] === "cart" && args[1] === "add-items"
  );
  const requestedItems = JSON.parse(
    addCall[addCall.indexOf("--items-json") + 1]
  );
  assert.deepEqual(
    requestedItems[0].nested_options.map((option) => option.id),
    ["o_31172333376", "o_42978512124"]
  );
  assert.equal(
    requestedItems[0].nested_options[1].name,
    "Rotisserie Chicken"
  );

  await mcpHandler.close();
  store.close();
});

test("add cart preflights variants and sends one complete DoorDash batch", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "restaurant-item-details") {
        return cliResult({
          item: {
            item_id: "i_12901175286",
            name: "Spicy TanTan",
            extras: [
              {
                extra_id: "e_utensils",
                title: "Utensils",
                min_num_options: 1,
                max_num_options: 1,
                options: [
                  {
                    option_id: "o_utensils_yes",
                    name: "Utensils : Yes"
                  },
                  {
                    option_id: "o_utensils_no",
                    name: "Utensils : No"
                  }
                ]
              },
              {
                extra_id: "e_toppings",
                title: "Topping",
                min_num_options: 0,
                max_num_options: 0,
                options: [
                  {
                    option_id: "o_sweet_corn",
                    name: "Sweet Corn"
                  }
                ]
              }
            ]
          }
        });
      }
      if (args[0] === "cart" && args[1] === "list") {
        return cliResult({ carts: [] });
      }
      if (args[0] === "cart" && args[1] === "add-items") {
        return cliResult({
          cart_uuid: "cart-ramen",
          cart: {
            id: "cart-ramen",
            items: [
              {
                id: "line-1",
                item_id: "12901175286",
                name: "Spicy TanTan",
                quantity: 1
              },
              {
                id: "line-2",
                item_id: "12901175286",
                name: "Spicy TanTan",
                quantity: 1
              }
            ]
          }
        });
      }
      if (args[0] === "order" && args[1] === "checkout-url") {
        return cliResult({
          cart_uuid: "cart-ramen",
          checkout_url: "https://www.doordash.test/checkout/cart-ramen"
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "add_cart_items",
      arguments: {
        store_id: "707534",
        menu_id: "34596353",
        items: [
          {
            item_id: "i_12901175286",
            name: "Spicy TanTan",
            requested_options: ["Utensils"]
          },
          {
            item_id: "i_12901175286",
            name: "Spicy TanTan",
            requested_options: ["Utensils", "Sweet Corn"]
          }
        ]
      }
    }
  );

  assert.equal(
    response.body.result.isError,
    undefined,
    JSON.stringify(response.body.result)
  );
  assert.equal(
    calls.filter(
      (args) => args[0] === "restaurant-item-details"
    ).length,
    1
  );
  assert.equal(
    calls.filter(
      (args) => args[0] === "cart" && args[1] === "add-items"
    ).length,
    1
  );
  const addCall = calls.find(
    (args) => args[0] === "cart" && args[1] === "add-items"
  );
  const items = JSON.parse(
    addCall[addCall.indexOf("--items-json") + 1]
  );
  assert.deepEqual(
    items.map((item) => item.item_name),
    ["Spicy TanTan", "Spicy TanTan"]
  );
  assert.deepEqual(
    items.map((item) =>
      item.nested_options.map((option) => option.id)
    ),
    [
      ["o_utensils_yes"],
      ["o_utensils_yes", "o_sweet_corn"]
    ]
  );
  assert.equal(
    response.body.result.structuredContent.checkout_url,
    "https://www.doordash.test/checkout/cart-ramen"
  );

  await mcpHandler.close();
  store.close();
});

test("partial cart errors preserve every candidate variant when DoorDash omits variant details", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "restaurant-item-details") {
        return cliResult({
          item: {
            item_id: "i_12901175286",
            name: "Spicy TanTan",
            extras: [
              {
                extra_id: "e_utensils",
                title: "Utensils",
                min_num_options: 1,
                max_num_options: 1,
                options: [
                  {
                    option_id: "o_utensils_yes",
                    name: "Utensils : Yes"
                  },
                  {
                    option_id: "o_utensils_no",
                    name: "Utensils : No"
                  }
                ]
              },
              {
                extra_id: "e_toppings",
                title: "Topping",
                min_num_options: 0,
                max_num_options: 1,
                options: [
                  {
                    option_id: "o_sweet_corn",
                    name: "Sweet Corn"
                  }
                ]
              }
            ]
          }
        });
      }
      if (args[0] === "cart" && args[1] === "list") {
        return cliResult({ carts: [] });
      }
      if (args[0] === "cart" && args[1] === "add-items") {
        return cliResult({
          success: false,
          cart_uuid: "cart-ambiguous",
          cart: {
            id: "cart-ambiguous",
            items: [
              {
                id: "line-1",
                item_id: "i_12901175286",
                name: "Spicy TanTan",
                quantity: 1
              }
            ]
          },
          item_errors: [
            {
              request: {
                item_id: "i_12901175286",
                item_name: "Spicy TanTan",
                quantity: 1
              },
              error_message: "DoorDash could not add this line."
            }
          ]
        });
      }
      if (args[0] === "order" && args[1] === "checkout-url") {
        return cliResult({
          cart_uuid: "cart-ambiguous",
          checkout_url:
            "https://www.doordash.test/checkout/cart-ambiguous"
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "add_cart_items",
      arguments: {
        store_id: "707534",
        menu_id: "34596353",
        items: [
          {
            item_id: "i_12901175286",
            name: "Spicy TanTan",
            requested_options: ["Utensils"]
          },
          {
            item_id: "i_12901175286",
            name: "Spicy TanTan",
            requested_options: ["Utensils", "Sweet Corn"]
          }
        ]
      }
    }
  );

  const [itemError] = response.body.result.structuredContent.item_errors;
  assert.equal(itemError.ambiguous, true);
  assert.deepEqual(
    itemError.candidates.map((candidate) => candidate.request_index),
    [0, 1]
  );
  assert.deepEqual(
    itemError.candidates.map((candidate) =>
      candidate.item.selected_options.map((option) => option.option_id)
    ),
    [
      ["o_utensils_yes"],
      ["o_utensils_yes", "o_sweet_corn"]
    ]
  );
  assert.match(
    response.body.result.content[0].text,
    /Never resend the full batch/
  );
  assert.match(response.body.result.content[0].text, /request line 1/);
  assert.match(response.body.result.content[0].text, /request line 2/);

  await mcpHandler.close();
  store.close();
});

test("add cart reports every modifier before writing when a choice is missing", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "restaurant-item-details") {
        return cliResult({
          item: {
            item_id: "i_12901175286",
            name: "Spicy TanTan",
            extras: [
              {
                extra_id: "e_utensils",
                title: "Utensils",
                min_num_options: 1,
                max_num_options: 1,
                options: [
                  {
                    option_id: "o_yes",
                    name: "Utensils : Yes"
                  },
                  {
                    option_id: "o_no",
                    name: "Utensils : No"
                  }
                ]
              },
              {
                extra_id: "e_toppings",
                title: "Topping",
                min_num_options: 0,
                max_num_options: 0,
                options: [
                  {
                    option_id: "o_corn",
                    name: "Sweet Corn"
                  }
                ]
              }
            ]
          }
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "add_cart_items",
      arguments: {
        storeId: "707534",
        menuId: "34596353",
        items: [
          {
            itemId: "i_12901175286",
            itemName: "Spicy TanTan",
            requestedOptions: ["Imaginary Sauce"]
          }
        ]
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["restaurant-item-details"]
  );
  assert.equal(
    response.body.result.structuredContent.item_errors[0]
      .modifier_groups.length,
    2
  );
  assert.doesNotMatch(
    response.body.result.structuredContent.item_errors[0].message,
    /No cart changes were made/
  );
  assert.match(
    response.body.result.structuredContent.item_errors[0].message,
    /Imaginary Sauce.*does not exactly match/
  );
  assert.match(
    response.body.result.content[0].text,
    /No cart changes were made/
  );
  assert.match(
    response.body.result.content[0].text,
    /retrying add_cart_items once; never repeat unchanged input/
  );
  assert.match(
    response.body.result.content[0].text,
    /Utensils \(required; choose exactly 1\): Utensils : Yes \[o_yes\], Utensils : No \[o_no\]/
  );
  assert.match(
    response.body.result.content[0].text,
    /Topping \(optional; omit for none\): Sweet Corn \[o_corn\]/
  );
  assert.deepEqual(
    JSON.parse(response.body.result.content[1].text),
    response.body.result.structuredContent
  );

  await mcpHandler.close();
  store.close();
});

test("negative Sweet Corn phrases are rejected instead of selecting corn", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "restaurant-item-details") {
        return cliResult({
          item: {
            item_id: "i_12901175286",
            name: "Spicy TanTan",
            extras: [
              {
                extra_id: "e_utensils",
                title: "Utensils",
                min_num_options: 1,
                max_num_options: 1,
                options: [
                  {
                    option_id: "o_utensils_yes",
                    name: "Utensils : Yes"
                  },
                  {
                    option_id: "o_utensils_no",
                    name: "Utensils : No"
                  }
                ]
              },
              {
                extra_id: "e_toppings",
                title: "Topping",
                min_num_options: 0,
                max_num_options: 1,
                options: [
                  {
                    option_id: "o_sweet_corn",
                    name: "Sweet Corn"
                  }
                ]
              }
            ]
          }
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  const auth = authInfo(store, token.token);

  for (const [index, negativeChoice] of [
    "No Sweet Corn",
    "without Sweet Corn"
  ].entries()) {
    const response = await mcpRequest(
      mcpHandler,
      auth,
      "tools/call",
      {
        name: "add_cart_items",
        arguments: {
          store_id: "707534",
          menu_id: "34596353",
          items: [
            {
              item_id: "i_12901175286",
              name: "Spicy TanTan",
              requested_options: ["Utensils", negativeChoice]
            }
          ]
        }
      },
      index + 1
    );

    assert.equal(response.body.result.isError, true);
    assert.match(
      response.body.result.structuredContent.item_errors[0].message,
      new RegExp(
        `${negativeChoice}.*does not exactly match a current option`
      )
    );
  }

  const customNames = await mcpRequest(
    mcpHandler,
    auth,
    "tools/call",
    {
      name: "add_cart_items",
      arguments: {
        store_id: "707534",
        menu_id: "34596353",
        items: [
          {
            item_id: "i_12901175286",
            name: "Spicy TanTan (with Sweet Corn)",
            requested_options: ["Utensils", "Sweet Corn"]
          },
          {
            item_id: "i_12901175286",
            name: "Spicy TanTan (without Sweet Corn)",
            requested_options: ["Utensils"]
          }
        ]
      }
    },
    3
  );
  assert.equal(customNames.body.result.isError, true);
  assert.equal(
    customNames.body.result.structuredContent.item_errors.length,
    2
  );
  assert.equal(
    customNames.body.result.structuredContent.item_errors.filter(
      (itemError) => itemError.modifier_groups?.length
    ).length,
    1
  );
  for (const itemError of customNames.body.result.structuredContent
    .item_errors) {
    assert.match(itemError.message, /name must exactly match "Spicy TanTan"/);
  }

  assert.deepEqual(
    calls.map((args) => args[0]),
    [
      "restaurant-item-details",
      "restaurant-item-details",
      "restaurant-item-details"
    ]
  );
  assert.equal(
    calls.some(
      (args) => args[0] === "cart" && args[1] === "add-items"
    ),
    false
  );

  await mcpHandler.close();
  store.close();
});

test("unavailable modifier names are not offered as selectable hints", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "restaurant-item-details") {
        return cliResult({
          item: {
            item_id: "i_ramen",
            name: "Spicy TanTan",
            extras: [
              {
                extra_id: "e_toppings",
                title: "Topping",
                min_num_options: 0,
                max_num_options: 1,
                options: [
                  {
                    option_id: "o_sweet_corn",
                    name: "Sweet Corn",
                    available: false
                  }
                ]
              }
            ]
          }
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "add_cart_items",
      arguments: {
        store_id: "store-1",
        menu_id: "menu-1",
        items: [
          {
            item_id: "i_ramen",
            name: "Spicy TanTan",
            requested_options: ["Sweet Corn"]
          }
        ]
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.match(
    response.body.result.structuredContent.item_errors[0].message,
    /Sweet Corn.*does not exactly match a current option/
  );
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["restaurant-item-details"]
  );

  await mcpHandler.close();
  store.close();
});

test("unavailable items fail before any cart write", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "restaurant-item-details") {
        return cliResult({
          item: {
            item_id: "i_sold_out",
            name: "Sold Out Ramen",
            available: false
          }
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "add_cart_items",
      arguments: {
        store_id: "store-1",
        menu_id: "menu-1",
        items: [
          {
            item_id: "i_sold_out",
            name: "Sold Out Ramen"
          }
        ]
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.match(
    response.body.result.content[0].text,
    /cannot be added safely.*do not retry unchanged/i
  );
  assert.match(
    response.body.result.structuredContent.item_errors[0].message,
    /currently unavailable.*Do not retry this item/
  );
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["restaurant-item-details"]
  );

  await mcpHandler.close();
  store.close();
});

test("incomplete modifier IDs fail before automatic selection or cart write", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "restaurant-item-details") {
        return cliResult({
          item: {
            item_id: "i_combo",
            name: "Combo",
            extras: [
              {
                extra_id: "size",
                title: "Size",
                min_num_options: 1,
                options: [
                  { name: "Mystery Size" },
                  { option_id: "large", name: "Large" }
                ]
              }
            ]
          }
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "add_cart_items",
      arguments: {
        store_id: "store-1",
        menu_id: "menu-1",
        items: [{ item_id: "i_combo", name: "Combo" }]
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.equal(
    response.body.result.structuredContent.error.code,
    "UPSTREAM_SCHEMA_ERROR"
  );
  assert.match(
    response.body.result.content[0].text,
    /omitted an option_id.*Do not retry the unchanged call/
  );
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["restaurant-item-details"]
  );

  await mcpHandler.close();
  store.close();
});

test("large preflight batches stay complete, bounded, and small", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  let activeDetails = 0;
  let maxActiveDetails = 0;
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      if (args[0] !== "restaurant-item-details") {
        throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
      }
      activeDetails += 1;
      maxActiveDetails = Math.max(maxActiveDetails, activeDetails);
      await new Promise((resolve) => setImmediate(resolve));
      activeDetails -= 1;
      const itemId = args[args.indexOf("--item-id") + 1];
      const itemNumber = Number(itemId.match(/(\d+)$/)?.[1]);
      return cliResult({
        item: {
          item_id: `i_${itemId}`,
          name: `Item ${itemNumber}`,
          extras: [
            {
              extra_id: `choice-${itemNumber}`,
              title: "Choice",
              min_num_options: 1,
              max_num_options: 1,
              options: Array.from({ length: 100 }, (_, index) => ({
                option_id: `option-${itemNumber}-${index + 1}`,
                name: `Option ${index + 1}`
              }))
            }
          ]
        }
      });
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "add_cart_items",
      arguments: {
        store_id: "store-1",
        menu_id: "menu-1",
        items: Array.from({ length: 20 }, (_, index) => ({
          item_id: `i_item_${index + 1}`,
          name: `Item ${index + 1}`
        }))
      }
    }
  );

  const result = response.body.result;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.item_errors.length, 20);
  assert.equal(
    result.structuredContent.item_errors.filter(
      (error) => error.modifier_groups?.length
    ).length,
    2
  );
  assert.match(
    result.structuredContent.warnings.join(" "),
    /18 modifier choice sets were omitted/
  );
  assert.ok(maxActiveDetails <= 4);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") < 150_000);

  await mcpHandler.close();
  store.close();
});

test("requested_options are rejected for non-restaurant items", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  let cliCalls = 0;
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async () => {
      cliCalls += 1;
      return cliResult({});
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "add_cart_items",
      arguments: {
        store_id: "retail-store",
        menu_id: "retail-menu",
        items: [
          {
            item_id: "retail-item",
            name: "Sparkling Water",
            requested_options: ["Lime"]
          }
        ]
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.match(
    response.body.result.structuredContent.item_errors[0].message,
    /requested_options is supported only for i_-prefixed restaurant items/
  );
  assert.equal(cliCalls, 0);

  await mcpHandler.close();
  store.close();
});

test("retail nested option IDs are verified before cart add-items", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "item-details") {
        return cliResult({
          item: {
            item_id: "retail-item",
            name: "Sparkling Water",
            extras: [
              {
                extra_id: "flavor",
                title: "Flavor",
                min_num_options: 0,
                max_num_options: 1,
                options: [
                  {
                    option_id: "o_lime",
                    name: "Lime"
                  }
                ]
              }
            ]
          }
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "add_cart_items",
      arguments: {
        store_id: "retail-store",
        menu_id: "retail-menu",
        items: [
          {
            item_id: "retail-item",
            name: "Sparkling Water",
            nested_options: [
              {
                option_id: "o_invented",
                name: "Invented Flavor"
              }
            ]
          }
        ]
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.match(
    response.body.result.structuredContent.item_errors[0].message,
    /Selected option o_invented is not available/
  );
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2)),
    [["item-details", "--store-id"]]
  );
  assert.equal(
    calls.some(
      (args) => args[0] === "cart" && args[1] === "add-items"
    ),
    false
  );

  await mcpHandler.close();
  store.close();
});

test("nested requested options require the complete parent selection path", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "restaurant-item-details") {
        return cliResult({
          item: {
            item_id: "i_noodles",
            name: "Noodles",
            extras: [
              {
                extra_id: "e_preparation",
                title: "Preparation",
                min_num_options: 0,
                max_num_options: 1,
                options: [
                  {
                    option_id: "o_spicy_broth",
                    name: "Spicy Broth",
                    extras: [
                      {
                        extra_id: "e_heat",
                        title: "Heat",
                        min_num_options: 0,
                        max_num_options: 1,
                        options: [
                          {
                            option_id: "o_extra_hot",
                            name: "Extra Hot"
                          }
                        ]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "add_cart_items",
      arguments: {
        store_id: "store-1",
        menu_id: "menu-1",
        items: [
          {
            item_id: "i_noodles",
            name: "Noodles",
            requested_options: ["Extra Hot"]
          }
        ]
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.match(
    response.body.result.structuredContent.item_errors[0].message,
    /Extra Hot.*nested under an unselected parent option/
  );
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["restaurant-item-details"]
  );

  await mcpHandler.close();
  store.close();
});

test("add cart preserves successful items when checkout link creation fails", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      if (args[0] === "cart" && args[1] === "add-items") {
        return cliResult({
          success: true,
          cart_uuid: "cart-1",
          cart: {
            id: "cart-1",
            items: [
              {
                id: "line-1",
                item_id: "item-1",
                name: "Item",
                quantity: 1
              }
            ]
          }
        });
      }
      throw new Error("Checkout link unavailable.");
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "add_cart_items",
      arguments: {
        storeId: "store-1",
        menuId: "menu-1",
        cartUuid: "cart-1",
        items: [
          {
            itemId: "item-1",
            itemName: "Item"
          }
        ]
      }
    }
  );

  assert.equal(response.body.result.isError, undefined);
  assert.equal(response.body.result.structuredContent.items.length, 1);
  assert.equal(
    response.body.result.structuredContent.checkout_url,
    undefined
  );
  assert.match(
    response.body.result.structuredContent.warnings[0],
    /create_checkout_link/
  );

  await mcpHandler.close();
  store.close();
});

test("unknown cart-write outcomes require inspection and never resend", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "cart" && args[1] === "list") {
        return cliResult({ carts: [] });
      }
      if (args[0] === "cart" && args[1] === "add-items") {
        throw new Error("Socket closed after write.");
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "add_cart_items",
      arguments: {
        store_id: "store-1",
        menu_id: "menu-1",
        items: [
          {
            item_id: "retail-item-1",
            name: "Sparkling Water"
          }
        ]
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.equal(
    response.body.result.structuredContent.error.code,
    "CART_WRITE_OUTCOME_UNKNOWN"
  );
  assert.equal(
    response.body.result.structuredContent.error.retryable,
    false
  );
  assert.equal(
    response.body.result.structuredContent.error.recovery_tool,
    "list_carts"
  );
  assert.deepEqual(
    response.body.result.structuredContent.error.recovery_arguments,
    { store_id: "store-1" }
  );
  assert.match(response.body.result.content[0].text, /Never resend this batch/);
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2)),
    [
      ["cart", "list"],
      ["cart", "add-items"]
    ]
  );

  await mcpHandler.close();
  store.close();
});

test("add cart refuses to duplicate an active same-store cart", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "cart" && args[1] === "list") {
        return cliResult({
          carts: [
            {
              cart_uuid: "cart-existing",
              store_id: "store-1",
              store_name: "Mercado",
              items: [
                {
                  id: "line-1",
                  item_id: "item-1",
                  name: "Enchiladas Verdes",
                  quantity: 2
                }
              ]
            }
          ]
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "add_cart_items",
      arguments: {
        storeId: "store-1",
        menuId: "menu-1",
        items: [
          {
            itemId: "item-1",
            itemName: "Enchiladas Verdes",
            quantity: 2
          }
        ]
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.equal(
    response.body.result.structuredContent.error.code,
    "ACTIVE_CART_EXISTS"
  );
  assert.equal(
    response.body.result.structuredContent.error.recovery_tool,
    "show_cart"
  );
  assert.match(
    response.body.result.structuredContent.error.message,
    /cart-existing/
  );
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2)),
    [["cart", "list"]]
  );

  await mcpHandler.close();
  store.close();
});

test("add cart safely reuses an empty active same-store cart", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "cart" && args[1] === "list") {
        return cliResult({
          carts: [
            {
              cart_uuid: "cart-empty",
              store_id: "store-1",
              items: []
            }
          ]
        });
      }
      if (args[0] === "cart" && args[1] === "add-items") {
        return cliResult({
          cart_uuid: "cart-empty",
          cart: {
            id: "cart-empty",
            items: [
              {
                id: "line-1",
                item_id: "item-1",
                name: "Item",
                quantity: 1
              }
            ]
          }
        });
      }
      if (args[0] === "order" && args[1] === "checkout-url") {
        return cliResult({
          cart_uuid: "cart-empty",
          checkout_url: "https://www.doordash.test/checkout/cart-empty"
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "add_cart_items",
      arguments: {
        storeId: "store-1",
        menuId: "menu-1",
        items: [
          {
            itemId: "item-1",
            itemName: "Item"
          }
        ]
      }
    }
  );

  assert.equal(response.body.result.isError, undefined);
  const addCall = calls.find(
    (args) => args[0] === "cart" && args[1] === "add-items"
  );
  assert.equal(
    addCall[addCall.indexOf("--cart-uuid") + 1],
    "cart-empty"
  );

  await mcpHandler.close();
  store.close();
});

test("concurrent add_cart_items calls cannot duplicate one cart write", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  let releaseFirstList;
  const firstListGate = new Promise((resolve) => {
    releaseFirstList = resolve;
  });
  let markFirstListStarted;
  const firstListStarted = new Promise((resolve) => {
    markFirstListStarted = resolve;
  });
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "cart" && args[1] === "list") {
        markFirstListStarted();
        await firstListGate;
        return cliResult({ carts: [] });
      }
      if (args[0] === "cart" && args[1] === "add-items") {
        return cliResult({
          cart_uuid: "cart-concurrent",
          cart: {
            id: "cart-concurrent",
            items: [
              {
                id: "line-1",
                item_id: "item-1",
                name: "Item",
                quantity: 1
              }
            ]
          }
        });
      }
      if (args[0] === "order" && args[1] === "checkout-url") {
        return cliResult({
          cart_uuid: "cart-concurrent",
          checkout_url:
            "https://www.doordash.test/checkout/cart-concurrent"
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  const auth = authInfo(store, token.token);
  const request = {
    name: "add_cart_items",
    arguments: {
      store_id: "store-1",
      menu_id: "menu-1",
      items: [
        {
          item_id: "item-1",
          name: "Item"
        }
      ]
    }
  };

  const firstCall = mcpRequest(
    mcpHandler,
    auth,
    "tools/call",
    request,
    1
  );
  await firstListStarted;
  const duplicate = await mcpRequest(
    mcpHandler,
    auth,
    "tools/call",
    request,
    2
  );
  releaseFirstList();
  const first = await firstCall;

  assert.equal(first.body.result.isError, undefined);
  assert.equal(duplicate.body.result.isError, true);
  assert.equal(
    duplicate.body.result.structuredContent.error.code,
    "CART_WRITE_IN_PROGRESS"
  );
  assert.match(
    duplicate.body.result.structuredContent.error.message,
    /Do not repeat this add/
  );
  assert.equal(
    calls.filter(
      (args) => args[0] === "cart" && args[1] === "list"
    ).length,
    1
  );
  assert.equal(
    calls.filter(
      (args) => args[0] === "cart" && args[1] === "add-items"
    ).length,
    1
  );

  await mcpHandler.close();
  store.close();
});

test("add cart rejects modifier-group IDs as selected options", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  let cliCalls = 0;
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async () => {
      cliCalls += 1;
      return cliResult({});
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "add_cart_items",
      arguments: {
        storeId: "store-1",
        menuId: "menu-1",
        items: [
          {
            itemId: "item-1",
            itemName: "Item",
            nestedOptions: [
              {
                option_id: "e_7116953698",
                name: "CHOICE of BEANS"
              }
            ]
          }
        ]
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.match(
    response.body.result.content[0].text,
    /must identify a selectable option, not a modifier group/
  );
  assert.equal(cliCalls, 0);

  await mcpHandler.close();
  store.close();
});

test("discovery tools resolve omitted coordinates from the default address", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "address" && args[1] === "list") {
        return cliResult({
          addresses: [
            {
              id: "address-old",
              printable_address: "1 Old St",
              latitude: 37.7,
              longitude: -122.1,
              is_default: false
            },
            {
              id: "address-default",
              printable_address: "21 Bay Forest Dr",
              latitude: 37.831,
              longitude: -122.219,
              is_default: true
            }
          ]
        });
      }
      if (
        (args[0] === "search" && args[1] === "--query") ||
        args[0] === "find-nearby-stores"
      ) {
        return cliResult({ stores: [] });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });

  const restaurantResponse = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "search_restaurants",
      arguments: {
        query: "pizza",
        limit: 10
      }
    }
  );
  const storeResponse = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "find_nearby_stores",
      arguments: {
        vertical: "grocery",
        max: 25
      }
    },
    2
  );

  assert.equal(restaurantResponse.body.result.isError, undefined);
  assert.equal(storeResponse.body.result.isError, undefined);
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2)),
    [
      ["address", "list"],
      ["search", "--query"],
      ["address", "list"],
      ["find-nearby-stores", "--vertical"]
    ]
  );
  for (const args of [calls[1], calls[3]]) {
    assert.deepEqual(args.slice(args.indexOf("--lat"), args.indexOf("--lat") + 2), [
      "--lat",
      "37.831"
    ]);
    assert.deepEqual(args.slice(args.indexOf("--lng"), args.indexOf("--lng") + 2), [
      "--lng",
      "-122.219"
    ]);
  }

  await mcpHandler.close();
  store.close();
});

test("activity keeps default-address commands and CLI results completely raw", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const { mcpHandler, activityLog } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      if (args[0] === "address" && args[1] === "list") {
        return cliResult({
          addresses: [
            {
              id: "address-default",
              printable_address: "21 Bay Forest Dr",
              latitude: 37.831,
              longitude: -122.219,
              is_default: true,
              upstream_private: "keep this too"
            }
          ]
        });
      }
      return cliResult({
        stores: [],
        requested_latitude: 37.831,
        requested_longitude: -122.219,
        upstream_private: "do not redact or normalize me"
      });
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "search_restaurants",
      arguments: {
        query: "pizza"
      }
    }
  );

  assert.equal(response.body.result.isError, undefined);
  const [searchEntry, addressEntry] = activityLog.list(2);
  assert.equal(
    searchEntry.command[searchEntry.command.indexOf("--lat") + 1],
    "37.831"
  );
  assert.equal(
    searchEntry.command[searchEntry.command.indexOf("--lng") + 1],
    "-122.219"
  );
  assert.equal(
    searchEntry.result.upstream_private,
    "do not redact or normalize me"
  );
  assert.equal(searchEntry.result.requested_latitude, 37.831);
  assert.equal(
    addressEntry.result.addresses[0].printable_address,
    "21 Bay Forest Dr"
  );
  assert.equal(
    addressEntry.result.addresses[0].upstream_private,
    "keep this too"
  );

  await mcpHandler.close();
  store.close();
});

test("discovery rejects location overrides before the CLI", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "address" && args[1] === "list") {
        return cliResult({
          addresses: [
            {
              id: "address-default",
              printable_address: "21 Bay Forest Dr",
              latitude: 37.831,
              longitude: -122.219,
              is_default: true
            }
          ]
        });
      }
      return cliResult({ stores: [] });
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "search_restaurants",
      arguments: {
        query: "pizza",
        lat: 37.8,
        lng: -122.2,
        limit: 10
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.match(response.body.result.content[0].text, /lat/);
  assert.match(response.body.result.content[0].text, /lng/);
  assert.deepEqual(calls, []);

  await mcpHandler.close();
  store.close();
});

test("discovery fails clearly without a usable default address", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      return cliResult({
        addresses: [
          {
            id: "address-1",
            printable_address: "1 Main St",
            latitude: 37.8,
            longitude: -122.2
          }
        ]
      });
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "search_restaurants",
      arguments: {
        query: "pizza"
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.match(
    response.body.result.structuredContent.error.message,
    /did not identify a default saved address/
  );
  assert.deepEqual(calls, [["address", "list"]]);

  await mcpHandler.close();
  store.close();
});

test("raw runner and activity tools are not exposed", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Purchase",
    allowPurchases: true
  });
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async () => {
      throw new Error("CLI should not run during tools/list.");
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/list",
    {}
  );
  const toolNames = response.body.result.tools.map((tool) => tool.name);
  assert.equal(toolNames.includes("run"), false);
  assert.equal(toolNames.includes("activity"), false);
  assert.equal(
    toolNames.includes("get_restaurant_item_details"),
    false
  );

  await mcpHandler.close();
  store.close();
});

test("permission is rechecked immediately before a dangerous CLI call", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Purchase",
    allowPurchases: true
  });
  const staleAuth = authInfo(store, token.token);
  let cliCalls = 0;
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async () => {
      cliCalls += 1;
      return cliResult({});
    }
  });

  store.setPurchaseAccess(token.id, false);
  const response = await mcpRequest(
    mcpHandler,
    staleAuth,
    "tools/call",
    {
      name: "list_payment_methods",
      arguments: {}
    }
  );
  assert.equal(response.body.result.isError, true);
  assert.match(
    response.body.result.structuredContent.error.message,
    /does not allow checkout or card details/
  );
  assert.equal(cliCalls, 0);

  await mcpHandler.close();
  store.close();
});

test("typed tools return concise text and normalized structured content", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      if (args[0] === "address" && args[1] === "list") {
        return cliResult({
          addresses: [
            {
              id: "address-default",
              printable_address: "21 Bay Forest Dr",
              latitude: 37.831,
              longitude: -122.219,
              is_default: true
            }
          ]
        });
      }
      return cliResult({
        success: true,
        upstream_only: "discard me",
        stores: [
          {
            store_id: 928163,
            name: "Example Pizza",
            image_url: "https://images.example.test/store.jpg",
            delivery_time: "25-35 min"
          }
        ]
      });
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "search_restaurants",
      arguments: {
        query: "pizza",
        limit: 10
      }
    }
  );

  assert.equal(
    response.body.result.content[0].text,
    "Found 1 DoorDash store."
  );
  assert.equal(response.body.result.content.length, 2);
  assert.equal(response.body.result.structuredContent.kind, "store_search");
  assert.equal(
    response.body.result.structuredContent.stores[0].store_id,
    "928163"
  );
  assert.equal(
    response.body.result.structuredContent.stores[0].delivery_time,
    "25-35 min"
  );
  assert.deepEqual(
    JSON.parse(response.body.result.content[1].text),
    response.body.result.structuredContent
  );
  assert.equal(
    JSON.stringify(response.body.result.structuredContent).includes(
      "upstream_only"
    ),
    false
  );
  assert.equal(
    JSON.stringify(response.body.result.structuredContent).includes(
      "min_minutes"
    ),
    false
  );

  await mcpHandler.close();
  store.close();
});

test("malformed upstream data is a typed MCP error, not an empty result", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      if (args[0] === "address" && args[1] === "list") {
        return cliResult({
          addresses: [
            {
              id: "address-default",
              printable_address: "21 Bay Forest Dr",
              latitude: 37.831,
              longitude: -122.219,
              is_default: true
            }
          ]
        });
      }
      return cliResult({ success: true });
    }
  });

  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "search_restaurants",
      arguments: {
        query: "pizza",
        limit: 10
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.equal(
    response.body.result.structuredContent.error.code,
    "UPSTREAM_SCHEMA_ERROR"
  );
  assert.equal(response.body.result.content.length, 2);
  assert.deepEqual(
    JSON.parse(response.body.result.content[1].text),
    response.body.result.structuredContent
  );
  assert.equal("data" in response.body.result.structuredContent, false);

  await mcpHandler.close();
  store.close();
});

test("preview submit_context hands canonical dollars and flags to order_submit", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Purchase",
    allowPurchases: true
  });
  const calls = [];
  const scheduledTime = "2026-08-01T19:00:00-07:00";
  const deliveryAddress =
    "21 Bay Forest Dr, Oakland, CA 94611, USA";
  const previewResult = {
    success: true,
    cart_uuid: "cart-handoff",
    quote: {
      id: "cart-handoff",
      total_before_tip: {
        unit_amount: 2501,
        display_string: "$25.01"
      },
      delivery_address: {
        printable_address: deliveryAddress
      },
      tips_suggestion_details: [
        {
          default_index: 0,
          percentage_values: [20],
          percentage_to_amount_monetary_values: [
            {
              unit_amount: 500,
              display_string: "$5.00"
            }
          ],
          tip_recipient: "DASHER"
        }
      ],
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
                  name: "Pizza"
                },
                unit_price_monetary_fields: {
                  unit_amount: 2501
                }
              }
            ]
          }
        ]
      }
    }
  };
  const { mcpHandler } = createTestApp({
    securityStore: store,
    pollDelay: async () => {},
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "order" && args[1] === "preview") {
        return cliResult(previewResult);
      }
      if (args[0] === "payment-method") {
        return cliResult({
          default_payment_method_id: "pm-1",
          cards: [
            {
              payment_method_id: "pm-1",
              brand: "Visa",
              last4: "4242",
              exp_month: 12,
              exp_year: 2030
            }
          ]
        });
      }
      if (args[0] === "order" && args[1] === "submit") {
        return cliResult({
          success: true,
          order_uuid: "order-handoff"
        });
      }
      if (args[0] === "order" && args[1] === "status") {
        return cliResult({
          order: {
            status: "successful",
            order_uuid: "order-handoff"
          }
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  const auth = authInfo(store, token.token);

  const preview = await mcpRequest(
    mcpHandler,
    auth,
    "tools/call",
    {
      name: "preview_order",
      arguments: {
        cart_uuid: "cart-handoff",
        scheduled_time: scheduledTime,
        fulfillment: "delivery",
        priority: true,
        include_work_benefits: true,
        apply_credits: false
      }
    }
  );

  assert.equal(preview.body.result.isError, undefined);
  const submitContext =
    preview.body.result.structuredContent.submit_context;
  assert.match(
    submitContext.preview_token,
    /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/
  );
  const { preview_token: _previewToken, ...confirmedContext } =
    submitContext;
  assert.deepEqual(confirmedContext, {
    cart_uuid: "cart-handoff",
    expected_total_before_tip: 25.01,
    expected_delivery_address: deliveryAddress,
    scheduled_time: scheduledTime,
    fulfillment: "delivery",
    priority: true,
    apply_credits: false,
    pin_handoff_required: false
  });
  assert.equal(
    preview.body.result.structuredContent.tip_suggestions[0].amount,
    5
  );

  const submitted = await mcpRequest(
    mcpHandler,
    auth,
    "tools/call",
    {
      name: "order_submit",
      arguments: {
        cart_uuid: submitContext.cart_uuid,
        preview_token: submitContext.preview_token,
        expected_total_before_tip:
          submitContext.expected_total_before_tip,
        expected_delivery_address:
          submitContext.expected_delivery_address,
        tip:
          preview.body.result.structuredContent.tip_suggestions[0]
            .amount,
        tip_confirmed: true,
        payment_confirmation: {
          type: "card",
          brand: "Visa",
          last4: "4242"
        },
        confirmation: "PLACE ORDER",
        scheduled_time: submitContext.scheduled_time,
        fulfillment: submitContext.fulfillment,
        priority: submitContext.priority,
        apply_credits: submitContext.apply_credits,
        pin_handoff_required: submitContext.pin_handoff_required
      }
    },
    2
  );

  assert.equal(submitted.body.result.isError, undefined);
  assert.equal(
    submitted.body.result.structuredContent.order_uuid,
    "order-handoff"
  );
  const previewCalls = calls.filter(
    (args) => args[0] === "order" && args[1] === "preview"
  );
  assert.deepEqual(previewCalls[0], [
    "order",
    "preview",
    "--cart-uuid",
    "cart-handoff",
    "--scheduled-time",
    scheduledTime,
    "--fulfillment",
    "delivery",
    "--priority",
    "--include-work-benefits",
    "--no-apply-credits"
  ]);
  assert.deepEqual(previewCalls[1], [
    "order",
    "preview",
    "--cart-uuid",
    "cart-handoff",
    "--scheduled-time",
    scheduledTime,
    "--fulfillment",
    "delivery",
    "--priority",
    "--include-work-benefits",
    "--no-apply-credits"
  ]);
  const submitCall = calls.find(
    (args) => args[0] === "order" && args[1] === "submit"
  );
  assert.deepEqual(submitCall, [
    "order",
    "submit",
    "--cart-uuid",
    "cart-handoff",
    "--tip-cents",
    "500",
    "--yes",
    "--scheduled-time",
    scheduledTime,
    "--fulfillment",
    "delivery",
    "--priority",
    "--no-apply-credits"
  ]);

  await mcpHandler.close();
  store.close();
});

test("preview token blocks changed purchase flags and cart drift", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Purchase",
    allowPurchases: true
  });
  const scheduledTime = "2026-08-02T18:30:00-07:00";
  let previewCount = 0;
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "order" && args[1] === "preview") {
        previewCount += 1;
        return cliResult({
          success: true,
          cart_uuid: "cart-drift",
          quote: {
            total_before_tip: { unit_amount: 2000 },
            store_order_cart: {
              is_consumer_pickup: true,
              orders: [
                {
                  order_items: [
                    {
                      id: "line-1",
                      quantity: previewCount,
                      item: {
                        id: "item-1",
                        name: "Ramen"
                      },
                      unit_price_monetary_fields: {
                        unit_amount: 2000
                      }
                    }
                  ]
                }
              ]
            }
          }
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });
  const auth = authInfo(store, token.token);
  const preview = await mcpRequest(
    mcpHandler,
    auth,
    "tools/call",
    {
      name: "preview_order",
      arguments: {
        cart_uuid: "cart-drift",
        scheduled_time: scheduledTime,
        fulfillment: "pickup",
        priority: true,
        apply_credits: false
      }
    }
  );
  const context = preview.body.result.structuredContent.submit_context;
  const confirmedArguments = {
    ...context,
    tip: 0,
    tip_confirmed: true,
    payment_confirmation: {
      type: "account_default",
      acknowledgement: "USE ACCOUNT DEFAULT"
    },
    confirmation: "PLACE ORDER"
  };

  const drifted = await mcpRequest(
    mcpHandler,
    auth,
    "tools/call",
    {
      name: "order_submit",
      arguments: confirmedArguments
    },
    2
  );
  assert.equal(drifted.body.result.isError, true);
  assert.equal(
    drifted.body.result.structuredContent.error.code,
    "ORDER_PREVIEW_CHANGED"
  );
  assert.deepEqual(
    drifted.body.result.structuredContent.error.recovery_arguments,
    {
      cart_uuid: "cart-drift",
      scheduled_time: scheduledTime,
      fulfillment: "pickup",
      priority: true,
      include_work_benefits: true,
      apply_credits: false
    }
  );

  const changedFlags = await mcpRequest(
    mcpHandler,
    auth,
    "tools/call",
    {
      name: "order_submit",
      arguments: {
        ...confirmedArguments,
        priority: false
      }
    },
    3
  );
  assert.equal(changedFlags.body.result.isError, true);
  assert.equal(
    changedFlags.body.result.structuredContent.error.code,
    "PREVIEW_CONFIRMATION_INVALID"
  );
  assert.equal(
    changedFlags.body.result.structuredContent.error.recovery_tool,
    undefined
  );
  assert.match(
    changedFlags.body.result.structuredContent.error.message,
    /No automatic recovery is returned because the mismatched settings cannot be trusted/
  );
  assert.equal(
    calls.filter(
      (args) => args[0] === "order" && args[1] === "preview"
    ).length,
    2
  );

  await mcpHandler.close();
  store.close();
});

test("order_submit requires explicit acknowledgement for PIN handoff", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Purchase",
    allowPurchases: true
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "order" && args[1] === "preview") {
        return cliResult({
          success: true,
          cart_uuid: "cart-pin",
          quote: {
            total_before_tip: {
              unit_amount: 2000
            },
            delivery_address: {
              printable_address: "123 Main St, Oakland, CA 94611"
            },
            dropoff_options: [
              {
                proof_of_delivery_type: "PIN_CODE"
              }
            ],
            store_order_cart: {
              orders: []
            }
          }
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });

  const preview = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "preview_order",
      arguments: {
        cart_uuid: "cart-pin",
        fulfillment: "delivery",
        priority: false,
        apply_credits: true
      }
    }
  );
  const previewToken =
    preview.body.result.structuredContent.submit_context.preview_token;
  const response = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "order_submit",
      arguments: {
        cart_uuid: "cart-pin",
        preview_token: previewToken,
        expected_total_before_tip: 20,
        expected_delivery_address: "123 Main St, Oakland, CA 94611",
        tip: 4,
        tip_confirmed: true,
        payment_confirmation: {
          type: "account_default",
          acknowledgement: "USE ACCOUNT DEFAULT"
        },
        confirmation: "PLACE ORDER",
        fulfillment: "delivery",
        priority: false,
        apply_credits: true,
        pin_handoff_required: true
      }
    }
  );

  assert.equal(response.body.result.isError, true);
  assert.equal(
    response.body.result.structuredContent.error.code,
    "PIN_HANDOFF_CONFIRMATION_REQUIRED"
  );
  assert.match(
    response.body.result.content[0].text,
    /Ask the user to accept that requirement/
  );
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2)),
    [
      ["order", "preview"],
      ["order", "preview"]
    ]
  );

  await mcpHandler.close();
  store.close();
});

test("submit revalidates quote and card, records the attempt, and polls status", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const token = store.createToken({
    name: "Purchase",
    allowPurchases: true
  });
  const calls = [];
  const { mcpHandler } = createTestApp({
    securityStore: store,
    pollDelay: async () => {},
    runCli: async (args, options) => {
      calls.push({ args, options });
      if (args[0] === "order" && args[1] === "preview") {
        return cliResult({
          success: true,
          cart_uuid: "cart-1",
          quote: {
            total_before_tip: {
              unit_amount: 2500,
              display_string: "$25.00"
            },
            delivery_address: {
              printable_address: "21 Bay Forest Dr, Oakland, CA 94611, USA"
            },
            store_order_cart: {
              orders: [
                {
                  order_items: [
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
                  ]
                }
              ]
            }
          }
        });
      }
      if (args[0] === "payment-method") {
        return cliResult({
          default_payment_method_id: "pm-1",
          cards: [
            {
              payment_method_id: "pm-1",
              provider_payment_method_id: "provider-secret",
              brand: "Visa",
              last4: "4242",
              exp_month: 12,
              exp_year: 2030
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
          order: {
            status: "successful",
            order_uuid: "order-1"
          },
          tracking_url: "https://www.doordash.test/orders/order-1"
        });
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    }
  });

  const auth = authInfo(store, token.token);
  const preview = await mcpRequest(
    mcpHandler,
    auth,
    "tools/call",
    {
      name: "preview_order",
      arguments: {
        cart_uuid: "cart-1",
        fulfillment: "delivery",
        priority: false,
        apply_credits: true
      }
    }
  );
  const previewToken =
    preview.body.result.structuredContent.submit_context.preview_token;
  const response = await mcpRequest(
    mcpHandler,
    auth,
    "tools/call",
    {
      name: "order_submit",
      arguments: {
        cart_uuid: "cart-1",
        previewToken,
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
        fulfillment: "delivery",
        priority: false,
        applyCredits: true,
        pinHandoffRequired: false
      }
    }
  );

  assert.equal(
    response.body.result?.isError,
    undefined,
    JSON.stringify(response.body)
  );
  assert.equal(response.body.result.structuredContent.schema, "doordash-cli");
  assert.equal(response.body.result.structuredContent.version, 1);
  assert.equal(response.body.result.structuredContent.kind, "order_submit");
  assert.equal(
    response.body.result.structuredContent.order_uuid,
    "order-1"
  );
  assert.equal(
    response.body.result.structuredContent.items[0].item_id,
    "item-1"
  );
  assert.equal(
    response.body.result.structuredContent.pricing.total_before_tip,
    25
  );
  assert.equal(
    response.body.result.structuredContent.pricing.tip,
    5
  );
  assert.equal(
    response.body.result.structuredContent.pricing.total,
    30
  );
  assert.equal(
    response.body.result.structuredContent.tracking_url,
    "https://www.doordash.test/orders/order-1"
  );
  assert.equal(
    response.body.result.structuredContent.warnings,
    undefined
  );
  assert.deepEqual(
    JSON.parse(response.body.result.content[1].text),
    response.body.result.structuredContent
  );
  assert.deepEqual(
    calls.map((call) => call.args.slice(0, 2).join(" ")),
    [
      "order preview",
      "order preview",
      "payment-method list",
      "order submit",
      "order status"
    ]
  );
  assert.equal(
    calls.find(
      (call) => call.args[0] === "order" && call.args[1] === "submit"
    ).options.allowPurchases,
    true
  );

  const duplicate = await mcpRequest(
    mcpHandler,
    authInfo(store, token.token),
    "tools/call",
    {
      name: "order_submit",
      arguments: {
        cartUuid: "cart-1",
        previewToken,
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
        fulfillment: "delivery",
        priority: false,
        applyCredits: true,
        pinHandoffRequired: false
      }
    },
    2
  );
  assert.equal(duplicate.body.result.isError, true);
  assert.match(
    duplicate.body.result.structuredContent.error.message,
    /already has a recorded submission attempt/
  );
  assert.equal(
    calls.filter(
      (call) => call.args[0] === "order" && call.args[1] === "submit"
    ).length,
    1
  );

  await mcpHandler.close();
  store.close();
});
