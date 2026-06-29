// Content-free tombstone chokepoint (M9 §2/§7).
//
// Every deletion / expiry / purge / replace / admin path routes its audit_log
// metadata through `sanitizeAuditMetadata` so a tombstone can NEVER carry media
// paths, comment/reaction text, emails/phones, or any other free text/PII — only
// ids, counts, the action, and reason codes survive.
//
// Strategy: ALLOW-LIST only. Anything not matched by an allow rule is dropped.
// This is deliberately conservative — a new content-bearing key added upstream is
// stripped by default rather than leaked.

// Exact scalar keys that are always safe to keep.
const ALLOWED_EXACT = new Set<string>([
  "id",
  "count",
  "action",
  "reason",
  "reasonCode",
  "targetType",
  "bytes",
  "rows",
  "objectsDeleted",
  // Admin-action audit (requireAdmin): a SHORT sha256 hex of the request ip — never
  // the raw ip at rest. Content-free + non-reversible, so it is allow-listed.
  "ipHash",
]);

// A key is an allow-listed scalar if it is an exact allowed key, or matches an
// allowed SHAPE: *Id (single id), *Count/*Counts (counts), *Bytes/*Rows (byte/row
// counts). Case-insensitive suffix match on the camelCase tail.
function isAllowedScalarKey(key: string): boolean {
  if (ALLOWED_EXACT.has(key)) return true;
  return (
    /(?:Id|Count|Counts|Bytes|Rows|Deleted)$/.test(key) ||
    key === "id" ||
    key === "count"
  );
}

// A key is an allow-listed ID ARRAY if it ends in `Ids` (e.g. sourceMediaIds,
// groupIds) — these are kept ONLY when every element is a primitive id (string /
// number), never objects.
function isAllowedIdArrayKey(key: string): boolean {
  return /Ids$/.test(key) || key === "ids";
}

// A scalar is keepable if it is a string / number / boolean / null (no objects).
function isScalar(v: unknown): v is string | number | boolean | null {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

/**
 * Return a NEW object carrying only allow-listed, content-free keys from `ctx`.
 * Free text, paths, urls, comment/reaction text, emails/phones and any nested
 * objects/arrays (except `*Ids` id arrays of primitives) are dropped. `action`
 * is always recorded (from the argument, overriding any ctx.action).
 */
export function sanitizeAuditMetadata(
  action: string,
  ctx: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { action };

  for (const [key, value] of Object.entries(ctx)) {
    if (key === "action") continue; // pinned from the argument
    if (Array.isArray(value)) {
      // Keep ONLY id arrays whose every element is a primitive id.
      if (isAllowedIdArrayKey(key) && value.every((el) => typeof el === "string" || typeof el === "number")) {
        out[key] = [...value];
      }
      continue;
    }
    if (value !== null && typeof value === "object") {
      // Drop nested objects wholesale — never recurse content in.
      continue;
    }
    // Scalar: keep only if the key is allow-listed.
    if (isScalar(value) && isAllowedScalarKey(key)) {
      out[key] = value;
    }
  }

  return out;
}
