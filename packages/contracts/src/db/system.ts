/**
 * system domain (§5 audit_log + idempotency keys).
 *
 * audit_log: TOMBSTONES ONLY — admin/moderation/deletion actions. NO content:
 * just actor/action/target/timestamp/metadata. `metadata` jsonb is for non-PII
 * context (counts, ids), never user text.
 *
 * idempotency_key: dedupes publish/replace (§8 cross-cutting). A key scopes to a
 * user + endpoint; the stored response lets a retried request return the same result.
 */
import { integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, tsTz, uuidPk } from './_shared.js';

/* -------------------------------- audit_log -------------------------------- */
export const auditLog = pgTable('audit_log', {
  id: uuidPk(),
  /** Acting user/admin; nullable for system jobs (cleanup/expire). No FK (actor may be purged). */
  actorId: uuid('actor_id'),
  /** From `AUDIT_ACTIONS` (validated in app layer). */
  action: text('action').notNull(),
  /** From `AUDIT_TARGET_TYPES`. */
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id'),
  /** Non-PII context only (counts, reason codes, job ids). NEVER user content. */
  metadata: jsonb('metadata'),
  createdAt: createdAt(),
});

export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;

/* ----------------------------- idempotency_key ----------------------------- */
export const idempotencyKeys = pgTable(
  'idempotency_key',
  {
    id: uuidPk(),
    /** Client-supplied key (Idempotency-Key header). */
    key: text('key').notNull(),
    /** Owning user — scope keys per user so they can't collide across accounts. */
    userId: uuid('user_id').notNull(),
    /** Endpoint/operation the key guards (e.g. "POST /montages/{id}/publish"). */
    endpoint: text('endpoint').notNull(),
    /** Hash of the request body — a reused key with a different body is a conflict. */
    requestHash: text('request_hash').notNull(),
    /** Cached HTTP status of the first successful response. */
    responseStatus: integer('response_status'),
    /** Cached response body to replay on retry. */
    responseBody: jsonb('response_body'),
    /** When this key may be garbage-collected. */
    expiresAt: tsTz('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('idempotency_key_user_key_uq').on(t.userId, t.key)],
);

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKey = typeof idempotencyKeys.$inferInsert;
