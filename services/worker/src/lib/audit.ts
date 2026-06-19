/**
 * audit_log TOMBSTONE writer (§5 audit_log, §6 "write an audit_log tombstone (no
 * content)") — the worker side of the deletion promise.
 *
 * A tombstone records that a deletion HAPPENED, never WHAT was deleted:
 *   actorId   — the acting user/admin, or null for a system job (expire/cleanup).
 *   action    — from `AUDIT_ACTIONS` (validated; an unknown action throws).
 *   targetType— from `AUDIT_TARGET_TYPES` (validated).
 *   targetId  — the id of the deleted thing (montage/user/...), NOT its content.
 *   metadata  — non-PII context ONLY: counts, ids, enums, timestamps, job names.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ CONTENT FIREWALL: `metadata` is run through `sanitizeMetadata`, which keeps │
 * │ ONLY number / boolean / id-shaped-or-enum string / iso-timestamp values and │
 * │ DROPS anything else (free text that could carry a comment/caption/name). So │
 * │ even a careless caller cannot persist user content in a tombstone.          │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
import { auditLog } from '@twenty4/contracts/db';
import {
  auditActionSchema,
  auditTargetTypeSchema,
  type AuditAction,
  type AuditTargetType,
} from '@twenty4/contracts/enums';
import { db as defaultDb } from '../db.js';

/** A drizzle db handle (the pool or a tx) — lets callers write inside a tx. */
type Db = typeof defaultDb;

export interface AuditTombstone {
  /** Acting user/admin; omit/null for a system background job. */
  actorId?: string | null;
  action: AuditAction;
  targetType: AuditTargetType;
  /** The deleted thing's id (never its content). */
  targetId?: string | null;
  /** Non-PII context only — sanitized before write (counts/ids/enums/timestamps). */
  metadata?: Record<string, unknown>;
}

/**
 * Keep ONLY values that cannot be user content:
 *   - finite numbers, booleans, null
 *   - strings that look like a uuid, a known short enum/code, or an ISO timestamp
 *   - shallow arrays/objects of the above (one level — counts maps, id lists)
 * Anything else (free text, long strings) is DROPPED. This is intentionally
 * conservative: a tombstone is metadata, never content.
 */
function sanitizeValue(v: unknown, depth = 0): unknown | undefined {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return isSafeString(v) ? v : undefined;
  if (depth >= 1) return undefined; // bound recursion: only one level of nesting
  if (Array.isArray(v)) {
    const arr = v.map((x) => sanitizeValue(x, depth + 1)).filter((x) => x !== undefined);
    return arr;
  }
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const s = sanitizeValue(val, depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/** Short, code-like token (job names, status enums, reason codes) — no spaces. */
const CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** A string is "safe" (not content) if it's a uuid, an ISO timestamp, or a short code. */
function isSafeString(s: string): boolean {
  return UUID_RE.test(s) || ISO_RE.test(s) || CODE_RE.test(s);
}

/** Sanitize a metadata object → only non-content values survive. */
export function sanitizeMetadata(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    const s = sanitizeValue(v);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

/**
 * Write a deletion tombstone to `audit_log`. Validates action/target_type against
 * the enums and sanitizes metadata so no content can be persisted. Best-effort by
 * design at the call site — but a bad action/target THROWS (it's a programmer error,
 * not runtime data).
 */
export async function writeAuditTombstone(
  t: AuditTombstone,
  db: Db = defaultDb,
): Promise<void> {
  // Validate the closed sets (throws on an unknown action/target — caught early).
  const action = auditActionSchema.parse(t.action);
  const targetType = auditTargetTypeSchema.parse(t.targetType);

  await db.insert(auditLog).values({
    actorId: t.actorId ?? null,
    action,
    targetType,
    targetId: t.targetId ?? null,
    metadata: sanitizeMetadata(t.metadata),
  });
}
