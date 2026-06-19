/**
 * API-side `audit_log` TOMBSTONE writer (Slice 8 admin/safety/moderation).
 *
 * Mirrors the worker's `services/worker/src/lib/audit.ts` writer, but bound to the
 * API's own `db` handle so admin/moderation actions taken in-process (suspend,
 * ban, reinstate, report resolve, admin content removal, rejected-admin attempts)
 * record a content-free tombstone. Same CONTENT FIREWALL: `metadata` is run
 * through `sanitizeMetadata`, which keeps ONLY number / boolean / id-shaped-or-enum
 * string / iso-timestamp values and DROPS anything else (free text that could carry
 * a comment/caption/name/reason). So even a careless caller cannot persist user
 * content in a tombstone (§5 "admin/moderation/deletion actions only", content-free).
 *
 * A tombstone records that an action HAPPENED, never WHAT was acted on:
 *   actorId   — the acting admin/user, or null for a system action.
 *   action    — from `AUDIT_ACTIONS` (validated; an unknown action throws).
 *   targetType— from `AUDIT_TARGET_TYPES` (validated).
 *   targetId  — the id of the acted-on thing (user/montage/report/comment).
 *   metadata  — non-PII context ONLY: counts, ids, enums, timestamps, codes.
 */
import { auditLog } from '@twenty4/contracts/db';
import {
  auditActionSchema,
  auditTargetTypeSchema,
  type AuditAction,
  type AuditTargetType,
} from '@twenty4/contracts/enums';
import { db as defaultDb } from '../db/index.js';

/** A drizzle db handle (the pool or a tx) — lets callers write inside a tx. */
type Db = typeof defaultDb;

export interface AuditTombstone {
  /** Acting admin/user; omit/null for a system action. */
  actorId?: string | null;
  action: AuditAction;
  targetType: AuditTargetType;
  /** The acted-on thing's id (never its content). */
  targetId?: string | null;
  /** Non-PII context only — sanitized before write (counts/ids/enums/timestamps). */
  metadata?: Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/** Short, code-like token (job names, status enums, reason codes) — no spaces. */
const CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** A string is "safe" (not content) if it's a uuid, an ISO timestamp, or a short code. */
function isSafeString(s: string): boolean {
  return UUID_RE.test(s) || ISO_RE.test(s) || CODE_RE.test(s);
}

/**
 * Keep ONLY values that cannot be user content (one level of nesting for
 * counts-maps / id-lists). Anything else (free text, long strings) is DROPPED.
 */
function sanitizeValue(v: unknown, depth = 0): unknown | undefined {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return isSafeString(v) ? v : undefined;
  if (depth >= 1) return undefined;
  if (Array.isArray(v)) {
    return v.map((x) => sanitizeValue(x, depth + 1)).filter((x) => x !== undefined);
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
 * Write an audit tombstone to `audit_log`. Validates action/target_type against
 * the enums and sanitizes metadata so no content can be persisted. A bad
 * action/target THROWS (programmer error). Pass a tx as `db` to write atomically
 * with the action it records.
 */
export async function writeAuditTombstone(
  t: AuditTombstone,
  db: Db = defaultDb,
): Promise<void> {
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

export type { AuditAction, AuditTargetType };
