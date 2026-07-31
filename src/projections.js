const ACTIVITY_REDACTED_KEYS = new Set([
  "address",
  "address_id",
  "authorization",
  "checkout_url",
  "checkouturl",
  "consumer_tracking_url",
  "default_payment_method_id",
  "email",
  "expense_code",
  "expense_notes",
  "group_cart_url",
  "groupcarturl",
  "last4",
  "lat",
  "latitude",
  "lng",
  "longitude",
  "payment_method_id",
  "phone",
  "printable_address",
  "provider_payment_method_id",
  "street",
  "subpremise",
  "token",
  "token_hash",
  "tracking_url",
  "trackingurl"
]);

const ACTIVITY_SENSITIVE_FLAGS = new Set([
  "--address-id",
  "--ad-group-id",
  "--ad-id",
  "--budget-id",
  "--campaign-id",
  "--expense-code",
  "--expense-notes",
  "--promo-code",
  "--team-account-id",
  "--team-id"
]);

const ACTIVITY_REDACTED_TEXT_KEYS = new Set([
  "error",
  "message",
  "warning"
]);

function redactSensitiveText(value) {
  return value
    .replace(/https?:\/\/[^\s"']+/gi, "[redacted-url]")
    .replace(
      /\b\d{1,6}\s+[A-Za-z0-9.'# -]{1,80}\s(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl)\b(?:[^,\n]*,?){0,3}/gi,
      "[redacted-address]"
    );
}

export function redactForActivity(value, key = "") {
  const normalizedKey = key.toLowerCase();
  if (ACTIVITY_REDACTED_KEYS.has(normalizedKey)) {
    return "[redacted]";
  }

  if (Array.isArray(value)) {
    const itemKey = normalizedKey === "warnings" ? "warning" : "";
    return value.map((entry) => redactForActivity(entry, itemKey));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entry]) => [
        entryKey,
        redactForActivity(entry, entryKey)
      ])
    );
  }

  if (typeof value === "string") {
    if (ACTIVITY_REDACTED_TEXT_KEYS.has(normalizedKey)) {
      return "[redacted]";
    }
    return redactSensitiveText(value);
  }

  return value;
}

export function sanitizeCommandForActivity(args) {
  const sanitized = [...args];
  for (let index = 0; index < sanitized.length - 1; index += 1) {
    if (ACTIVITY_SENSITIVE_FLAGS.has(sanitized[index])) {
      sanitized[index + 1] = "[redacted]";
      index += 1;
    }
  }
  return sanitized;
}
