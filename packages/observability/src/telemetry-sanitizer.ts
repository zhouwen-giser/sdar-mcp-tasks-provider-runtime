import type { Attributes } from "@opentelemetry/api";

const ALLOWED_SENSITIVE_HASH_KEYS = new Set(["argumenthash", "authorizationcontexthash"]);
const FORBIDDEN_EXACT_KEYS = new Set([
  "adapterpayload",
  "answer",
  "answers",
  "argument",
  "arguments",
  "input",
  "inputs",
  "inputvalue",
  "inputvalues",
]);
const FORBIDDEN_KEY_PARTS = ["password", "token", "authorization", "jwt"];

export class TelemetrySanitizer {
  sanitize(value: unknown): unknown {
    return sanitizeValue(value, new WeakSet());
  }

  sanitizeAttributes(attributes: Attributes): Attributes {
    const sanitized = this.sanitize(attributes);
    return isRecord(sanitized) ? (sanitized as Attributes) : {};
  }
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactCredentialText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, seen));
  if (!isRecord(value)) return undefined;
  if (seen.has(value)) return "[REDACTED_CIRCULAR]";
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKey(key)) continue;
    result[key] = sanitizeValue(child, seen);
  }
  seen.delete(value);
  return result;
}

function forbiddenKey(key: string): boolean {
  const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
  if (ALLOWED_SENSITIVE_HASH_KEYS.has(normalized)) return false;
  return (
    FORBIDDEN_EXACT_KEYS.has(normalized) ||
    FORBIDDEN_KEY_PARTS.some((part) => normalized.includes(part))
  );
}

function redactCredentialText(value: string): string {
  return value
    .replaceAll(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replaceAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
