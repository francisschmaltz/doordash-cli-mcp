import * as z from "zod/v4";

export const RESPONSE_SCHEMA = "doordash-cli";
export const RESPONSE_SCHEMA_VERSION = 1;

const optionalString = z.string().optional();
const optionalNumber = z.number().finite().optional();
const optionalBoolean = z.boolean().optional();

const jsonValueSchema = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

export const moneySchema = z.number().finite();

const locationSchema = z.object({
  address: optionalString,
  latitude: optionalNumber,
  longitude: optionalNumber
});

const truncationSchema = z.object({
  returned: z.number().int().nonnegative(),
  omitted: z.number().int().nonnegative().optional()
});

const selectedOptionSchema = z.lazy(() =>
  z.object({
    option_id: optionalString,
    group_name: optionalString,
    option_name: optionalString,
    quantity: optionalNumber,
    price: moneySchema.optional(),
    options: z.array(selectedOptionSchema).optional()
  })
);

const modifierOptionSchema = z.lazy(() =>
  z.object({
    option_id: z.string(),
    name: optionalString,
    price: moneySchema.optional(),
    available: optionalBoolean,
    quantity: optionalNumber,
    modifier_groups: z.array(modifierGroupSchema).optional()
  })
);

const modifierGroupSchema = z.lazy(() =>
  z.object({
    group_id: optionalString,
    name: optionalString,
    required: z.literal(true).optional(),
    min_selections: optionalNumber,
    max_selections: optionalNumber,
    options: z.array(modifierOptionSchema)
  })
);

export const itemSchema = z.lazy(() =>
  z.object({
    item_id: optionalString,
    cart_item_id: optionalString,
    name: optionalString,
    description: optionalString,
    image_url: optionalString,
    quantity: optionalNumber,
    price: moneySchema.optional(),
    original_price: moneySchema.optional(),
    available: optionalBoolean,
    has_modifiers: optionalBoolean,
    has_required_modifiers: optionalBoolean,
    purchase_type: optionalString,
    measurement_unit: optionalString,
    increment: optionalNumber,
    selected_options: z.array(selectedOptionSchema).optional(),
    substitutions: z.array(itemSchema).optional(),
    modifier_groups: z.array(modifierGroupSchema).optional()
  })
);

export const storeSchema = z.object({
  store_id: optionalString,
  name: optionalString,
  image_url: optionalString,
  vertical: optionalString,
  location: locationSchema.optional(),
  distance: optionalString,
  fulfillment: z.array(z.string()).optional(),
  delivery_time: optionalString
});

const pricingLineSchema = z.object({
  label: optionalString,
  amount: moneySchema.optional()
});

export const pricingSchema = z.object({
  subtotal: moneySchema.optional(),
  fees: z.array(pricingLineSchema).optional(),
  tax: moneySchema.optional(),
  discounts: z.array(pricingLineSchema).optional(),
  credits: moneySchema.optional(),
  tip: moneySchema.optional(),
  total_before_tip: moneySchema.optional(),
  total: moneySchema.optional()
});

const paymentSchema = z.object({
  type: optionalString,
  brand: optionalString,
  last4: optionalString,
  budget_name: optionalString
});

const cartFields = {
  cart_uuid: optionalString,
  store: storeSchema.optional(),
  items: z.array(itemSchema),
  added_line_count: optionalNumber,
  items_truncation: truncationSchema.optional(),
  fulfillment: z.enum(["delivery", "pickup"]).optional(),
  created_at: optionalString,
  updated_at: optionalString,
  checkout_url: optionalString,
  group_cart_url: optionalString
};

export const cartSchema = z.object(cartFields);

const orderFields = {
  order_uuid: optionalString,
  cart_uuid: optionalString,
  status: optionalString,
  store: storeSchema.optional(),
  items: z.array(itemSchema).optional(),
  items_truncation: truncationSchema.optional(),
  fulfillment: z.enum(["delivery", "pickup"]).optional(),
  delivery_address: locationSchema.optional(),
  delivery_time: optionalString,
  scheduled_time: optionalString,
  pricing: pricingSchema.optional(),
  payment: paymentSchema.optional(),
  checkout_url: optionalString,
  tracking_url: optionalString,
  group_cart_url: optionalString,
  reorderable: optionalBoolean,
  placed_at: optionalString
};

export const orderSchema = z.object(orderFields);

const contractErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  recovery_tool: z.string().optional(),
  recovery_arguments: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
});

function cardSchema(kind, fields) {
  return z.object({
    schema: z.literal(RESPONSE_SCHEMA),
    version: z.literal(RESPONSE_SCHEMA_VERSION),
    kind: z.literal(kind),
    ...fields,
    warnings: z.array(z.string()).optional()
  });
}

function errorCardSchema(kind) {
  return z.object({
    schema: z.literal(RESPONSE_SCHEMA),
    version: z.literal(RESPONSE_SCHEMA_VERSION),
    kind: z.literal(kind),
    error: contractErrorSchema
  });
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function findFirstObject(root, predicate) {
  const queue = [root];
  const visited = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || visited.has(value)) {
      continue;
    }
    visited.add(value);
    if (!Array.isArray(value) && predicate(value)) {
      return value;
    }
    queue.push(...(Array.isArray(value) ? value : Object.values(value)));
  }
  return undefined;
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function stringValue(...values) {
  for (const value of values) {
    if (
      value === undefined ||
      value === null ||
      (typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "bigint")
    ) {
      continue;
    }
    const result = String(value).trim();
    if (result) {
      return result;
    }
  }
  return undefined;
}

function idValue(...values) {
  return stringValue(...values);
}

function numberValue(...values) {
  for (const value of values) {
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      (typeof value !== "string" && typeof value !== "number")
    ) {
      continue;
    }
    const result = Number(value);
    if (Number.isFinite(result)) {
      return result;
    }
  }
  return undefined;
}

function booleanValue(...values) {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") {
        return true;
      }
      if (normalized === "false") {
        return false;
      }
    }
  }
  return undefined;
}

function compactRecord(entries) {
  return Object.fromEntries(
    entries.filter(([, value]) => value !== undefined && value !== null)
  );
}

function nonEmptyRecord(value) {
  return value && Object.keys(value).length ? value : undefined;
}

function nonEmptyObject(value) {
  const source = asObject(value);
  return source && Object.keys(source).length ? source : undefined;
}

function warningList(...values) {
  return values
    .flat()
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
}

function roundDollars(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function money(value, { cents = false } = {}) {
  if (value === null || value === undefined) {
    return undefined;
  }

  const source = asObject(value);
  const centsValue = numberValue(
    source?.unit_amount,
    source?.amount_cents,
    source?.amountCents
  );
  const directValue = numberValue(
    source?.amount,
    source?.value,
    typeof value === "number" ? value : undefined
  );
  const stringMatch =
    typeof value === "string"
      ? value.replaceAll(",", "").match(/-?\d+(?:\.\d+)?/)
      : undefined;
  const parsedString = stringMatch ? Number(stringMatch[0]) : undefined;

  if (centsValue !== undefined) {
    return roundDollars(centsValue / 100);
  }
  if (directValue !== undefined) {
    return roundDollars(cents ? directValue / 100 : directValue);
  }
  if (parsedString !== undefined) {
    return roundDollars(parsedString);
  }
  return undefined;
}

function moneyFromCents(value) {
  return money(value, { cents: true });
}

function isoTimestamp(value) {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeFulfillment(value) {
  const text = stringValue(value)?.toLowerCase();
  if (!text) {
    return undefined;
  }
  if (text.includes("pickup")) {
    return "pickup";
  }
  if (text.includes("delivery")) {
    return "delivery";
  }
  return undefined;
}

function normalizeLocation(value, { includeCoordinatesWithAddress = false } = {}) {
  if (typeof value === "string") {
    const address = stringValue(value);
    return address ? { address } : undefined;
  }
  const source = asObject(value) || {};
  const address = stringValue(
    source.printable_address,
    source.formatted_address,
    source.address,
    source.street_address
  );
  if (address && !includeCoordinatesWithAddress) {
    return { address };
  }
  return nonEmptyRecord(
    compactRecord([
      ["address", address],
      ["latitude", numberValue(source.latitude, source.lat)],
      ["longitude", numberValue(source.longitude, source.lng, source.lon)]
    ])
  );
}

function formatDecimal(value) {
  return String(Math.round(value * 100) / 100);
}

function distanceTextInMiles(value) {
  const text = stringValue(value);
  if (!text) {
    return undefined;
  }
  const match = text.replaceAll(",", "").match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[0]);
  if (/\b(?:mi|miles?)\b/i.test(text)) {
    return `${formatDecimal(amount)} mi`;
  }
  if (/\b(?:km|kilometers?)\b/i.test(text)) {
    return `${formatDecimal(amount * 0.621371)} mi`;
  }
  if (/\b(?:m|meters?)\b/i.test(text)) {
    return `${formatDecimal(amount / 1609.344)} mi`;
  }
  return undefined;
}

function displayDistance(value) {
  const source = asObject(value) || {};
  const miles = numberValue(source.distance_miles, source.miles);
  if (miles !== undefined) {
    return `${formatDecimal(miles)} mi`;
  }

  const display = stringValue(
    source.distance_display,
    source.display_distance,
    source.formatted_distance
  );
  const displayMiles = distanceTextInMiles(display);
  if (displayMiles && /\b(?:mi|miles?)\b/i.test(display)) {
    return displayMiles;
  }

  const direct = source.distance;
  const directMiles = distanceTextInMiles(direct);
  if (
    directMiles &&
    typeof direct === "string" &&
    /\b(?:mi|miles?)\b/i.test(direct)
  ) {
    return directMiles;
  }
  const directNumber = numberValue(direct);
  const directUnit = stringValue(source.distance_unit, source.distance_units);
  if (directNumber !== undefined && directUnit) {
    if (/mi|mile/i.test(directUnit)) {
      return `${formatDecimal(directNumber)} mi`;
    }
    if (/km|kilomet/i.test(directUnit)) {
      return `${formatDecimal(directNumber * 0.621371)} mi`;
    }
    if (/^m$|meter/i.test(directUnit)) {
      return `${formatDecimal(directNumber / 1609.344)} mi`;
    }
  }

  const meters = numberValue(source.distance_meters, source.meters);
  if (meters !== undefined) {
    return `${formatDecimal(meters / 1609.344)} mi`;
  }
  const kilometers = numberValue(source.distance_km, source.kilometers);
  if (kilometers !== undefined) {
    return `${formatDecimal(kilometers * 0.621371)} mi`;
  }
  return displayMiles || directMiles;
}

function deliveryTime(value) {
  const source = asObject(value) || {};
  const displays = [
    source.asap_minutes_range_string,
    source.delivery_time,
    source.delivery_time_display,
    source.eta,
    source.estimate,
    typeof value === "string" ? value : undefined
  ]
    .map((entry) => stringValue(entry))
    .filter(Boolean);
  const displayedRange = displays.find((entry) =>
    /\d+\s*[-–]\s*\d+/.test(entry)
  );
  if (displayedRange) {
    return displayedRange;
  }

  const rangeAliases = [
    source.asap_minutes_range,
    source.delivery_minutes_range,
    source.eta_minutes_range
  ];
  for (const range of rangeAliases.filter(Array.isArray)) {
    const minimum = numberValue(range[0]);
    const maximum = numberValue(range[1], range[0]);
    if (minimum !== undefined && maximum !== undefined) {
      return minimum === maximum
        ? `${minimum} min`
        : `${minimum}-${maximum} min`;
    }
  }
  const stringRange = rangeAliases
    .map((entry) => stringValue(entry))
    .find((entry) => entry && /\d+\s*[-–]\s*\d+/.test(entry));
  if (stringRange) {
    return stringRange;
  }
  if (
    rangeAliases.some(
      (entry) => entry !== undefined && entry !== null
    )
  ) {
    throw new UpstreamSchemaError(
      "DoorDash returned a malformed delivery-time range."
    );
  }

  const minimum = numberValue(source.min_minutes, source.minimum_minutes);
  const maximum = numberValue(source.max_minutes, source.maximum_minutes);
  if (minimum !== undefined || maximum !== undefined) {
    const start = minimum ?? maximum;
    const end = maximum ?? minimum;
    return start === end ? `${start} min` : `${start}-${end} min`;
  }
  return displays[0];
}

function responseLinks(value) {
  const source = asObject(value) || {};
  return compactRecord([
    [
      "checkout_url",
      stringValue(
        source.checkout_url,
        source.checkoutUrl,
        source.links?.checkout_url
      )
    ],
    [
      "tracking_url",
      stringValue(
        source.tracking_url,
        source.order_tracking_url,
        source.consumer_tracking_url,
        source.links?.tracking_url
      )
    ],
    [
      "group_cart_url",
      stringValue(
        source.group_cart_url,
        source.groupCartUrl,
        source.links?.group_cart_url
      )
    ]
  ]);
}

function normalizeSelectedOptions(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  assertObjectArray(value, "selected options");
  return value.map((entry) => {
    const source = asObject(entry);
    const nested = normalizeSelectedOptions(source.options);
    const explicitOptionName = stringValue(
      source.value,
      source.option_name,
      source.item_extra_option?.name
    );
    const groupName = stringValue(
      source.group_name,
      source.item_extra_option?.item_extra?.name,
      explicitOptionName ? source.name : undefined
    );
    return compactRecord([
      [
        "option_id",
        idValue(
          source.option_id,
          source.id,
          source.item_extra_option?.option_id,
          source.item_extra_option?.id
        )
      ],
      [
        "group_name",
        groupName
      ],
      [
        "option_name",
        explicitOptionName || stringValue(source.name)
      ],
      ["quantity", numberValue(source.quantity)],
      ["price", money(first(source.price, source.unit_price))],
      ["options", nested]
    ]);
  });
}

function looksLikeModifierGroups(value) {
  return (
    Array.isArray(value) &&
    value.some((entry) => {
      const source = asObject(entry);
      return Boolean(
        source &&
          ("min_num_options" in source ||
            "min_selections" in source ||
            "item_extra_options" in source ||
            Array.isArray(source.options))
      );
    })
  );
}

const MAX_MODIFIER_DEPTH = 5;
const MAX_MODIFIER_GROUPS = 25;
const MAX_MODIFIER_OPTIONS = 100;

function modifierGroups(
  value,
  state = { groups: 0, options: 0 },
  depth = 0
) {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  if (depth >= MAX_MODIFIER_DEPTH) {
    throw new UpstreamSchemaError(
      "DoorDash modifier data exceeded the safe MCP size limit. No cart change was made; use DoorDash checkout instead of retrying this item."
    );
  }
  assertObjectArray(value, "modifier groups");
  state.groups += value.length;
  if (state.groups > MAX_MODIFIER_GROUPS) {
    throw new UpstreamSchemaError(
      "DoorDash modifier data exceeded the safe MCP size limit. No cart change was made; use DoorDash checkout instead of retrying this item."
    );
  }
  return value.map((entry) => {
    const source = asObject(entry);
    const optionValues = first(
      source.options,
      source.item_extra_options,
      source.choices,
      []
    );
    if (!Array.isArray(optionValues)) {
      throw new UpstreamSchemaError(
        "DoorDash modifier group contained malformed options."
      );
    }
    assertObjectArray(optionValues, "modifier options");
    state.options += optionValues.length;
    if (state.options > MAX_MODIFIER_OPTIONS) {
      throw new UpstreamSchemaError(
        "DoorDash modifier data exceeded the safe MCP size limit. No cart change was made; use DoorDash checkout instead of retrying this item."
      );
    }
    const minimum = numberValue(
      source.min_selections,
      source.min_num_options,
      source.min
    );
    const required =
      minimum === undefined
        ? booleanValue(source.required)
        : undefined;
    return compactRecord([
      ["group_id", idValue(source.group_id, source.extra_id, source.id)],
      ["name", stringValue(source.name, source.title)],
      ["required", required === true ? true : undefined],
      ["min_selections", minimum],
      [
        "max_selections",
        numberValue(
          source.max_selections,
          source.max_num_options,
          source.max
        )
      ],
      [
        "options",
        Array.isArray(optionValues)
          ? optionValues.flatMap((option) => {
              const item = asObject(option);
              const optionId = idValue(
                item.option_id,
                item.item_extra_option_id,
                item.id
              );
              if (!optionId) {
                throw new UpstreamSchemaError(
                  "DoorDash modifier data omitted an option_id. No cart change was made; use DoorDash checkout instead of guessing or retrying this item."
                );
              }
              const nestedGroups = modifierGroups(
                first(item.modifier_groups, item.extras, item.options),
                state,
                depth + 1
              );
              return [compactRecord([
                [
                  "option_id",
                  optionId
                ],
                [
                  "name",
                  stringValue(
                    item.name,
                    item.value,
                    item.item_extra_option?.name
                  )
                ],
                [
                  "price",
                  money(
                    first(
                      item.price,
                      item.price_monetary_fields,
                      item.unit_price
                    )
                  )
                ],
                [
                  "available",
                  booleanValue(
                    item.available,
                    item.is_available,
                    item.isActive
                  )
                ],
                ["quantity", numberValue(item.quantity)],
                ["modifier_groups", nestedGroups]
              ])];
            })
          : []
      ]
    ]);
  });
}

function normalizeItem(
  value,
  {
    cartLine = false,
    includeModifierGroups = true,
    includeSubstitutions = true
  } = {}
) {
  const source = asObject(value) || {};
  const nestedItem = asObject(source.item) || {};
  const substitutions = first(source.substitutions, source.alternatives);
  const rawOptions = first(
    source.modifier_groups,
    source.extras,
    source.required_options,
    looksLikeModifierGroups(source.options) ? source.options : undefined
  );
  const selectedOptions = normalizeSelectedOptions(
    first(
      source.selected_options,
      source.nested_options,
      cartLine && !looksLikeModifierGroups(source.options)
        ? source.options
        : undefined
    )
  );

  return compactRecord([
    [
      "item_id",
      idValue(
        source.item_id,
        source.menu_item_id,
        nestedItem.item_id,
        nestedItem.id,
        cartLine ? undefined : source.id
      )
    ],
    [
      "cart_item_id",
      idValue(
        source.cart_item_id,
        source.line_item_id,
        cartLine ? source.id : undefined
      )
    ],
    ["name", stringValue(source.name, source.item_name, nestedItem.name)],
    [
      "description",
      stringValue(
        source.description,
        source.subtitle,
        nestedItem.description
      )
    ],
    [
      "image_url",
      stringValue(
        source.image_url,
        source.imageUrl,
        source.photo_url,
        nestedItem.image_url
      )
    ],
    ["quantity", numberValue(source.quantity, source.qty)],
    [
      "price",
      money(
        first(
          source.price,
          source.unit_price,
          source.unit_price_monetary_fields,
          source.price_monetary_fields,
          nestedItem.price
        )
      )
    ],
    [
      "original_price",
      money(first(source.original_price, source.pre_discount_price))
    ],
    [
      "available",
      booleanValue(
        source.available,
        source.is_available,
        source.in_stock
      )
    ],
    [
      "has_modifiers",
      booleanValue(
        source.has_modifiers,
        source.hasModifiers,
        rawOptions?.length ? true : undefined
      )
    ],
    [
      "has_required_modifiers",
      booleanValue(
        source.has_required_modifiers,
        source.hasRequiredModifiers,
        Array.isArray(rawOptions)
          ? rawOptions.some((group) => {
              const minimum = numberValue(
                group?.min_selections,
                group?.min_num_options,
                group?.min
              );
              return minimum > 0 || booleanValue(group?.required) === true;
            })
          : undefined
      )
    ],
    ["purchase_type", stringValue(source.purchase_type)],
    [
      "measurement_unit",
      stringValue(source.measurement_unit, source.unit)
    ],
    ["increment", numberValue(source.increment)],
    ["selected_options", selectedOptions],
    [
      "substitutions",
      includeSubstitutions &&
      Array.isArray(substitutions) &&
      substitutions.length
        ? substitutions.map((entry) =>
            normalizeItem(entry, {
              includeModifierGroups,
              includeSubstitutions: false
            })
          )
        : undefined
    ],
    [
      "modifier_groups",
      includeModifierGroups ? modifierGroups(rawOptions) : undefined
    ]
  ]);
}

function storeLocationSource(source) {
  return first(
    source.location,
    source.address,
    source.store_address,
    source.physical_address,
    source
  );
}

function fulfillmentOptions(source) {
  const raw = first(
    source.fulfillment_options,
    source.fulfillment_capabilities,
    source.capabilities
  );
  const values = Array.isArray(raw)
    ? raw
        .map((value) =>
          typeof value === "string"
            ? value
            : stringValue(value?.type, value?.name, value?.fulfillment_type)
        )
        .filter(Boolean)
    : [];
  if (source.delivery_available === true) {
    values.push("delivery");
  }
  if (source.pickup_available === true) {
    values.push("pickup");
  }
  return values.length ? [...new Set(values)] : undefined;
}

function normalizeStore(value, { includeDiscovery = true } = {}) {
  const source = asObject(value) || {};
  const deliveryValue = {
    ...source,
    ...(asObject(source.delivery) || {}),
    ...(asObject(source.delivery_availability) || {})
  };
  return compactRecord([
    ["store_id", idValue(source.store_id, source.storeId, source.id)],
    [
      "name",
      stringValue(source.name, source.store_name, source.business_name)
    ],
    [
      "image_url",
      stringValue(
        source.image_url,
        source.imageUrl,
        source.cover_image_url,
        source.header_image_url
      )
    ],
    [
      "vertical",
      stringValue(
        source.vertical,
        source.business_vertical,
        source.business_vertical_id,
        source.order_target
      )
    ],
    ["location", normalizeLocation(storeLocationSource(source))],
    ["distance", includeDiscovery ? displayDistance(source) : undefined],
    [
      "fulfillment",
      includeDiscovery ? fulfillmentOptions(source) : undefined
    ],
    [
      "delivery_time",
      includeDiscovery ? deliveryTime(deliveryValue) : undefined
    ]
  ]);
}

function pricingLines(lines) {
  if (!Array.isArray(lines)) {
    throw new UpstreamSchemaError(
      "DoorDash pricing contained malformed line items."
    );
  }
  assertObjectArray(lines, "pricing line items");
  return lines.map((line) => {
    const source = asObject(line);
    return compactRecord([
      ["label", stringValue(source.label, source.name, source.description)],
      [
        "amount",
        money(first(source.amount, source.final_money, source.money, source.price))
      ],
      [
        "_match",
        stringValue(
          source.code,
          source.charge_id,
          source.id,
          source.label,
          source.name
        )
      ]
    ]);
  });
}

function publicPricingLine(line) {
  return compactRecord([
    ["label", line.label],
    ["amount", line.amount]
  ]);
}

function findPricingLine(lines, pattern) {
  return lines.find((line) =>
    pattern.test(`${line._match || ""} ${line.label || ""}`)
  )?.amount;
}

function normalizePricing(value, { tipCents } = {}) {
  const source = asObject(value) || {};
  const lines = pricingLines(
    first(
      source.line_items,
      source.pricing_line_items,
      source.charges,
      []
    )
  );
  const creditSourceLines = lines.filter((line) =>
    /credit/i.test(`${line._match || ""} ${line.label || ""}`)
  );
  const discountSourceLines = lines.filter((line) =>
    !creditSourceLines.includes(line) &&
    /discount|saving|promo/i.test(`${line._match || ""} ${line.label || ""}`)
  );
  const feeSourceLines = lines.filter(
    (line) =>
      !creditSourceLines.includes(line) &&
      !discountSourceLines.includes(line) &&
      /fee|delivery|service|small order|priority/i.test(
        `${line._match || ""} ${line.label || ""}`
      )
  );
  const feeLines = feeSourceLines.map(publicPricingLine);
  const feesContainTax = feeSourceLines.some(
    (line) =>
      /tax/i.test(`${line._match || ""} ${line.label || ""}`) &&
      /fee/i.test(`${line._match || ""} ${line.label || ""}`)
  );
  const discountLines = discountSourceLines.map(publicPricingLine);
  const tip =
    tipCents === undefined
      ? money(first(source.tip, source.dasher_tip, source.tip_amount)) ??
        findPricingLine(lines, /tip/i)
      : moneyFromCents(tipCents);
  const totalBeforeTip = money(
    first(source.total_before_tip, source.net_total_before_tip)
  );
  const explicitTotal = money(
    first(source.final_total, source.grand_total, source.total)
  );
  const total =
    tipCents !== undefined &&
    totalBeforeTip !== undefined &&
    tip !== undefined
      ? roundDollars(totalBeforeTip + tip)
      : explicitTotal ??
        (totalBeforeTip !== undefined && tip !== undefined
          ? roundDollars(totalBeforeTip + tip)
          : undefined);

  const result = compactRecord([
    [
      "subtotal",
      money(first(source.subtotal, source.item_subtotal)) ??
        findPricingLine(lines, /subtotal|items?/i)
    ],
    ["fees", feeLines.length ? feeLines : undefined],
    [
      "tax",
      feesContainTax
        ? undefined
        : money(first(source.tax, source.tax_amount)) ??
          findPricingLine(lines, /tax/i)
    ],
    [
      "discounts",
      discountLines.length ? discountLines : undefined
    ],
    [
      "credits",
      money(
        first(
          source.credits,
          source.credits_applied,
          source.credit_details?.total_credits_applied
        )
      ) ?? creditSourceLines[0]?.amount
    ],
    ["tip", tip],
    ["total_before_tip", totalBeforeTip],
    ["total", total]
  ]);
  return nonEmptyRecord(result);
}

function normalizeCart(value, { itemLimit = 100 } = {}) {
  const wrapper = asObject(value) || {};
  const source = {
    ...wrapper,
    ...(asObject(wrapper.cart) || {})
  };
  const rawItems = Array.isArray(source.items) ? source.items : [];
  const items = rawItems
    .slice(0, itemLimit)
    .map((entry) => normalizeItem(entry, { cartLine: true }));
  const storeValue =
    asObject(source.store) ||
    (source.store_id || source.store_name
      ? {
          store_id: source.store_id,
          store_name: source.store_name,
          image_url: source.store_image_url
        }
      : undefined);
  const links = responseLinks(source);
  return compactRecord([
    [
      "cart_uuid",
      idValue(source.cart_uuid, source.uuid, source.id, value?.cart_uuid)
    ],
    [
      "store",
      storeValue
        ? normalizeStore(storeValue, { includeDiscovery: false })
        : undefined
    ],
    ["items", items],
    ["items_truncation", truncation(rawItems.length, items.length)],
    [
      "fulfillment",
      normalizeFulfillment(
        first(source.fulfillment, source.fulfillment_type)
      )
    ],
    ["created_at", isoTimestamp(source.created_at)],
    ["updated_at", isoTimestamp(source.updated_at)],
    ["checkout_url", links.checkout_url],
    ["group_cart_url", links.group_cart_url]
  ]);
}

function quoteItems(quote) {
  const orders = quote?.store_order_cart?.orders;
  if (!Array.isArray(orders)) {
    return undefined;
  }
  return orders.flatMap((order) =>
    Array.isArray(order.order_items)
      ? order.order_items.map((entry) => normalizeItem(entry, { cartLine: true }))
      : []
  );
}

function normalizeOrder(value, options = {}) {
  const wrapper = asObject(value) || {};
  const source = {
    ...wrapper,
    ...(asObject(wrapper.receipt) || {}),
    ...(asObject(wrapper.order) || {})
  };
  const previewQuote = nonEmptyObject(options.preview?.quote);
  const sourceQuote = nonEmptyObject(source.quote);
  const quote = options.preferPreview
    ? previewQuote || sourceQuote
    : sourceQuote || previewQuote;
  const cart = asObject(quote?.store_order_cart);
  const previewItems = quoteItems(previewQuote);
  const sourceItemAliases = [
    source.items,
    source.order_items,
    source.ordered_items
  ];
  const nonEmptySourceItems = sourceItemAliases.find(
    (entry) => Array.isArray(entry) && entry.length
  );
  const firstSourceItems = sourceItemAliases.find(Array.isArray);
  const itemsSource =
    options.preferPreview && Array.isArray(previewItems)
      ? previewItems
      : nonEmptySourceItems || firstSourceItems || quoteItems(quote);
  const itemLimit =
    Number.isInteger(options.itemLimit) && options.itemLimit >= 0
      ? options.itemLimit
      : 100;
  const items = Array.isArray(itemsSource)
    ? itemsSource.slice(0, itemLimit).map((entry) =>
        entry?.item_id || entry?.cart_item_id
          ? normalizeItem(entry, { cartLine: true })
          : normalizeItem(entry)
      )
    : undefined;
  const previewStore =
    nonEmptyObject(options.preview?.store) ||
    nonEmptyObject(previewQuote?.store_order_cart?.store);
  const sourceStore = nonEmptyObject(source.store);
  const storeValue =
    (options.preferPreview ? previewStore || sourceStore : sourceStore) ||
    nonEmptyObject(cart?.store) ||
    previewStore ||
    (source.store_id || source.store_name
      ? {
          store_id: source.store_id,
          store_name: source.store_name,
          image_url: source.store_image_url
        }
      : undefined);
  const deliveryAvailability = first(
    source.delivery_availability,
    quote?.delivery_availability,
    findFirstObject(
      quote,
      (entry) =>
        "asap_minutes_range_string" in entry ||
        "asap_minutes_range" in entry
    ),
    source.delivery,
    source.delivery_time,
    source.eta
  );
  const consumerPickup = booleanValue(cart?.is_consumer_pickup);
  const fulfillment = normalizeFulfillment(
    first(
      source.fulfillment,
      source.fulfillment_type,
      consumerPickup === true ? "pickup" : undefined,
      consumerPickup === false ? "delivery" : undefined
    )
  );
  const paymentSource =
    asObject(source.payment) ||
    asObject(source.payment_method) ||
    asObject(options.payment) ||
    {};
  const payment = nonEmptyRecord(
    compactRecord([
      [
        "type",
        stringValue(
          paymentSource.type,
          source.payment_profile_type,
          quote?.payment_profile_type
        )
      ],
      ["brand", stringValue(paymentSource.brand, source.card_brand)],
      [
        "last4",
        stringValue(paymentSource.last4, source.last4, source.card_last4)
      ],
      [
        "budget_name",
        stringValue(paymentSource.budgetName, paymentSource.budget_name)
      ]
    ])
  );
  const finalLinks = responseLinks(options.finalStatus);
  const finalOrderLinks = responseLinks(options.finalStatus?.order);
  const submittedOrderLinks = responseLinks(options.submitted?.order);
  const submittedLinks = responseLinks(options.submitted);
  const sourceLinks = responseLinks(source);
  const links = compactRecord([
    [
      "checkout_url",
      first(
        finalLinks.checkout_url,
        finalOrderLinks.checkout_url,
        submittedOrderLinks.checkout_url,
        submittedLinks.checkout_url,
        sourceLinks.checkout_url
      )
    ],
    [
      "tracking_url",
      first(
        finalLinks.tracking_url,
        finalOrderLinks.tracking_url,
        submittedOrderLinks.tracking_url,
        submittedLinks.tracking_url,
        sourceLinks.tracking_url
      )
    ],
    [
      "group_cart_url",
      first(
        finalLinks.group_cart_url,
        finalOrderLinks.group_cart_url,
        submittedOrderLinks.group_cart_url,
        submittedLinks.group_cart_url,
        sourceLinks.group_cart_url
      )
    ]
  ]);

  return compactRecord([
    [
      "order_uuid",
      idValue(
        source.order_uuid,
        source.orderUuid,
        options.orderUuid,
        options.submitted?.order_uuid
      )
    ],
    [
      "cart_uuid",
      idValue(
        source.cart_uuid,
        source.cartUuid,
        quote?.id,
        options.preview?.cart_uuid
      )
    ],
    ["status", stringValue(options.status, source.status, source.order_status)],
    [
      "store",
      storeValue
        ? normalizeStore(storeValue, { includeDiscovery: false })
        : undefined
    ],
    ["items", items],
    [
      "items_truncation",
      Array.isArray(itemsSource)
        ? truncation(itemsSource.length, items.length)
        : undefined
    ],
    ["fulfillment", fulfillment],
    [
      "delivery_address",
      normalizeLocation(first(source.delivery_address, quote?.delivery_address))
    ],
    ["delivery_time", deliveryTime(deliveryAvailability)],
    [
      "scheduled_time",
      isoTimestamp(
        first(
          source.scheduled_for,
          source.scheduled_time,
          source.delivery_time_at
        )
      )
    ],
    [
      "pricing",
      normalizePricing(first(quote, source), {
        tipCents: options.tipCents
      })
    ],
    ["payment", payment],
    ["checkout_url", links.checkout_url],
    ["tracking_url", links.tracking_url],
    ["group_cart_url", links.group_cart_url],
    [
      "reorderable",
      booleanValue(source.is_reorderable, source.reorderable)
    ],
    [
      "placed_at",
      isoTimestamp(first(source.placed_at, source.created_at, source.order_time))
    ]
  ]);
}

export class UpstreamSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "UpstreamSchemaError";
    this.code = "UPSTREAM_SCHEMA_ERROR";
  }
}

function assertObjectArray(values, label) {
  if (values.some((value) => !asObject(value))) {
    throw new UpstreamSchemaError(
      `DoorDash ${label} contained a malformed object.`
    );
  }
}

class DoorDashOperationError extends Error {
  constructor(message, { code, details } = {}) {
    super(message);
    this.name = "DoorDashOperationError";
    this.code = code || "DOORDASH_OPERATION_FAILED";
    this.details = details;
  }
}

function card(kind, fields, warnings = []) {
  return {
    schema: RESPONSE_SCHEMA,
    version: RESPONSE_SCHEMA_VERSION,
    kind,
    ...fields,
    ...(warnings.length ? { warnings } : {})
  };
}

function truncation(originalLength, returnedLength, upstreamTruncated = false) {
  if (originalLength <= returnedLength && !upstreamTruncated) {
    return undefined;
  }
  return compactRecord([
    ["returned", returnedLength],
    [
      "omitted",
      originalLength > returnedLength
        ? originalLength - returnedLength
        : undefined
    ]
  ]);
}

function storeSearchProject(data) {
  const source = asObject(data);
  if (!source || !Array.isArray(source.stores)) {
    throw new UpstreamSchemaError(
      "DoorDash returned an invalid store-search response."
    );
  }
  const rawStores = source.stores;
  assertObjectArray(rawStores, "store-search response");
  const normalizedStores = rawStores
    .slice(0, 100)
    .map((entry) => normalizeStore(entry));
  const stores = normalizedStores.filter((store) => store.store_id);
  const warnings = warningList(source.warning);
  if (stores.length !== normalizedStores.length) {
    warnings.push("Stores without a usable store_id were omitted.");
  }
  return card(
    "store_search",
    compactRecord([
      ["stores", stores],
      [
        "truncation",
        truncation(
          rawStores.length,
          stores.length,
          booleanValue(source.truncated) === true
        )
      ]
    ]),
    warnings
  );
}

function storeDetailsProject(data) {
  const source = asObject(data);
  if (!source) {
    throw new UpstreamSchemaError("DoorDash returned invalid store details.");
  }
  const store = normalizeStore(source.store || source);
  if (!store.store_id) {
    throw new UpstreamSchemaError(
      "DoorDash store details did not contain the store_id needed for follow-up tools."
    );
  }
  return card("store_details", { store });
}

function menuProject(data) {
  const source = asObject(data);
  if (!source) {
    throw new UpstreamSchemaError("DoorDash returned an invalid menu.");
  }
  if (
    source.categories !== undefined &&
    source.categories !== null &&
    !Array.isArray(source.categories)
  ) {
    throw new UpstreamSchemaError(
      "DoorDash menu response contained malformed categories."
    );
  }
  const categories = Array.isArray(source.categories) ? source.categories : [];
  assertObjectArray(categories, "menu categories");
  for (const category of categories) {
    if (
      category.items !== undefined &&
      category.items !== null &&
      !Array.isArray(category.items)
    ) {
      throw new UpstreamSchemaError(
        "DoorDash menu category contained malformed items."
      );
    }
    if (Array.isArray(category.items)) {
      assertObjectArray(category.items, "menu category items");
    }
  }
  const categoryItems = categories.flatMap((category) =>
    Array.isArray(category?.items) ? category.items : []
  );
  const rawItems = Array.isArray(source.items)
    ? source.items
    : categoryItems.length
      ? categoryItems
      : undefined;
  if (!rawItems) {
    throw new UpstreamSchemaError(
      "DoorDash menu response did not contain an items array."
    );
  }
  assertObjectArray(rawItems, "menu items");
  const normalizedItems = rawItems
    .slice(0, 50)
    .map((entry) =>
      normalizeItem(entry, {
        includeModifierGroups: false,
        includeSubstitutions: false
      })
    );
  const items = normalizedItems.filter((item) => item.item_id && item.name);
  const returnedItemIds = new Set(items.map((item) => item.item_id));
  const storeValue =
    source.store ||
    (source.store_id || source.store_name
      ? { store_id: source.store_id, store_name: source.store_name }
      : undefined);
  const warnings = warningList(source.warning);
  if (items.length !== normalizedItems.length) {
    warnings.push("Menu items without item_id or name were omitted.");
  }
  if (rawItems.length > 50) {
    warnings.push(
      `${rawItems.length - 50} menu items were omitted. Call get_menu again with query set to the requested dish name.`
    );
  }
  const appliedQuery = stringValue(source.mcp_query);
  if (items.length === 0 && appliedQuery) {
    warnings.push(
      `No menu items matched query "${appliedQuery}". Do not repeat it unchanged; try one broader dish name or call get_menu once without query.`
    );
  }
  if (categories.length > 50) {
    warnings.push(
      `${categories.length - 50} menu categories were omitted. Use query to request the dish name directly.`
    );
  }
  const menuId = idValue(source.menu_id, source.menuId);
  if (!menuId) {
    throw new UpstreamSchemaError(
      "DoorDash menu response did not contain menu_id."
    );
  }
  return card(
    "menu",
    compactRecord([
      [
        "store",
        storeValue
          ? normalizeStore(storeValue, { includeDiscovery: false })
          : undefined
      ],
      ["menu_id", menuId],
      ["items", items],
      [
        "categories",
        categories.length
          ? categories
              .slice(0, 50)
              .map((category) =>
                compactRecord([
                  ["category_id", idValue(category.id, category.category_id)],
                  ["name", stringValue(category.name, category.title)],
                  [
                    "item_ids",
                    Array.isArray(category.items)
                      ? category.items
                          .map((item) => idValue(item.item_id, item.id))
                          .filter((itemId) => returnedItemIds.has(itemId))
                      : []
                  ]
                ])
              )
              .filter((category) => category.item_ids.length > 0)
          : undefined
      ],
      [
        "truncation",
        truncation(
          rawItems.length,
          items.length,
          booleanValue(source.truncated) === true
        )
      ]
    ]),
    warnings
  );
}

function itemDetailsProject(data) {
  const source = asObject(data);
  if (!source) {
    throw new UpstreamSchemaError("DoorDash returned invalid item details.");
  }
  const item = normalizeItem(source.item || source);
  if (!item.item_id || !item.name) {
    throw new UpstreamSchemaError(
      "DoorDash item details did not contain item_id and name."
    );
  }
  const storeValue =
    source.store ||
    (source.store_id || source.store_name
      ? { store_id: source.store_id, store_name: source.store_name }
      : undefined);
  const menuId = idValue(source.menu_id, source.menuId);
  const warnings = warningList(source.warning);
  if (!menuId) {
    warnings.push(
      "DoorDash did not return menu_id. This item cannot be sent to add_cart_items until a menu_id is available."
    );
  }
  return card(
    "item_details",
    compactRecord([
      [
        "store",
        storeValue
          ? normalizeStore(storeValue, { includeDiscovery: false })
          : undefined
      ],
      ["menu_id", menuId],
      ["item", item]
    ]),
    warnings
  );
}

function itemSearchGroups(source) {
  const rawResults = source.results;
  if (Array.isArray(rawResults)) {
    const groupedEntries = rawResults.map((entry) => {
      const sourceEntry = asObject(entry);
      return (
        sourceEntry &&
        Array.isArray(
          first(sourceEntry.items, sourceEntry.results, sourceEntry.matches)
        )
      );
    });
    const grouped = groupedEntries.every(Boolean);
    if (groupedEntries.some(Boolean) && !grouped) {
      throw new UpstreamSchemaError(
        "DoorDash item-search response mixed grouped and ungrouped results."
      );
    }
    return grouped
      ? rawResults.map((entry) => ({
          query: stringValue(entry.query, entry.term),
          items: first(entry.items, entry.results, entry.matches)
        }))
      : [{ query: stringValue(source.query), items: rawResults }];
  }

  if (asObject(rawResults)) {
    const entries = Object.entries(rawResults);
    if (entries.some(([, items]) => !Array.isArray(items))) {
      throw new UpstreamSchemaError(
        "DoorDash item-search response contained malformed result arrays."
      );
    }
    return entries.map(([query, items]) => ({ query, items }));
  }

  throw new UpstreamSchemaError(
    "DoorDash item-search response did not contain results."
  );
}

function itemSearchProject(data) {
  const source = asObject(data);
  if (!source) {
    throw new UpstreamSchemaError(
      "DoorDash returned invalid item-search results."
    );
  }
  const groups = itemSearchGroups(source);
  let omittedItems = 0;
  const results = groups.map((group) => {
    assertObjectArray(group.items, "item-search results");
    const normalizedItems = group.items
      .slice(0, 25)
      .map((entry) => normalizeItem(entry));
    const items = normalizedItems.filter((item) => item.item_id && item.name);
    omittedItems += normalizedItems.length - items.length;
    return compactRecord([
      ["query", group.query],
      ["items", items],
      ["truncation", truncation(group.items.length, items.length)]
    ]);
  });
  const warnings = warningList(source.warning);
  if (omittedItems) {
    warnings.push(
      `${omittedItems} item-search result${omittedItems === 1 ? "" : "s"} without item_id or name ${omittedItems === 1 ? "was" : "were"} omitted.`
    );
  }
  return card(
    "item_search",
    compactRecord([
      [
        "store",
        source.store
          ? normalizeStore(source.store, { includeDiscovery: false })
          : undefined
      ],
      ["results", results]
    ]),
    warnings
  );
}

function groceryProject(data) {
  const source = asObject(data);
  if (!source || !Array.isArray(source.items)) {
    throw new UpstreamSchemaError(
      "DoorDash returned an invalid grocery-list response."
    );
  }
  assertObjectArray(source.items, "grocery-list items");
  const normalizedItems = source.items
    .slice(0, 25)
    .map((entry) => normalizeItem(entry));
  const items = normalizedItems.filter((item) => item.item_id && item.name);
  const rawStores = Array.isArray(source.available_stores)
    ? source.available_stores
    : [];
  assertObjectArray(rawStores, "grocery-list stores");
  const normalizedStores = rawStores
    .slice(0, 25)
    .map((entry) => normalizeStore(entry));
  const availableStores = normalizedStores.filter((store) => store.store_id);
  const selectedStoreId = idValue(
    source.store_id,
    source.items[0]?.store_id,
    availableStores.find((store) => store.name === source.store_name)?.store_id
  );
  const selectedStore = normalizeStore({
    store_id: selectedStoreId,
    store_name: source.store_name,
    image_url: source.store_image_url,
    delivery_time: source.delivery_time
  });
  const menuId = idValue(source.menu_id);
  const warnings = warningList(source.warning);
  if (items.length !== normalizedItems.length) {
    warnings.push("Grocery results without item_id or name were omitted.");
  }
  if (availableStores.length !== normalizedStores.length) {
    warnings.push("Available stores without store_id were omitted.");
  }
  if (items.length && !menuId) {
    warnings.push(
      "DoorDash did not return menu_id. Call get_item_details for a chosen item before add_cart_items."
    );
  }
  return card(
    "grocery_list",
    compactRecord([
      ["store", nonEmptyRecord(selectedStore)],
      ["menu_id", menuId],
      ["items", items],
      [
        "available_stores",
        availableStores.length ? availableStores : undefined
      ],
      ["delivery_address", normalizeLocation(source.delivery_address)],
      [
        "items_truncation",
        truncation(
          source.items.length,
          items.length,
          booleanValue(source.truncated) === true
        )
      ],
      [
        "available_stores_truncation",
        truncation(rawStores.length, availableStores.length)
      ]
    ]),
    warnings
  );
}

function normalizedCartItemError(entry) {
  const sourceEntry = asObject(entry) || {};
  const requestSource = asObject(sourceEntry.request) || {};
  const item = normalizeItem(
    sourceEntry.item || sourceEntry.request || sourceEntry
  );
  const rawRequestIndex = numberValue(
    sourceEntry.request_index,
    requestSource.request_index
  );
  const requestIndex =
    Number.isInteger(rawRequestIndex) && rawRequestIndex >= 0
      ? rawRequestIndex
      : undefined;
  return {
    request_index: requestIndex,
    item: compactRecord([
      ["item_id", item.item_id],
      ["name", item.name],
      ["quantity", item.quantity],
      ["selected_options", item.selected_options]
    ]),
    message: stringValue(sourceEntry.error_message, sourceEntry.message),
    modifier_groups: modifierGroups(
      first(
        sourceEntry.required_options,
        sourceEntry.modifier_groups,
        item.modifier_groups
      )
    )
  };
}

function failedLine(item) {
  return compactRecord([
    ["item_id", item?.item_id],
    ["name", item?.name],
    ["quantity", item?.quantity],
    ["selected_options", item?.selected_options]
  ]);
}

function selectedOptionsSignature(item) {
  return JSON.stringify(item?.selected_options || []);
}

function mergeCartItemErrors(request, errors, requests = []) {
  const messages = [
    ...new Set(errors.map((error) => error.message).filter(Boolean))
  ];
  const seenGroups = new Set();
  const groups = [];
  for (const error of errors) {
    for (const group of error.modifier_groups || []) {
      const signature = JSON.stringify(group);
      if (!seenGroups.has(signature)) {
        seenGroups.add(signature);
        groups.push(group);
      }
    }
  }
  const ambiguousIndexes = [
    ...new Set(
      errors.flatMap((error) => error.ambiguous_candidates || [])
    )
  ];
  return compactRecord([
    ["request_index", request?.request_index ?? errors[0]?.request_index],
    ["item", request ? failedLine(request) : errors[0]?.item],
    ["message", messages.length ? messages.join(" ") : undefined],
    ["modifier_groups", groups.length ? groups : undefined],
    ["ambiguous", ambiguousIndexes.length ? true : undefined],
    [
      "candidates",
      ambiguousIndexes.length
        ? ambiguousIndexes.map((index) => ({
            request_index: requests[index].request_index,
            item: failedLine(requests[index])
          }))
        : undefined
    ]
  ]);
}

function reconcileCartItemErrors(rawErrors, requestedItems) {
  const normalized = rawErrors.map(normalizedCartItemError);
  if (!requestedItems.length) {
    const seen = new Set();
    const errors = [];
    for (const error of normalized) {
      const signature = JSON.stringify(error);
      if (!seen.has(signature) && errors.length < 50) {
        seen.add(signature);
        errors.push(error);
      }
    }
    return {
      errors,
      collapsed: normalized.length - errors.length,
      positional: 0
    };
  }

  const requests = requestedItems.map((entry, index) => {
    const item = normalizeItem(entry);
    const rawRequestIndex = numberValue(entry.request_index);
    return {
      request_index:
        Number.isInteger(rawRequestIndex) && rawRequestIndex >= 0
          ? rawRequestIndex
          : index,
      item_id: item.item_id,
      name: item.name,
      quantity: item.quantity,
      selected_options: item.selected_options
    };
  });
  const buckets = requests.map(() => []);
  let positional = 0;
  for (const error of normalized) {
    const errorId = error.item?.item_id;
    const errorName = normalizedChoiceText(error.item?.name);
    const explicitIndex = requests.findIndex(
      (request) => request.request_index === error.request_index
    );
    let candidates =
      explicitIndex >= 0
        ? [explicitIndex]
        : requests
            .map((request, index) => ({ request, index }))
            .filter(({ request }) => errorId && request.item_id === errorId)
            .map(({ index }) => index);
    if (!candidates.length && errorName) {
      candidates = requests
        .map((request, index) => ({ request, index }))
        .filter(
          ({ request }) => normalizedChoiceText(request.name) === errorName
        )
        .map(({ index }) => index);
    }
    if (candidates.length > 1 && error.item?.selected_options?.length) {
      const optionMatches = candidates.filter(
        (index) =>
          selectedOptionsSignature(requests[index]) ===
          selectedOptionsSignature(error.item)
      );
      if (optionMatches.length) {
        candidates = optionMatches;
      }
    }
    if (!candidates.length) {
      candidates = buckets
        .map((bucket, index) => ({ bucket, index }))
        .filter(({ bucket }) => bucket.length === 0)
        .map(({ index }) => index);
      if (!candidates.length) {
        candidates = requests.map((_, index) => index);
      }
      positional += 1;
    }
    const target =
      candidates.find((index) => buckets[index].length === 0) ??
      candidates[0];
    buckets[target].push({
      ...error,
      ...(candidates.length > 1
        ? { ambiguous_candidates: candidates }
        : {})
    });
  }

  const errors = buckets.flatMap((bucket, index) =>
    bucket.length
      ? [mergeCartItemErrors(requests[index], bucket, requests)]
      : []
  );
  return {
    errors,
    collapsed: normalized.length - errors.length,
    positional
  };
}

const MAX_CART_ERROR_MODIFIER_DETAILS = 2;

function limitCartErrorModifierDetails(errors) {
  const seenItemIds = new Set();
  let kept = 0;
  let omitted = 0;
  let repeated = 0;
  const limited = errors.map((error) => {
    if (!error.modifier_groups?.length) {
      return error;
    }
    const itemId = error.item?.item_id;
    const { modifier_groups: _modifierGroups, ...withoutGroups } = error;
    if (itemId && seenItemIds.has(itemId)) {
      repeated += 1;
      return {
        ...withoutGroups,
        message: `${withoutGroups.message || "This item needs attention."} Use the modifier choices listed for the same item_id above.`
      };
    }
    if (itemId) {
      seenItemIds.add(itemId);
    }
    if (kept < MAX_CART_ERROR_MODIFIER_DETAILS) {
      kept += 1;
      return error;
    }
    omitted += 1;
    return {
      ...withoutGroups,
      message: `${withoutGroups.message || "This item needs attention."} Modifier choices were omitted to keep this result small; call get_item_details for this item_id before retrying.`
    };
  });
  return { errors: limited, omitted, repeated };
}

function normalizedChoiceText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function cartProject(data) {
  const source = asObject(data);
  if (!source) {
    throw new UpstreamSchemaError("DoorDash returned an invalid cart response.");
  }
  const cartSource = asObject(source.cart) || source;
  const rawErrors = Array.isArray(source.item_errors) ? source.item_errors : [];
  if (!Array.isArray(cartSource.items) && rawErrors.length === 0) {
    throw new UpstreamSchemaError(
      "DoorDash cart response did not contain an items array."
    );
  }
  if (Array.isArray(cartSource.items)) {
    assertObjectArray(cartSource.items, "cart items");
  }
  assertObjectArray(rawErrors, "cart item errors");
  const cartData = normalizeCart(source);
  if (!cartData.cart_uuid && rawErrors.length === 0) {
    throw new UpstreamSchemaError(
      "DoorDash cart response did not contain cart_uuid."
    );
  }
  const requestedItems = Array.isArray(source.mcp_requested_items)
    ? source.mcp_requested_items
    : [];
  assertObjectArray(requestedItems, "requested cart items");
  const reconciled = reconcileCartItemErrors(rawErrors, requestedItems);
  const limitedDetails = limitCartErrorModifierDetails(
    reconciled.errors
  );
  const itemErrors = limitedDetails.errors;
  const warnings = warningList(source.warning);
  const cartLinesWithoutIds = cartData.items.filter(
    (item) => !item.cart_item_id
  ).length;
  if (cartLinesWithoutIds) {
    warnings.push(
      `${cartLinesWithoutIds} cart line${cartLinesWithoutIds === 1 ? " is" : "s are"} missing cart_item_id and cannot be passed to remove_cart_item. Do not substitute item_id.`
    );
  }
  if (reconciled.collapsed > 0) {
    warnings.push(
      `${reconciled.collapsed} duplicate or excess cart item error${reconciled.collapsed === 1 ? " was" : "s were"} collapsed to one result per requested line.`
    );
  }
  if (reconciled.positional > 0) {
    warnings.push(
      `${reconciled.positional} cart item error${reconciled.positional === 1 ? " was" : "s were"} missing a matching item identifier and were reconciled by request order. Inspect the cart before retrying.`
    );
  }
  if (limitedDetails.omitted > 0) {
    warnings.push(
      `${limitedDetails.omitted} modifier choice set${limitedDetails.omitted === 1 ? " was" : "s were"} omitted from cart errors. Call get_item_details for those item_id values before retrying.`
    );
  }
  if (limitedDetails.repeated > 0) {
    warnings.push(
      `${limitedDetails.repeated} repeated modifier choice set${limitedDetails.repeated === 1 ? " was" : "s were"} omitted; use the choices shown for the same item_id.`
    );
  }
  return card(
    "cart",
    {
      ...cartData,
      ...(requestedItems.length
        ? {
            added_line_count: Math.max(
              0,
              requestedItems.length - itemErrors.length
            )
          }
        : {}),
      ...(itemErrors.length ? { item_errors: itemErrors } : {})
    },
    warnings
  );
}

function cartListProject(data) {
  const source = asObject(data);
  if (!source || !Array.isArray(source.carts)) {
    throw new UpstreamSchemaError(
      "DoorDash returned an invalid cart-list response."
    );
  }
  assertObjectArray(source.carts, "cart-list response");
  const normalizedCarts = source.carts
    .slice(0, 25)
    .map((entry) => normalizeCart(entry, { itemLimit: 10 }));
  const carts = normalizedCarts.filter((cart) => cart.cart_uuid);
  const warnings = warningList(source.warning);
  if (carts.length !== normalizedCarts.length) {
    warnings.push("Carts without cart_uuid were omitted.");
  }
  const omittedItems = carts.reduce(
    (total, cart) => total + (cart.items_truncation?.omitted || 0),
    0
  );
  if (omittedItems) {
    warnings.push(
      `${omittedItems} cart line${omittedItems === 1 ? " was" : "s were"} omitted from list_carts. Call show_cart for one cart's details.`
    );
  }
  const linesWithoutIds = carts.reduce(
    (total, cart) =>
      total + cart.items.filter((item) => !item.cart_item_id).length,
    0
  );
  if (linesWithoutIds) {
    warnings.push(
      `${linesWithoutIds} listed cart line${linesWithoutIds === 1 ? " is" : "s are"} missing cart_item_id. Call show_cart before remove_cart_item and never substitute item_id.`
    );
  }
  return card(
    "cart_list",
    compactRecord([
      ["carts", carts],
      [
        "truncation",
        truncation(
          source.carts.length,
          carts.length,
          booleanValue(source.truncated) === true
        )
      ]
    ]),
    warnings
  );
}

function operationError(source, fallback) {
  const message =
    stringValue(source.error_message, source.fail_reason, source.message) ||
    fallback;
  throw new DoorDashOperationError(message, {
    code: stringValue(source.error_reason, source.code),
    details: source
  });
}

function actionProject(kind, fallbackMessage) {
  return (data) => {
    const source = asObject(data);
    if (!source) {
      throw new UpstreamSchemaError(
        `DoorDash returned an invalid ${kind} response.`
      );
    }
    if (booleanValue(source.success) === false) {
      operationError(source, `${fallbackMessage} failed.`);
    }
    if (booleanValue(source.success) !== true) {
      throw new UpstreamSchemaError(
        `DoorDash ${kind} response did not confirm success.`
      );
    }
    const identifiers =
      kind === "address_update"
        ? compactRecord([
            ["address_id", idValue(source.address_id, source.id)]
          ])
        : kind === "cart_mutation"
          ? compactRecord([
              ["cart_uuid", idValue(source.cart_uuid, source.id)]
            ])
          : compactRecord([
              ["cart_uuid", idValue(source.cart_uuid)],
              ["promo_code", stringValue(source.promo_code)]
            ]);
    return card(
      kind,
      {
        ...identifiers,
        ...compactRecord([["message", stringValue(source.message)]])
      },
      warningList(source.warning)
    );
  };
}

function checkoutProject(data) {
  const source = asObject(data);
  if (!source) {
    throw new UpstreamSchemaError(
      "DoorDash returned an invalid checkout-link response."
    );
  }
  const links = responseLinks(source);
  if (!links.checkout_url) {
    throw new UpstreamSchemaError(
      "DoorDash checkout response did not contain a checkout URL."
    );
  }
  return card(
    "checkout_link",
    compactRecord([
      ["cart_uuid", idValue(source.cart_uuid, source.cartUuid)],
      ["checkout_url", links.checkout_url]
    ])
  );
}

function orderListProject(data) {
  const source = asObject(data);
  if (!source || !Array.isArray(source.orders)) {
    throw new UpstreamSchemaError(
      "DoorDash returned an invalid order-history response."
    );
  }
  assertObjectArray(source.orders, "order-history response");
  const normalizedOrders = source.orders
    .slice(0, 25)
    .map((entry) => normalizeOrder(entry, { itemLimit: 10 }));
  const orders = normalizedOrders.filter((order) => order.order_uuid);
  const warnings = warningList(source.warning);
  if (orders.length !== normalizedOrders.length) {
    warnings.push("Orders without order_uuid were omitted.");
  }
  const omittedItems = orders.reduce(
    (total, order) => total + (order.items_truncation?.omitted || 0),
    0
  );
  if (omittedItems) {
    warnings.push(
      `${omittedItems} order-history item${omittedItems === 1 ? " was" : "s were"} omitted. Call get_receipt with one order_uuid for itemized detail.`
    );
  }
  return card(
    "order_list",
    compactRecord([
      ["orders", orders],
      [
        "truncation",
        truncation(
          source.orders.length,
          orders.length,
          booleanValue(source.truncated, source.page_full) === true
        )
      ]
    ]),
    warnings
  );
}

function previewProject(data) {
  const source = asObject(data);
  if (!source || !asObject(source.quote)) {
    throw new UpstreamSchemaError(
      "DoorDash returned an invalid order-preview response."
    );
  }
  if (booleanValue(source.success) === false) {
    operationError(source, "Order preview failed.");
  }
  if (!Array.isArray(source.quote.store_order_cart?.orders)) {
    throw new UpstreamSchemaError(
      "DoorDash order preview did not contain its order items."
    );
  }
  assertObjectArray(
    source.quote.store_order_cart.orders,
    "order-preview orders"
  );
  for (const order of source.quote.store_order_cart.orders) {
    if (!Array.isArray(order.order_items)) {
      throw new UpstreamSchemaError(
        "DoorDash order preview did not contain an order-items array."
      );
    }
    assertObjectArray(order.order_items, "order-preview items");
  }
  const previewItemCount = source.quote.store_order_cart.orders.reduce(
    (total, order) => total + order.order_items.length,
    0
  );
  if (previewItemCount > 100) {
    throw new DoorDashOperationError(
      "DoorDash order preview contains more than 100 item lines. MCP submission is disabled for this cart; finish in browser checkout.",
      {
        code: "PREVIEW_TOO_LARGE",
        details: {
          cart_uuid: idValue(source.cart_uuid, source.quote.id)
        }
      }
    );
  }
  const order = normalizeOrder(source);
  const quote = source.quote;
  if (
    quote.tips_suggestion_details !== undefined &&
    quote.tips_suggestion_details !== null &&
    !Array.isArray(quote.tips_suggestion_details)
  ) {
    throw new UpstreamSchemaError(
      "DoorDash order preview contained malformed tip suggestions."
    );
  }
  const tipGroups = quote.tips_suggestion_details || [];
  assertObjectArray(tipGroups, "tip suggestions");
  const normalizedTipSuggestions = tipGroups.flatMap((group) => {
    if (
      group.percentage_to_amount_monetary_values !== undefined &&
      group.percentage_to_amount_monetary_values !== null &&
      !Array.isArray(group.percentage_to_amount_monetary_values)
    ) {
      throw new UpstreamSchemaError(
        "DoorDash tip suggestion contained malformed amounts."
      );
    }
    if (
      group.percentage_values !== undefined &&
      group.percentage_values !== null &&
      !Array.isArray(group.percentage_values)
    ) {
      throw new UpstreamSchemaError(
        "DoorDash tip suggestion contained malformed percentages."
      );
    }
    const amounts = group.percentage_to_amount_monetary_values || [];
    const percentages = group.percentage_values || [];
    assertObjectArray(amounts, "tip suggestion amounts");
    return amounts.map((amount, index) =>
      compactRecord([
        ["amount", money(amount)],
        ["percentage", numberValue(percentages[index])],
        ["recommended", index === group.default_index ? true : undefined],
        ["recipient", stringValue(group.tip_recipient)]
      ])
    );
  });
  const tipSuggestions = normalizedTipSuggestions.filter(
    (suggestion) => suggestion.amount !== undefined
  );
  const budgets =
    quote.expense_order_options?.all_eligible_expense_order_budgets;
  if (budgets !== undefined && budgets !== null && !Array.isArray(budgets)) {
    throw new UpstreamSchemaError(
      "DoorDash order preview contained malformed work budgets."
    );
  }
  if (Array.isArray(budgets)) {
    assertObjectArray(budgets, "work budgets");
  }
  const normalizedBudgets = Array.isArray(budgets)
    ? budgets.map((budget) =>
        compactRecord([
          ["budget_id", idValue(budget.id)],
          ["name", stringValue(budget.name)],
          ["remaining", money(budget.remaining_amount)],
          ["team_account_id", idValue(budget.team_account_id)],
          ["expense_code_mode", stringValue(budget.expense_code_mode)],
          [
            "expense_note_required",
            booleanValue(budget.is_expense_note_required) === true
              ? true
              : undefined
          ]
        ])
      )
    : [];
  const eligibleBudgets = normalizedBudgets.filter(
    (budget) => budget.budget_id && budget.name
  );
  const workTeamId = idValue(
    quote.company_payment_info?.team_order_info?.team_id
  );
  const workBenefits = nonEmptyRecord(
    compactRecord([
      ["team_id", workTeamId],
      [
        "eligible_budgets",
        eligibleBudgets.length ? eligibleBudgets : undefined
      ]
    ])
  );
  const previewOptions = asObject(source.mcp_preview_options) || {};
  const selectedBudgetId = idValue(previewOptions.budget_id);
  const selectedBudget = selectedBudgetId
    ? eligibleBudgets.find((budget) => budget.budget_id === selectedBudgetId)
    : undefined;
  const pinHandoffRequired = Boolean(
    Array.isArray(quote.dropoff_options) &&
      quote.dropoff_options.some(
        (option) =>
          stringValue(option?.proof_of_delivery_type)?.toUpperCase() ===
          "PIN_CODE"
      )
  );
  const fulfillment = order.fulfillment || previewOptions.fulfillment;
  const expectedDeliveryAddress =
    order.delivery_address?.address ??
    (fulfillment === "pickup" ? null : undefined);
  const submitContext = {
    ...compactRecord([
    ["cart_uuid", order.cart_uuid],
    ["preview_token", stringValue(source.mcp_preview_token)],
    ["expected_total_before_tip", order.pricing?.total_before_tip],
    [
      "scheduled_time",
      order.scheduled_time || stringValue(previewOptions.scheduled_time)
    ],
    ["fulfillment", fulfillment],
    ["priority", booleanValue(previewOptions.priority) === true],
    [
      "apply_credits",
      booleanValue(previewOptions.apply_credits) !== false
    ],
    [
      "pin_handoff_required",
      pinHandoffRequired ? true : false
    ],
    ["budget_id", workTeamId ? selectedBudget?.budget_id : undefined]
    ]),
    expected_delivery_address: expectedDeliveryAddress
  };
  for (const field of [
    "cart_uuid",
    "expected_total_before_tip",
    "expected_delivery_address",
    "fulfillment",
    "priority",
    "apply_credits",
    "pin_handoff_required"
  ]) {
    if (submitContext[field] === undefined) {
      throw new UpstreamSchemaError(
        `DoorDash order preview did not contain ${field} needed for safe submission.`
      );
    }
  }
  const warnings = warningList(source.warning);
  if (tipSuggestions.length !== normalizedTipSuggestions.length) {
    warnings.push("Tip suggestions without an amount were omitted.");
  }
  if (eligibleBudgets.length !== normalizedBudgets.length) {
    warnings.push("Work budgets without budget_id or name were omitted.");
  }
  if (eligibleBudgets.length && !workTeamId) {
    warnings.push(
      "DoorDash returned work budgets without team_id; those budgets cannot be used for submission."
    );
  }
  if (selectedBudgetId && !selectedBudget) {
    warnings.push(
      "The selected budget_id is no longer eligible. Choose a current budget and call preview_order again before submitting."
    );
  }
  return card(
    "order_preview",
    compactRecord([
      ...Object.entries(order),
      ["pricing_quote_id", idValue(quote.pricing_quote_id)],
      [
        "tip_suggestions",
        tipSuggestions.length ? tipSuggestions : undefined
      ],
      ["work_benefits", workBenefits],
      ["submit_context", submitContext]
    ]),
    warnings
  );
}

function receiptProject(data) {
  const source = asObject(data);
  if (!source) {
    throw new UpstreamSchemaError("DoorDash returned an invalid receipt.");
  }
  const receiptSource = asObject(source.receipt) || source;
  if (
    !Array.isArray(receiptSource.items) &&
    !Array.isArray(receiptSource.order_items) &&
    !Array.isArray(receiptSource.ordered_items)
  ) {
    throw new UpstreamSchemaError(
      "DoorDash receipt did not contain its ordered items."
    );
  }
  assertObjectArray(
    first(
      receiptSource.items,
      receiptSource.order_items,
      receiptSource.ordered_items
    ),
    "receipt items"
  );
  const order = normalizeOrder(source);
  if (!order.pricing) {
    throw new UpstreamSchemaError(
      "DoorDash receipt did not contain pricing."
    );
  }
  const warnings = warningList(source.warning);
  if (order.items_truncation?.omitted) {
    warnings.push(
      `${order.items_truncation.omitted} receipt item lines were omitted from the MCP response. Use DoorDash checkout history for the complete receipt.`
    );
  }
  return card(
    "receipt",
    order,
    warnings
  );
}

function reorderProject(data) {
  const source = asObject(data);
  if (!source) {
    throw new UpstreamSchemaError(
      "DoorDash returned an invalid reorder response."
    );
  }
  if (booleanValue(source.success) === false) {
    operationError(source, "Reorder failed.");
  }
  const cartData = normalizeCart(source);
  if (!cartData.cart_uuid) {
    throw new UpstreamSchemaError(
      "DoorDash reorder response did not contain the new cart_uuid. The outcome is unknown."
    );
  }
  return card("reorder", cartData);
}

function orderStatusProject(data) {
  const source = asObject(data);
  if (!source) {
    throw new UpstreamSchemaError(
      "DoorDash returned an invalid order-status response."
    );
  }
  const statusSource = asObject(source.result)
    ? { ...source, ...source.result }
    : source;
  const order = normalizeOrder(statusSource);
  if (!order.status) {
    throw new UpstreamSchemaError(
      "DoorDash order-status response did not contain a status."
    );
  }
  return card(
    "order_status",
    order,
    warningList(source.warning, source.error_message)
  );
}

function submitAcceptedProject(data) {
  const source = asObject(data);
  if (!source) {
    throw new UpstreamSchemaError(
      "DoorDash returned an invalid order-submission response."
    );
  }
  if (booleanValue(source.success) === false) {
    operationError(source, "Order submission failed.");
  }
  const order = normalizeOrder(source);
  const warnings = order.order_uuid
    ? []
    : ["The accepted submission is missing its order UUID."];
  return card("order_submit", order, warnings);
}

function submittedOrderProject(data) {
  const source = asObject(data);
  if (!source) {
    throw new UpstreamSchemaError(
      "DoorDash returned an invalid submitted-order response."
    );
  }
  const rawFinalStatus = asObject(source.finalStatus) || {};
  const finalStatus = asObject(rawFinalStatus.result)
    ? { ...rawFinalStatus, ...rawFinalStatus.result }
    : rawFinalStatus;
  const order = normalizeOrder(
    { ...source.submitted, ...finalStatus },
    {
      preview: source.preview,
      preferPreview: true,
      submitted: source.submitted,
      finalStatus,
      orderUuid: source.orderUuid,
      status: source.terminalStatus,
      tipCents: source.tipCents,
      payment: source.payment
    }
  );
  return card(
    "order_submit",
    order,
    warningList(source.warning)
  );
}

function addressesProject(data) {
  const source = asObject(data);
  if (!source || !Array.isArray(source.addresses)) {
    throw new UpstreamSchemaError(
      "DoorDash returned an invalid address-list response."
    );
  }
  assertObjectArray(source.addresses, "address-list response");
  const normalizedAddresses = source.addresses.map((address) =>
    compactRecord([
      ["address_id", idValue(address.address_id, address.id)],
      ["label", stringValue(address.label, address.name)],
      ...Object.entries(
        normalizeLocation(address, {
          includeCoordinatesWithAddress: true
        }) || {}
      ),
      ["is_default", booleanValue(address.is_default)]
    ])
  );
  const addresses = normalizedAddresses.filter((address) => address.address_id);
  const warnings = warningList(source.warning);
  if (addresses.length !== normalizedAddresses.length) {
    warnings.push("Saved addresses without address_id were omitted.");
  }
  return card("address_list", { addresses }, warnings);
}

function paymentMethodsProject(data) {
  const source = asObject(data);
  if (!source || !Array.isArray(source.cards)) {
    throw new UpstreamSchemaError(
      "DoorDash returned an invalid payment-method response."
    );
  }
  assertObjectArray(source.cards, "payment-method response");
  const defaultId = idValue(source.default_payment_method_id);
  const normalizedCards = source.cards.map((card) =>
    compactRecord([
      ["brand", stringValue(card.brand)],
      ["last4", stringValue(card.last4)],
      ["exp_month", numberValue(card.exp_month)],
      ["exp_year", numberValue(card.exp_year)],
      [
        "is_default",
        defaultId
          ? idValue(card.payment_method_id) === defaultId
          : booleanValue(card.is_default)
      ]
    ])
  );
  const cards = normalizedCards.filter((card) => card.brand && card.last4);
  const warnings = warningList(source.warning);
  if (cards.length !== normalizedCards.length) {
    warnings.push("Cards without brand or last4 were omitted.");
  }
  if (cards.length && !cards.some((card) => card.is_default === true)) {
    warnings.push(
      "DoorDash did not identify a default card. Do not guess which card will be charged."
    );
  }
  return card("payment_methods", { cards }, warnings);
}

function promosProject(data) {
  const source = asObject(data);
  const rawPromos = first(source?.promos, source?.promotions);
  if (!source || !Array.isArray(rawPromos)) {
    throw new UpstreamSchemaError(
      "DoorDash returned an invalid promotions response."
    );
  }
  assertObjectArray(rawPromos, "promotions response");
  const normalizedPromotions = rawPromos.map((promo) =>
    compactRecord([
      ["promo_code", stringValue(promo.promo_code, promo.code)],
      ["store_id", idValue(promo.store_id, source.store_id)],
      ["title", stringValue(promo.title, promo.name)],
      ["description", stringValue(promo.description, promo.subtitle)],
      ["campaign_id", idValue(promo.campaign_id)],
      ["ad_group_id", idValue(promo.ad_group_id)],
      ["ad_id", idValue(promo.ad_id)],
      ["discount", money(first(promo.discount, promo.discount_amount))]
    ])
  );
  const promotions = normalizedPromotions.filter(
    (promotion) => promotion.promo_code
  );
  const warnings = warningList(source.warning);
  if (promotions.length !== normalizedPromotions.length) {
    warnings.push("Promotions without promo_code were omitted.");
  }
  return card("promotion_list", { promotions }, warnings);
}

function activityProject(data) {
  const source = asObject(data);
  if (!source || !Array.isArray(source.entries)) {
    throw new UpstreamSchemaError("DoorDash returned invalid activity data.");
  }
  return card("activity", { entries: source.entries });
}

function rawCliProject(data) {
  return card("raw_cli", { result: data ?? null });
}

const categorySchema = z.object({
  category_id: optionalString,
  name: optionalString,
  item_ids: z.array(z.string())
});

const failedLineSchema = z.object({
  item_id: optionalString,
  name: optionalString,
  quantity: optionalNumber,
  selected_options: z.array(selectedOptionSchema).optional()
});

const itemErrorSchema = z.object({
  request_index: z.number().int().nonnegative().optional(),
  item: failedLineSchema,
  message: optionalString,
  modifier_groups: z.array(modifierGroupSchema).optional(),
  ambiguous: z.literal(true).optional(),
  candidates: z
    .array(
      z.object({
        request_index: z.number().int().nonnegative(),
        item: failedLineSchema
      })
    )
    .optional()
});

const addressSchema = z.object({
  address_id: z.string(),
  label: optionalString,
  address: optionalString,
  latitude: optionalNumber,
  longitude: optionalNumber,
  is_default: optionalBoolean
});

const cardPaymentSchema = z.object({
  brand: z.string(),
  last4: z.string(),
  exp_month: optionalNumber,
  exp_year: optionalNumber,
  is_default: optionalBoolean
});

const promotionSchema = z.object({
  promo_code: z.string(),
  store_id: optionalString,
  title: optionalString,
  description: optionalString,
  campaign_id: optionalString,
  ad_group_id: optionalString,
  ad_id: optionalString,
  discount: moneySchema.optional()
});

const tipSuggestionSchema = z.object({
  amount: moneySchema,
  percentage: optionalNumber,
  recommended: z.literal(true).optional(),
  recipient: optionalString
});

const workBenefitsSchema = z.object({
  team_id: optionalString,
  eligible_budgets: z
    .array(
      z.object({
        budget_id: z.string(),
        name: z.string(),
        remaining: moneySchema.optional(),
        team_account_id: optionalString,
        expense_code_mode: optionalString,
        expense_note_required: z.literal(true).optional()
      })
    )
    .optional()
});

const submitContextSchema = z.object({
  cart_uuid: z.string(),
  preview_token: z.string(),
  expected_total_before_tip: moneySchema,
  expected_delivery_address: z.string().nullable(),
  scheduled_time: optionalString,
  fulfillment: z.enum(["delivery", "pickup"]),
  priority: z.boolean(),
  apply_credits: z.boolean(),
  pin_handoff_required: z.boolean(),
  budget_id: optionalString
});

const schemaByKind = {
  address_list: cardSchema("address_list", {
    addresses: z.array(addressSchema)
  }),
  address_update: cardSchema("address_update", {
    address_id: z.string(),
    message: optionalString
  }),
  grocery_list: cardSchema("grocery_list", {
    store: storeSchema.optional(),
    menu_id: optionalString,
    items: z.array(itemSchema),
    available_stores: z.array(storeSchema).optional(),
    delivery_address: locationSchema.optional(),
    items_truncation: truncationSchema.optional(),
    available_stores_truncation: truncationSchema.optional()
  }),
  item_search: cardSchema("item_search", {
    store: storeSchema.optional(),
    results: z.array(
      z.object({
        query: optionalString,
        items: z.array(itemSchema),
        truncation: truncationSchema.optional()
      })
    )
  }),
  store_search: cardSchema("store_search", {
    stores: z.array(storeSchema),
    truncation: truncationSchema.optional()
  }),
  item_details: cardSchema("item_details", {
    store: storeSchema.optional(),
    menu_id: optionalString,
    item: itemSchema
  }),
  menu: cardSchema("menu", {
    store: storeSchema.optional(),
    menu_id: z.string(),
    items: z.array(itemSchema),
    categories: z.array(categorySchema).optional(),
    truncation: truncationSchema.optional()
  }),
  store_details: cardSchema("store_details", {
    store: storeSchema
  }),
  cart: cardSchema("cart", {
    ...cartFields,
    item_errors: z.array(itemErrorSchema).optional()
  }),
  cart_list: cardSchema("cart_list", {
    carts: z.array(cartSchema),
    truncation: truncationSchema.optional()
  }),
  cart_mutation: cardSchema("cart_mutation", {
    cart_uuid: z.string(),
    message: optionalString
  }),
  checkout_link: cardSchema("checkout_link", {
    cart_uuid: optionalString,
    checkout_url: z.string()
  }),
  order_list: cardSchema("order_list", {
    orders: z.array(
      z.object({
        ...orderFields,
        order_uuid: z.string()
      })
    ),
    truncation: truncationSchema.optional()
  }),
  order_preview: cardSchema("order_preview", {
    ...orderFields,
    items: z.array(itemSchema),
    pricing_quote_id: optionalString,
    tip_suggestions: z.array(tipSuggestionSchema).optional(),
    work_benefits: workBenefitsSchema.optional(),
    submit_context: submitContextSchema
  }),
  receipt: cardSchema("receipt", {
    ...orderFields,
    items: z.array(itemSchema),
    pricing: pricingSchema
  }),
  reorder: cardSchema("reorder", {
    ...cartFields,
    cart_uuid: z.string()
  }),
  order_status: cardSchema("order_status", orderFields),
  promotion_list: cardSchema("promotion_list", {
    promotions: z.array(promotionSchema)
  }),
  promotion_mutation: cardSchema("promotion_mutation", {
    cart_uuid: z.string(),
    promo_code: z.string(),
    message: optionalString
  }),
  payment_methods: cardSchema("payment_methods", {
    cards: z.array(cardPaymentSchema)
  }),
  order_submit: cardSchema("order_submit", {
    ...orderFields,
    items: z.array(itemSchema)
  }),
  activity: cardSchema("activity", {
    entries: z.array(jsonValueSchema)
  }),
  raw_cli: cardSchema("raw_cli", {
    result: jsonValueSchema
  })
};

function defineContract(kind, project, outputSchema = schemaByKind[kind]) {
  return {
    kind,
    outputSchema: z.union([errorCardSchema(kind), outputSchema]),
    successSchema: outputSchema,
    project
  };
}

const publicSelectedOptionSchema = z.looseObject({
  option_id: optionalString,
  option_name: optionalString,
  quantity: optionalNumber
});

const publicModifierOptionSchema = z.lazy(() =>
  z.looseObject({
    option_id: z.string(),
    name: optionalString,
    available: optionalBoolean,
    modifier_groups: z.array(publicModifierGroupSchema).optional()
  })
);

const publicModifierGroupSchema = z.lazy(() =>
  z.looseObject({
    group_id: optionalString,
    name: optionalString,
    min_selections: optionalNumber,
    max_selections: optionalNumber,
    options: z.array(publicModifierOptionSchema).optional()
  })
);

const publicActionableItemSchema = z.looseObject({
  item_id: z.string(),
  name: z.string()
});

const publicDetailedItemSchema = z.looseObject({
  item_id: z.string(),
  name: z.string(),
  modifier_groups: z.array(publicModifierGroupSchema).optional()
});

const publicCartItemSchema = z.looseObject({
  item_id: optionalString,
  cart_item_id: optionalString,
  name: optionalString,
  quantity: optionalNumber,
  selected_options: z.array(publicSelectedOptionSchema).optional()
});

const publicFailedLineSchema = z.looseObject({
  item_id: optionalString,
  name: optionalString,
  quantity: optionalNumber,
  selected_options: z.array(publicSelectedOptionSchema).optional()
});

const publicItemErrorSchema = z.looseObject({
  request_index: z.number().int().nonnegative().optional(),
  item: publicFailedLineSchema,
  message: optionalString,
  modifier_groups: z.array(publicModifierGroupSchema).optional(),
  ambiguous: z.literal(true).optional(),
  candidates: z
    .array(
      z.looseObject({
        request_index: z.number().int().nonnegative(),
        item: publicFailedLineSchema
      })
    )
    .optional()
});

const publicStoreReferenceSchema = z.looseObject({
  store_id: z.string(),
  name: optionalString
});

const publicOrderReferenceSchema = z.looseObject({
  order_uuid: z.string(),
  status: optionalString
});

const publicAddressSchema = z.looseObject({
  address_id: z.string(),
  label: optionalString,
  address: optionalString,
  is_default: optionalBoolean
});

const publicPaymentCardSchema = z.looseObject({
  brand: z.string(),
  last4: z.string(),
  is_default: optionalBoolean
});

const publicPromotionSchema = z.looseObject({
  promo_code: z.string(),
  campaign_id: optionalString,
  ad_group_id: optionalString,
  ad_id: optionalString
});

const publicPricingSchema = z.looseObject({
  total_before_tip: optionalNumber,
  tip: optionalNumber,
  total: optionalNumber
});

const publicWorkBenefitsSchema = z.looseObject({
  team_id: optionalString,
  eligible_budgets: z
    .array(
      z.looseObject({
        budget_id: z.string(),
        name: z.string(),
        remaining: optionalNumber,
        team_account_id: optionalString,
        expense_code_mode: optionalString,
        expense_note_required: z.literal(true).optional()
      })
    )
    .optional()
});

const publicErrorSchema = z.looseObject({
  error: z.looseObject({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    recovery_tool: optionalString,
    recovery_arguments: z.looseObject({}).optional()
  })
});

function publicSuccessFields(kind) {
  switch (kind) {
    case "address_list":
      return { addresses: z.array(publicAddressSchema) };
    case "address_update":
      return { address_id: z.string() };
    case "grocery_list":
      return {
        store: publicStoreReferenceSchema.optional(),
        available_stores: z.array(publicStoreReferenceSchema).optional(),
        menu_id: optionalString,
        items: z.array(publicActionableItemSchema),
        items_truncation: truncationSchema.optional()
      };
    case "item_search":
      return {
        results: z.array(
          z.looseObject({
            query: optionalString,
            items: z.array(publicActionableItemSchema),
            truncation: truncationSchema.optional()
          })
        )
      };
    case "store_search":
      return {
        stores: z.array(publicStoreReferenceSchema),
        truncation: truncationSchema.optional()
      };
    case "store_details":
      return { store: publicStoreReferenceSchema };
    case "menu":
      return {
        menu_id: z.string(),
        items: z.array(publicActionableItemSchema),
        truncation: truncationSchema.optional()
      };
    case "item_details":
      return {
        store: publicStoreReferenceSchema.optional(),
        menu_id: optionalString,
        item: publicDetailedItemSchema
      };
    case "cart":
      return {
        cart_uuid: optionalString,
        items: z.array(publicCartItemSchema),
        items_truncation: truncationSchema.optional(),
        fulfillment: z.enum(["delivery", "pickup"]).optional(),
        checkout_url: optionalString,
        item_errors: z.array(publicItemErrorSchema).optional(),
        warnings: z.array(z.string()).optional()
      };
    case "cart_list":
      return {
        carts: z.array(
          z.looseObject({
            cart_uuid: z.string(),
            items: z.array(publicCartItemSchema),
            items_truncation: truncationSchema.optional(),
            fulfillment: z.enum(["delivery", "pickup"]).optional()
          })
        ),
        truncation: truncationSchema.optional(),
        warnings: z.array(z.string()).optional()
      };
    case "cart_mutation":
      return { cart_uuid: z.string() };
    case "checkout_link":
      return {
        cart_uuid: optionalString,
        checkout_url: z.string()
      };
    case "order_list":
      return {
        orders: z.array(publicOrderReferenceSchema),
        truncation: truncationSchema.optional()
      };
    case "order_preview":
      return {
        items: z.array(publicCartItemSchema),
        pricing: publicPricingSchema.optional(),
        tip_suggestions: z
          .array(
            z.looseObject({
              amount: z.number(),
              recommended: z.literal(true).optional()
            })
          )
          .optional(),
        work_benefits: publicWorkBenefitsSchema.optional(),
        submit_context: submitContextSchema
      };
    case "receipt":
      return {
        order_uuid: optionalString,
        items: z.array(publicCartItemSchema),
        items_truncation: truncationSchema.optional(),
        pricing: publicPricingSchema
      };
    case "reorder":
      return {
        cart_uuid: z.string(),
        items: z.array(publicCartItemSchema),
        items_truncation: truncationSchema.optional(),
        fulfillment: z.enum(["delivery", "pickup"]).optional()
      };
    case "order_status":
      return {
        order_uuid: optionalString,
        status: z.string()
      };
    case "promotion_list":
      return { promotions: z.array(publicPromotionSchema) };
    case "promotion_mutation":
      return {
        cart_uuid: z.string(),
        promo_code: z.string()
      };
    case "payment_methods":
      return { cards: z.array(publicPaymentCardSchema) };
    case "order_submit":
      return {
        order_uuid: z.string(),
        status: optionalString,
        items: z.array(publicCartItemSchema),
        pricing: publicPricingSchema.optional()
      };
    default:
      return {};
  }
}

function publicOutputSchema(kind) {
  return z.union([
    publicErrorSchema,
    z.looseObject(publicSuccessFields(kind))
  ]);
}

export const contracts = {
  addresses: defineContract("address_list", addressesProject),
  addressUpdate: defineContract(
    "address_update",
    actionProject("address_update", "Default-address update")
  ),
  groceryList: defineContract("grocery_list", groceryProject),
  itemSearch: defineContract("item_search", itemSearchProject),
  storeSearch: defineContract("store_search", storeSearchProject),
  itemDetails: defineContract("item_details", itemDetailsProject),
  menu: defineContract("menu", menuProject),
  storeDetails: defineContract("store_details", storeDetailsProject),
  cart: defineContract("cart", cartProject),
  cartList: defineContract("cart_list", cartListProject),
  cartMutation: defineContract(
    "cart_mutation",
    actionProject("cart_mutation", "Cart update")
  ),
  checkoutLink: defineContract("checkout_link", checkoutProject),
  orderList: defineContract("order_list", orderListProject),
  orderPreview: defineContract("order_preview", previewProject),
  receipt: defineContract("receipt", receiptProject),
  reorder: defineContract("reorder", reorderProject),
  orderStatus: defineContract("order_status", orderStatusProject),
  promotionList: defineContract("promotion_list", promosProject),
  promotionMutation: defineContract(
    "promotion_mutation",
    actionProject("promotion_mutation", "Promotion update")
  ),
  paymentMethods: defineContract("payment_methods", paymentMethodsProject),
  orderSubmit: defineContract("order_submit", submittedOrderProject),
  orderSubmitAccepted: defineContract(
    "order_submit",
    submitAcceptedProject,
    cardSchema("order_submit", orderFields)
  ),
  activity: defineContract("activity", activityProject),
  rawCli: defineContract("raw_cli", rawCliProject)
};

const toolContracts = {
  list_addresses: contracts.addresses,
  set_default_address: contracts.addressUpdate,
  build_grocery_list: contracts.groceryList,
  find_items: contracts.itemSearch,
  find_nearby_stores: contracts.storeSearch,
  get_item_details: contracts.itemDetails,
  get_menu: contracts.menu,
  get_restaurant_item_details: contracts.itemDetails,
  search_restaurants: contracts.storeSearch,
  get_store_details: contracts.storeDetails,
  add_cart_items: contracts.cart,
  delete_cart: contracts.cartMutation,
  list_carts: contracts.cartList,
  remove_cart_item: contracts.cartMutation,
  show_cart: contracts.cart,
  create_checkout_link: contracts.checkoutLink,
  list_orders: contracts.orderList,
  preview_order: contracts.orderPreview,
  get_receipt: contracts.receipt,
  reorder: contracts.reorder,
  order_status: contracts.orderStatus,
  list_promos: contracts.promotionList,
  apply_promo: contracts.promotionMutation,
  remove_promo: contracts.promotionMutation,
  list_payment_methods: contracts.paymentMethods,
  order_submit: contracts.orderSubmit,
  activity: contracts.activity,
  run: contracts.rawCli
};

const commandContracts = new Map([
  ["address list", contracts.addresses],
  ["address set", contracts.addressUpdate],
  ["build-grocery-list", contracts.groceryList],
  ["find-items", contracts.itemSearch],
  ["find-nearby-stores", contracts.storeSearch],
  ["item-details", contracts.itemDetails],
  ["menu", contracts.menu],
  ["restaurant-item-details", contracts.itemDetails],
  ["search", contracts.storeSearch],
  ["store-details", contracts.storeDetails],
  ["cart add-items", contracts.cart],
  ["cart delete", contracts.cartMutation],
  ["cart list", contracts.cartList],
  ["cart remove-item", contracts.cartMutation],
  ["cart show", contracts.cart],
  ["order checkout-url", contracts.checkoutLink],
  ["order history", contracts.orderList],
  ["order preview", contracts.orderPreview],
  ["order receipt", contracts.receipt],
  ["order reorder", contracts.reorder],
  ["order status", contracts.orderStatus],
  ["promo list", contracts.promotionList],
  ["promo apply", contracts.promotionMutation],
  ["promo remove", contracts.promotionMutation],
  ["payment-method list", contracts.paymentMethods],
  ["order submit", contracts.orderSubmitAccepted]
]);

export function contractForTool(name) {
  return toolContracts[name] || contracts.rawCli;
}

export function publicOutputSchemaForTool(name) {
  return publicOutputSchema(contractForTool(name).kind);
}

export function contractForCommand(args) {
  const command = args.slice(0, 2).join(" ");
  return (
    commandContracts.get(command) ||
    commandContracts.get(args[0]) ||
    contracts.rawCli
  );
}

export function validateResponse(contract, value) {
  const result = contract.outputSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path?.length
      ? ` at ${issue.path.join(".")}`
      : "";
    throw new UpstreamSchemaError(
      `DoorDash ${contract.kind} projection violated its response schema${path}.`
    );
  }
  return result.data;
}

function errorCode(error) {
  return (
    stringValue(
      error?.code,
      error?.details?.data?.error?.code,
      error?.details?.data?.error_reason,
      error?.details?.data?.code,
      error?.details?.data?.structuredContent?.error?.code,
      error?.details?.data?.structuredContent?.error_reason,
      error?.details?.data?.structuredContent?.code,
      error?.details?.error_reason,
      error?.details?.code
    ) || "DOORDASH_CLI_ERROR"
  );
}

function detailValue(error, ...names) {
  for (const name of names) {
    const value =
      error?.details?.[name] ??
      error?.details?.data?.[name] ??
      error?.details?.data?.error?.[name] ??
      error?.details?.data?.structuredContent?.[name] ??
      error?.details?.data?.structuredContent?.error?.[name];
    if (value !== undefined && value !== null && value !== "") {
      return String(value);
    }
  }
  return undefined;
}

function detailObject(error, ...names) {
  for (const name of names) {
    const value =
      error?.details?.[name] ??
      error?.details?.data?.[name] ??
      error?.details?.data?.error?.[name] ??
      error?.details?.data?.structuredContent?.[name] ??
      error?.details?.data?.structuredContent?.error?.[name];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value).filter(([, entry]) =>
          ["string", "number", "boolean"].includes(typeof entry)
        )
      );
    }
  }
  return undefined;
}

function recoveryFor(error, code) {
  const cartUuid = detailValue(error, "cart_uuid", "cartUuid");
  const orderUuid = detailValue(error, "order_uuid", "orderUuid");
  const storeId = detailValue(error, "store_id", "storeId");
  const stateScope = detailValue(error, "state_scope", "stateScope");
  const previewArguments = detailObject(
    error,
    "preview_arguments",
    "previewArguments"
  );
  switch (code) {
    case "CHECKOUT_STATE_CHANGE_IN_PROGRESS":
      if (stateScope === "address") {
        return { tool: "list_addresses", arguments: {} };
      }
      return cartUuid
        ? { tool: "show_cart", arguments: { cart_uuid: cartUuid } }
        : { tool: "list_carts", arguments: {} };
    case "ADDRESS_MUTATION_OUTCOME_UNKNOWN":
      return { tool: "list_addresses", arguments: {} };
    case "CART_MUTATION_OUTCOME_UNKNOWN":
      return cartUuid
        ? { tool: "show_cart", arguments: { cart_uuid: cartUuid } }
        : { tool: "list_carts", arguments: {} };
    case "REORDER_OUTCOME_UNKNOWN":
      return { tool: "list_carts", arguments: {} };
    case "PROMO_MUTATION_OUTCOME_UNKNOWN":
      return cartUuid
        ? {
            tool: "create_checkout_link",
            arguments: { cart_uuid: cartUuid }
          }
        : undefined;
    case "PREVIEW_OUTCOME_UNKNOWN":
      return cartUuid
        ? { tool: "show_cart", arguments: { cart_uuid: cartUuid } }
        : undefined;
    case "PREVIEW_TOO_LARGE":
      return cartUuid
        ? {
            tool: "create_checkout_link",
            arguments: { cart_uuid: cartUuid }
          }
        : undefined;
    case "ACTIVE_CART_EXISTS":
      return cartUuid
        ? { tool: "show_cart", arguments: { cart_uuid: cartUuid } }
        : undefined;
    case "CART_WRITE_IN_PROGRESS":
      return {
        tool: "list_carts",
        arguments: storeId ? { store_id: storeId } : {}
      };
    case "CART_WRITE_OUTCOME_UNKNOWN":
      return cartUuid
        ? { tool: "show_cart", arguments: { cart_uuid: cartUuid } }
        : {
            tool: "list_carts",
            arguments: storeId ? { store_id: storeId } : {}
          };
    case "SUBMISSION_ALREADY_ATTEMPTED":
      return orderUuid
        ? { tool: "order_status", arguments: { order_uuid: orderUuid } }
        : { tool: "list_orders", arguments: {} };
    case "SUBMISSION_OUTCOME_UNKNOWN":
      return { tool: "list_orders", arguments: {} };
    case "SUBMISSION_REJECTED":
      return cartUuid
        ? {
            tool: "create_checkout_link",
            arguments: { cart_uuid: cartUuid }
          }
        : undefined;
    case "ORDER_PREVIEW_CHANGED":
    case "WORK_BUDGET_CHANGED":
      return previewArguments
        ? { tool: "preview_order", arguments: previewArguments }
        : undefined;
    case "PAYMENT_METHOD_CHANGED":
      return { tool: "list_payment_methods", arguments: {} };
    case "DEFAULT_ADDRESS_MISSING":
    case "DEFAULT_ADDRESS_COORDINATES_MISSING":
      return { tool: "list_addresses", arguments: {} };
    case "AGENTIC_RESTRICTED_ITEM_NOT_ALLOWED":
      return cartUuid
        ? {
            tool: "create_checkout_link",
            arguments: { cart_uuid: cartUuid }
          }
        : undefined;
    default:
      return undefined;
  }
}

export function errorEnvelope(contract, error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  const recovery = recoveryFor(error, code);
  const payload = {
    schema: RESPONSE_SCHEMA,
    version: RESPONSE_SCHEMA_VERSION,
    kind: contract.kind,
    error: compactRecord([
      ["code", code],
      ["message", message],
      ["retryable", false],
      ["recovery_tool", recovery?.tool],
      ["recovery_arguments", recovery?.arguments]
    ])
  };
  return errorCardSchema(contract.kind).parse(payload);
}

export function projectWithContract(contract, data) {
  return validateResponse(contract, contract.project(data));
}

function dollarText(value) {
  return value === undefined ? undefined : `$${value.toFixed(2)}`;
}

function countItems(results) {
  return Array.isArray(results)
    ? results.reduce(
        (sum, result) => sum + (Array.isArray(result.items) ? result.items.length : 0),
        0
      )
    : 0;
}

function plural(count, singular, pluralValue = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function summarizeModifierChoices(groups = []) {
  return groups
    .map((group) => {
      const groupName = group.name || group.group_id || "Modifier";
      const minimum =
        group.min_selections ?? (group.required === true ? 1 : 0);
      const maximum = group.max_selections;
      const rule =
        minimum === 0
          ? `optional; ${maximum ? `choose up to ${maximum}` : "omit for none"}`
          : maximum === minimum
            ? `required; choose exactly ${minimum}`
            : `required; choose ${minimum}${maximum ? `-${maximum}` : "+"}`;
      const options = (group.options || [])
        .filter((option) => option.available !== false)
        .map((option) => {
          const name = option.name || option.option_id || "Unnamed option";
          const label = option.option_id
            ? `${name} [${option.option_id}]`
            : name;
          const nested = summarizeModifierChoices(option.modifier_groups);
          return nested ? `${label} -> ${nested}` : label;
        });
      return options.length
        ? `${groupName} (${rule}): ${options.join(", ")}`
        : `${groupName} (${rule})`;
    })
    .join("; ");
}

function summarizeSelectedOptions(options = []) {
  return options
    .map((option) => {
      const optionName =
        option.option_name || option.option_id || "unnamed option";
      const label = option.group_name
        ? `${option.group_name}: ${optionName}`
        : optionName;
      const nested = summarizeSelectedOptions(option.options);
      return nested ? `${label} -> ${nested}` : label;
    })
    .join(", ");
}

function summarizeCartErrors(value) {
  const itemErrors = value.item_errors;
  const issues = itemErrors.map((itemError, index) => {
    const item = itemError.item || {};
    const itemName =
      item.name || item.item_id || `cart item ${index + 1}`;
    const requestLabel =
      itemError.request_index === undefined
        ? itemName
        : `request line ${itemError.request_index + 1} (${itemName})`;
    const selected = summarizeSelectedOptions(item.selected_options);
    const variant = selected ? ` [${selected}]` : "";
    const message = (
      itemError.message || "This item needs attention."
    )
      .replace(/\s*No cart changes were made\./gi, "")
      .trim();
    const choices = summarizeModifierChoices(itemError.modifier_groups);
    const candidates = itemError.candidates?.length
      ? ` DoorDash did not identify the exact failed variant. Candidates: ${itemError.candidates
          .map((candidate) => {
            const candidateOptions = summarizeSelectedOptions(
              candidate.item?.selected_options
            );
            return `request line ${candidate.request_index + 1}${
              candidateOptions ? ` [${candidateOptions}]` : ""
            }`;
          })
          .join(" or ")}.`
      : "";
    return `${index + 1}) ${requestLabel}${variant}: ${message}${choices ? ` Available choices: ${choices}.` : ""}${candidates}`;
  });
  const addedLineCount = value.added_line_count ?? value.items.length;
  const partial = addedLineCount > 0;
  const ambiguous = itemErrors.some((itemError) => itemError.ambiguous);
  const blocked = itemErrors.some((itemError) =>
    /do not retry this item/i.test(itemError.message || "")
  );
  const prefix = ambiguous
    ? `DoorDash did not identify which requested variant failed. Never resend the full batch. ${
        value.cart_uuid
          ? `First call show_cart with {"cart_uuid":"${value.cart_uuid}"}.`
          : "First call list_carts."
      } Compare the candidate request lines with the cart; add only a confirmed missing variant.`
    : blocked
      ? "No cart changes were made. At least one item cannot be added safely through MCP. Choose a different item or use DoorDash checkout; do not retry unchanged."
    : partial
      ? `Partial cart update: ${plural(addedLineCount, "cart line")} added and ${plural(itemErrors.length, "line")} failed. Never resend an added line or the full original batch. ${
          value.cart_uuid
            ? `First call show_cart with {"cart_uuid":"${value.cart_uuid}"}. Then add only the failed lines using that same cart_uuid.`
            : "Inspect list_carts before making another cart change."
        }`
      : `No cart changes were made. Fix all ${plural(itemErrors.length, "item issue")} before retrying add_cart_items once; never repeat unchanged input. Use only choices the user already requested; otherwise ask. Do not guess.`;
  const summary = `${prefix} ${issues.join(" ")}`;
  return summary.length > 6_000
    ? `${summary.slice(0, 5_900)} … Full modifier data is in the JSON result.`
    : summary;
}

export function summarizeResponse(value) {
  if (value.error) {
    const next = value.error.recovery_tool
      ? ` Next: call ${value.error.recovery_tool} once with ${JSON.stringify(value.error.recovery_arguments || {})}.`
      : "";
    return `${value.error.code}: ${value.error.message} Do not retry the unchanged call.${next}`;
  }

  switch (value.kind) {
    case "store_search":
      return `Found ${plural(value.stores.length, "DoorDash store")}.`;
    case "store_details":
      return value.store.name
        ? `Store details for ${value.store.name}.`
        : "DoorDash store details.";
    case "menu":
      return `Loaded ${plural(value.items.length, "menu item")}${value.store?.name ? ` from ${value.store.name}` : ""}.`;
    case "item_details":
      return value.item.name
        ? `Item details for ${value.item.name}.`
        : "DoorDash item details.";
    case "item_search":
      return `Found ${plural(countItems(value.results), "matching item")}.`;
    case "grocery_list":
      return `Resolved ${plural(value.items.length, "grocery item")}${value.store?.name ? ` at ${value.store.name}` : ""}.`;
    case "cart": {
      const errors = value.item_errors?.length || 0;
      if (errors) {
        return summarizeCartErrors(value);
      }
      return `${plural(value.items.length, "cart line")}${value.store?.name ? ` at ${value.store.name}` : ""}${errors ? `; ${plural(errors, "item")} still need${errors === 1 ? "s" : ""} attention` : ""}${value.checkout_url ? `. Checkout: ${value.checkout_url}` : "."}`;
    }
    case "cart_list":
      return `${plural(value.carts.length, "active DoorDash cart")}.`;
    case "address_update":
      return value.message || "Default DoorDash address updated.";
    case "cart_mutation":
      return value.message || "DoorDash cart updated.";
    case "promotion_mutation":
      return value.message || "DoorDash promotion updated.";
    case "checkout_link":
      return `DoorDash checkout: ${value.checkout_url}`;
    case "order_list":
      return `${plural(value.orders.length, "DoorDash order")} in history.`;
    case "order_preview": {
      const total = dollarText(value.pricing?.total_before_tip);
      return `DoorDash order preview${value.store?.name ? ` from ${value.store.name}` : ""}: ${plural(value.items.length, "item")}${total ? `, ${total} before tip` : ""}${value.delivery_time ? `, ${value.delivery_time}` : ""}.`;
    }
    case "receipt": {
      const total = dollarText(value.pricing?.total);
      return `DoorDash receipt${value.store?.name ? ` from ${value.store.name}` : ""}${total ? `: ${total}` : ""}.`;
    }
    case "reorder":
      return `Reordered into DoorDash cart${value.cart_uuid ? ` ${value.cart_uuid}` : ""}.`;
    case "order_status":
      return `DoorDash order${value.order_uuid ? ` ${value.order_uuid}` : ""}: ${value.status}${
        value.tracking_url
          ? `. Track: ${value.tracking_url}`
          : value.checkout_url
            ? `. Continue: ${value.checkout_url}`
            : "."
      }`;
    case "order_submit": {
      const total = dollarText(value.pricing?.total);
      const link = value.tracking_url || value.checkout_url;
      const linkLabel = value.tracking_url ? "Track" : "Continue";
      return `DoorDash order${value.store?.name ? ` from ${value.store.name}` : ""}: ${value.status || "submitted"}${total ? `, ${total}` : ""}${value.delivery_time ? `, ${value.delivery_time}` : ""}${link ? `. ${linkLabel}: ${link}` : "."}`;
    }
    case "address_list":
      return `${plural(value.addresses.length, "saved DoorDash address", "saved DoorDash addresses")}.`;
    case "payment_methods":
      return `${plural(value.cards.length, "masked DoorDash card")}.`;
    case "promotion_list":
      return `${plural(value.promotions.length, "eligible DoorDash promotion")}.`;
    case "activity":
      return `${plural(value.entries.length, "recent DoorDash MCP activity", "recent DoorDash MCP activities")}.`;
    case "raw_cli":
      return "DoorDash CLI command completed.";
    default:
      return "DoorDash request completed.";
  }
}

export function toToolResult(structuredContent, { isError = false } = {}) {
  const resultIsError = isError || Boolean(structuredContent.error);
  const warningText = structuredContent.warnings?.length
    ? ` ${structuredContent.warnings.join(" ")}`
    : "";
  const content = [
    {
      type: "text",
      text: `${summarizeResponse(structuredContent)}${warningText}`
    },
    {
      type: "text",
      text: JSON.stringify(structuredContent)
    }
  ];
  return {
    content,
    structuredContent,
    ...(resultIsError ? { isError: true } : {})
  };
}
