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
    name: optionalString,
    value: optionalString,
    quantity: optionalNumber,
    price: moneySchema.optional(),
    options: z.array(selectedOptionSchema).optional()
  })
);

const modifierOptionSchema = z.lazy(() =>
  z.object({
    option_id: optionalString,
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
  retryable: z.boolean().optional(),
  recovery_tool: z.string().optional()
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
    return compactRecord([
      [
        "name",
        stringValue(
          source.group_name,
          source.item_extra_option?.item_extra?.name,
          source.name
        )
      ],
      [
        "value",
        stringValue(
          source.value,
          source.item_extra_option?.name,
          source.option_name
        )
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

function modifierGroups(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  assertObjectArray(value, "modifier groups");
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
          ? optionValues.map((option) => {
              const item = asObject(option);
              const nestedGroups = modifierGroups(
                first(item.modifier_groups, item.extras, item.options)
              );
              return compactRecord([
                [
                  "option_id",
                  idValue(
                    item.option_id,
                    item.item_extra_option_id,
                    item.id
                  )
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
              ]);
            })
          : []
      ]
    ]);
  });
}

function normalizeItem(value, { cartLine = false } = {}) {
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
    ["purchase_type", stringValue(source.purchase_type)],
    [
      "measurement_unit",
      stringValue(source.measurement_unit, source.unit)
    ],
    ["increment", numberValue(source.increment)],
    ["selected_options", selectedOptions],
    [
      "substitutions",
      Array.isArray(substitutions) && substitutions.length
        ? substitutions.map((entry) => normalizeItem(entry))
        : undefined
    ],
    ["modifier_groups", modifierGroups(rawOptions)]
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

function normalizeCart(value) {
  const wrapper = asObject(value) || {};
  const source = {
    ...wrapper,
    ...(asObject(wrapper.cart) || {})
  };
  const items = Array.isArray(source.items)
    ? source.items.map((entry) => normalizeItem(entry, { cartLine: true }))
    : [];
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
  const items = Array.isArray(itemsSource)
    ? itemsSource.map((entry) =>
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
  const stores = rawStores.slice(0, 100).map((entry) => normalizeStore(entry));
  const warnings = warningList(source.warning);
  if (stores.some((store) => !store.store_id)) {
    warnings.push("Some stores are missing an ID needed for follow-up tools.");
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
  if (Object.keys(store).length === 0) {
    throw new UpstreamSchemaError(
      "DoorDash store details did not contain a usable store."
    );
  }
  const warnings = store.store_id
    ? []
    : ["The store is missing an ID needed for follow-up tools."];
  return card("store_details", { store }, warnings);
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
  const items = rawItems.slice(0, 250).map((entry) => normalizeItem(entry));
  const storeValue =
    source.store ||
    (source.store_id || source.store_name
      ? { store_id: source.store_id, store_name: source.store_name }
      : undefined);
  const warnings = warningList(source.warning);
  if (items.some((item) => !item.item_id)) {
    warnings.push("Some menu items are missing an ID needed for cart tools.");
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
      ["menu_id", idValue(source.menu_id, source.menuId)],
      ["items", items],
      [
        "categories",
        categories.length
          ? categories.map((category) =>
              compactRecord([
                ["category_id", idValue(category.id, category.category_id)],
                ["name", stringValue(category.name, category.title)],
                [
                  "item_ids",
                  Array.isArray(category.items)
                    ? category.items
                        .map((item) => idValue(item.item_id, item.id))
                        .filter(Boolean)
                    : []
                ]
              ])
            )
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
  if (Object.keys(item).length === 0) {
    throw new UpstreamSchemaError(
      "DoorDash item details did not contain a usable item."
    );
  }
  const warnings = item.item_id
    ? []
    : ["The item is missing an ID needed for cart tools."];
  const storeValue =
    source.store ||
    (source.store_id || source.store_name
      ? { store_id: source.store_id, store_name: source.store_name }
      : undefined);
  return card(
    "item_details",
    compactRecord([
      [
        "store",
        storeValue
          ? normalizeStore(storeValue, { includeDiscovery: false })
          : undefined
      ],
      ["menu_id", idValue(source.menu_id, source.menuId)],
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
  const results = groups.map((group) => {
    assertObjectArray(group.items, "item-search results");
    const items = group.items.slice(0, 25).map((entry) => normalizeItem(entry));
    return compactRecord([
      ["query", group.query],
      ["items", items],
      ["truncation", truncation(group.items.length, items.length)]
    ]);
  });
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
    warningList(source.warning)
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
  const items = source.items.slice(0, 25).map((entry) => normalizeItem(entry));
  const rawStores = Array.isArray(source.available_stores)
    ? source.available_stores
    : [];
  assertObjectArray(rawStores, "grocery-list stores");
  const availableStores = rawStores
    .slice(0, 25)
    .map((entry) => normalizeStore(entry));
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
  return card(
    "grocery_list",
    compactRecord([
      ["store", nonEmptyRecord(selectedStore)],
      ["menu_id", idValue(source.menu_id)],
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
    warningList(source.warning)
  );
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
  const itemErrors = rawErrors.map((entry) => {
    const sourceEntry = asObject(entry) || {};
    const item = normalizeItem(sourceEntry.item || sourceEntry);
    const errorItem = compactRecord([
      ["item_id", item.item_id],
      ["name", item.name],
      ["quantity", item.quantity]
    ]);
    return compactRecord([
      ["item", errorItem],
      [
        "message",
        stringValue(sourceEntry.error_message, sourceEntry.message)
      ],
      [
        "modifier_groups",
        modifierGroups(
          first(
            sourceEntry.required_options,
            sourceEntry.modifier_groups,
            item.modifier_groups
          )
        )
      ]
    ]);
  });
  const warnings = warningList(source.warning);
  if (!cartData.cart_uuid) {
    warnings.push("The cart is missing its UUID.");
  }
  return card(
    "cart",
    {
      ...cartData,
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
  const carts = source.carts.slice(0, 100).map((entry) => normalizeCart(entry));
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
    warningList(source.warning)
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
    return card(
      kind,
      compactRecord([
        [
          "resource_id",
          idValue(
            source.cart_uuid,
            source.order_uuid,
            source.address_id,
            source.id
          )
        ],
        ["message", stringValue(source.message)]
      ]),
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
  const orders = source.orders
    .slice(0, 100)
    .map((entry) => normalizeOrder(entry));
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
    warningList(source.warning)
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
  const tipSuggestions = tipGroups.flatMap((group) => {
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
  const budgets =
    quote.expense_order_options?.all_eligible_expense_order_budgets;
  const eligibleBudgets = Array.isArray(budgets)
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
  const workBenefits = nonEmptyRecord(
    compactRecord([
      [
        "team_id",
        idValue(quote.company_payment_info?.team_order_info?.team_id)
      ],
      [
        "eligible_budgets",
        eligibleBudgets.length ? eligibleBudgets : undefined
      ]
    ])
  );
  return card(
    "order_preview",
    compactRecord([
      ...Object.entries(order),
      ["pricing_quote_id", idValue(quote.pricing_quote_id)],
      [
        "tip_suggestions",
        tipSuggestions.length ? tipSuggestions : undefined
      ],
      ["work_benefits", workBenefits]
    ]),
    warningList(source.warning)
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
  return card(
    "receipt",
    order,
    warningList(source.warning)
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
  const warnings = cartData.cart_uuid
    ? []
    : ["The reordered cart is missing its UUID."];
  return card("reorder", cartData, warnings);
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
  const addresses = source.addresses.map((address) =>
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
  return card("address_list", { addresses });
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
  const cards = source.cards.map((card) =>
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
  return card("payment_methods", { cards });
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
  const promotions = rawPromos.map((promo) =>
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
  return card("promotion_list", { promotions });
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

const itemErrorSchema = z.object({
  item: z.object({
    item_id: optionalString,
    name: optionalString,
    quantity: optionalNumber
  }),
  message: optionalString,
  modifier_groups: z.array(modifierGroupSchema).optional()
});

const addressSchema = z.object({
  address_id: optionalString,
  label: optionalString,
  address: optionalString,
  latitude: optionalNumber,
  longitude: optionalNumber,
  is_default: optionalBoolean
});

const cardPaymentSchema = z.object({
  brand: optionalString,
  last4: optionalString,
  exp_month: optionalNumber,
  exp_year: optionalNumber,
  is_default: optionalBoolean
});

const promotionSchema = z.object({
  promo_code: optionalString,
  store_id: optionalString,
  title: optionalString,
  description: optionalString,
  campaign_id: optionalString,
  ad_group_id: optionalString,
  ad_id: optionalString,
  discount: moneySchema.optional()
});

const tipSuggestionSchema = z.object({
  amount: moneySchema.optional(),
  percentage: optionalNumber,
  recommended: z.literal(true).optional(),
  recipient: optionalString
});

const workBenefitsSchema = z.object({
  team_id: optionalString,
  eligible_budgets: z
    .array(
      z.object({
        budget_id: optionalString,
        name: optionalString,
        remaining: moneySchema.optional(),
        team_account_id: optionalString,
        expense_code_mode: optionalString,
        expense_note_required: z.literal(true).optional()
      })
    )
    .optional()
});

const schemaByKind = {
  address_list: cardSchema("address_list", {
    addresses: z.array(addressSchema)
  }),
  address_update: cardSchema("address_update", {
    resource_id: optionalString,
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
    menu_id: optionalString,
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
    resource_id: optionalString,
    message: optionalString
  }),
  checkout_link: cardSchema("checkout_link", {
    cart_uuid: optionalString,
    checkout_url: z.string()
  }),
  order_list: cardSchema("order_list", {
    orders: z.array(orderSchema),
    truncation: truncationSchema.optional()
  }),
  order_preview: cardSchema("order_preview", {
    ...orderFields,
    items: z.array(itemSchema),
    pricing_quote_id: optionalString,
    tip_suggestions: z.array(tipSuggestionSchema).optional(),
    work_benefits: workBenefitsSchema.optional()
  }),
  receipt: cardSchema("receipt", {
    ...orderFields,
    items: z.array(itemSchema),
    pricing: pricingSchema
  }),
  reorder: cardSchema("reorder", cartFields),
  order_status: cardSchema("order_status", orderFields),
  promotion_list: cardSchema("promotion_list", {
    promotions: z.array(promotionSchema)
  }),
  promotion_mutation: cardSchema("promotion_mutation", {
    resource_id: optionalString,
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
    outputSchema,
    project
  };
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
      error?.details?.data?.error_reason,
      error?.details?.data?.code,
      error?.details?.error_reason,
      error?.details?.code
    ) || "DOORDASH_CLI_ERROR"
  );
}

function recoveryToolFor(code, message) {
  if (
    code === "AGENTIC_RESTRICTED_ITEM_NOT_ALLOWED" ||
    /restricted item|finish.*browser|verification/i.test(message)
  ) {
    return "create_checkout_link";
  }
  if (/status|submission attempt|duplicate charge/i.test(message)) {
    return "order_status";
  }
  return undefined;
}

function retryableFor(code, message) {
  if (code === "UPSTREAM_SCHEMA_ERROR") {
    return false;
  }
  if (/timeout|temporar|try again/i.test(message)) {
    return true;
  }
  if (/duplicate charge|already has a recorded submission/i.test(message)) {
    return false;
  }
  return undefined;
}

export function errorEnvelope(contract, error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  const payload = {
    schema: RESPONSE_SCHEMA,
    version: RESPONSE_SCHEMA_VERSION,
    kind: contract.kind,
    error: compactRecord([
      ["code", code],
      ["message", message],
      ["retryable", retryableFor(code, message)],
      ["recovery_tool", recoveryToolFor(code, message)]
    ])
  };
  return z
    .object({
      schema: z.literal(RESPONSE_SCHEMA),
      version: z.literal(RESPONSE_SCHEMA_VERSION),
      kind: z.string(),
      error: contractErrorSchema
    })
    .parse(payload);
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

export function summarizeResponse(value) {
  if (value.error) {
    return `${value.error.code}: ${value.error.message}`;
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
      return `${plural(value.items.length, "cart line")}${value.store?.name ? ` at ${value.store.name}` : ""}${errors ? `; ${plural(errors, "item")} still need${errors === 1 ? "s" : ""} attention` : ""}.`;
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
  const content = [
    {
      type: "text",
      text: summarizeResponse(structuredContent)
    }
  ];
  if (!resultIsError) {
    content.push({
      type: "text",
      text: JSON.stringify(structuredContent)
    });
  }
  return {
    content,
    structuredContent,
    ...(resultIsError ? { isError: true } : {})
  };
}
