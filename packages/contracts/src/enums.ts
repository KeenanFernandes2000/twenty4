/**
 * Shared enums — the single source of truth for every closed value set in twenty4.
 *
 * Each enum is declared ONCE as a tuple, then projected into:
 *   - a Drizzle `pgEnum` (named `<thing>Enum`) for use as a column type, and
 *   - a Zod enum (named `<thing>Schema`) + inferred TS union (named `<Thing>`).
 *
 * The tuple is the source; the pgEnum and the Zod enum can never drift because
 * they are built from the same literal array.
 *
 * Field names/values follow `reference/twenty4_Development_Spec.md` §5 exactly.
 * Where the spec and PLAN.md disagree, the SPEC wins (noted inline).
 */
import { pgEnum } from 'drizzle-orm/pg-core';
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  user                                                                       */
/* -------------------------------------------------------------------------- */

/** §5 user.auth_provider */
export const AUTH_PROVIDERS = ['phone', 'email', 'apple', 'google'] as const;
export const authProviderEnum = pgEnum('auth_provider', AUTH_PROVIDERS);
export const authProviderSchema = z.enum(AUTH_PROVIDERS);
export type AuthProvider = z.infer<typeof authProviderSchema>;

/** §5 user.account_status */
export const ACCOUNT_STATUSES = ['active', 'suspended', 'banned', 'deleted'] as const;
export const accountStatusEnum = pgEnum('account_status', ACCOUNT_STATUSES);
export const accountStatusSchema = z.enum(ACCOUNT_STATUSES);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

/* -------------------------------------------------------------------------- */
/*  group                                                                      */
/* -------------------------------------------------------------------------- */

/** §5 group.status */
export const GROUP_STATUSES = ['active', 'archived'] as const;
export const groupStatusEnum = pgEnum('group_status', GROUP_STATUSES);
export const groupStatusSchema = z.enum(GROUP_STATUSES);
export type GroupStatus = z.infer<typeof groupStatusSchema>;

/** §5 group_member.role (MVP: only `owner` exercises admin powers, Q12) */
export const GROUP_MEMBER_ROLES = ['owner', 'admin', 'member'] as const;
export const groupMemberRoleEnum = pgEnum('group_member_role', GROUP_MEMBER_ROLES);
export const groupMemberRoleSchema = z.enum(GROUP_MEMBER_ROLES);
export type GroupMemberRole = z.infer<typeof groupMemberRoleSchema>;

/** §5 group_member.status */
export const GROUP_MEMBER_STATUSES = ['active', 'left', 'removed'] as const;
export const groupMemberStatusEnum = pgEnum('group_member_status', GROUP_MEMBER_STATUSES);
export const groupMemberStatusSchema = z.enum(GROUP_MEMBER_STATUSES);
export type GroupMemberStatus = z.infer<typeof groupMemberStatusSchema>;

/* -------------------------------------------------------------------------- */
/*  daily_media_item                                                           */
/* -------------------------------------------------------------------------- */

/** §5 daily_media_item.media_type */
export const MEDIA_TYPES = ['photo', 'video'] as const;
export const mediaTypeEnum = pgEnum('media_type', MEDIA_TYPES);
export const mediaTypeSchema = z.enum(MEDIA_TYPES);
export type MediaType = z.infer<typeof mediaTypeSchema>;

/**
 * §5 daily_media_item.validation_status.
 * Spec values: pending | valid | invalid. PLAN/CLAUDE.md mention a `tampered`
 * value, but §6 models tampering as an anti-tamper *flag* (delta) on a still-
 * valid/invalid item, not a distinct validation state — so we follow the SPEC's
 * three-value set and carry the tamper signal in `metadata_summary`/a boolean.
 */
export const VALIDATION_STATUSES = ['pending', 'valid', 'invalid'] as const;
export const validationStatusEnum = pgEnum('validation_status', VALIDATION_STATUSES);
export const validationStatusSchema = z.enum(VALIDATION_STATUSES);
export type ValidationStatus = z.infer<typeof validationStatusSchema>;

/** §5 daily_media_item.processing_status */
export const MEDIA_PROCESSING_STATUSES = [
  'uploaded',
  'validating',
  'valid',
  'invalid',
  'used',
  'deleted',
  'failed',
] as const;
export const mediaProcessingStatusEnum = pgEnum(
  'media_processing_status',
  MEDIA_PROCESSING_STATUSES,
);
export const mediaProcessingStatusSchema = z.enum(MEDIA_PROCESSING_STATUSES);
export type MediaProcessingStatus = z.infer<typeof mediaProcessingStatusSchema>;

/* -------------------------------------------------------------------------- */
/*  montage                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * §5 montage.status — the full lifecycle (§6 montage lifecycle).
 * SPEC set (authoritative). PLAN/CLAUDE.md proposed `draft`/`expired`-only sets;
 * the spec's richer set wins (it distinguishes user vs admin deletion, which
 * the audit log / 404 semantics depend on).
 */
export const MONTAGE_STATUSES = [
  'not_generated',
  'generating',
  'draft_ready',
  'published',
  'failed',
  'deleted_by_user',
  'removed_by_admin',
  'expired',
] as const;
export const montageStatusEnum = pgEnum('montage_status', MONTAGE_STATUSES);
export const montageStatusSchema = z.enum(MONTAGE_STATUSES);
export type MontageStatus = z.infer<typeof montageStatusSchema>;

/**
 * Theme names (PLAN "Ember" set + spec §7.1). `Random` is a *selection* meta-
 * theme (picks one of the concrete themes at generation time); it is a valid
 * client request value but a montage row should persist the resolved theme.
 */
export const THEMES = [
  'Chill',
  'Party',
  'Clean',
  'Travel',
  'Fast Cut',
  'Soft',
  'Mellow',
  'Random',
] as const;
export const themeEnum = pgEnum('montage_theme', THEMES);
export const themeSchema = z.enum(THEMES);
export type Theme = z.infer<typeof themeSchema>;

/** Concrete themes only (excludes the `Random` meta-selector) — used by the EDL. */
export const CONCRETE_THEMES = [
  'Chill',
  'Party',
  'Clean',
  'Travel',
  'Fast Cut',
  'Soft',
  'Mellow',
] as const;
export const concreteThemeSchema = z.enum(CONCRETE_THEMES);
export type ConcreteTheme = z.infer<typeof concreteThemeSchema>;

/* -------------------------------------------------------------------------- */
/*  reaction                                                                    */
/* -------------------------------------------------------------------------- */

/** §5 reaction.type (PLAN reactions like/laugh/fire/heart/shocked) */
export const REACTION_TYPES = ['like', 'laugh', 'fire', 'heart', 'shocked'] as const;
export const reactionTypeEnum = pgEnum('reaction_type', REACTION_TYPES);
export const reactionTypeSchema = z.enum(REACTION_TYPES);
export type ReactionType = z.infer<typeof reactionTypeSchema>;

/* -------------------------------------------------------------------------- */
/*  comment                                                                     */
/* -------------------------------------------------------------------------- */

/** §5 comment.status */
export const COMMENT_STATUSES = ['active', 'deleted'] as const;
export const commentStatusEnum = pgEnum('comment_status', COMMENT_STATUSES);
export const commentStatusSchema = z.enum(COMMENT_STATUSES);
export type CommentStatus = z.infer<typeof commentStatusSchema>;

/* -------------------------------------------------------------------------- */
/*  report                                                                      */
/* -------------------------------------------------------------------------- */

/** §5 report.target_type */
export const REPORT_TARGET_TYPES = ['montage', 'comment', 'user'] as const;
export const reportTargetTypeEnum = pgEnum('report_target_type', REPORT_TARGET_TYPES);
export const reportTargetTypeSchema = z.enum(REPORT_TARGET_TYPES);
export type ReportTargetType = z.infer<typeof reportTargetTypeSchema>;

/** §5 report.status */
export const REPORT_STATUSES = ['open', 'under_review', 'actioned', 'dismissed'] as const;
export const reportStatusEnum = pgEnum('report_status', REPORT_STATUSES);
export const reportStatusSchema = z.enum(REPORT_STATUSES);
export type ReportStatus = z.infer<typeof reportStatusSchema>;

/**
 * Report reasons. Spec leaves `report.reason` free-form; we constrain it to a
 * stable enum for analytics + admin triage. // TODO(spec-gap): confirm reason set.
 */
export const REPORT_REASONS = [
  'spam',
  'harassment',
  'hate',
  'nudity',
  'violence',
  'self_harm',
  'illegal',
  'impersonation',
  'other',
] as const;
export const reportReasonEnum = pgEnum('report_reason', REPORT_REASONS);
export const reportReasonSchema = z.enum(REPORT_REASONS);
export type ReportReason = z.infer<typeof reportReasonSchema>;

/* -------------------------------------------------------------------------- */
/*  notifications                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Notification event types (PLAN §9 Phase-2 dispatcher hooks + Phase-1 local
 * reminders). Stored as a TS union / Zod enum for the notification_prefs jsonb
 * and the (Phase-2) dispatch queue; not yet a DB column, so no pgEnum.
 */
export const NOTIFICATION_TYPES = [
  'friend_posted',
  'friend_reacted',
  'friend_commented',
  'montage_expiring',
  'invite_received',
  'capture_reminder', // Phase-1 local reminder
  'expiry_reminder', // Phase-1 local reminder
] as const;
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

/* -------------------------------------------------------------------------- */
/*  audit log                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * audit_log.action (§5) — admin/moderation/deletion actions only. Kept as a
 * Zod-validated string union (column is plain text so the set can extend without
 * a migration). // TODO(spec-gap): spec lists no fixed action set; this is ours.
 */
export const AUDIT_ACTIONS = [
  'montage_expired',
  'montage_deleted_by_user',
  'montage_removed_by_admin',
  'montage_replaced',
  'raw_media_purged',
  'account_suspended',
  'account_banned',
  'account_deleted',
  'report_actioned',
  'report_dismissed',
  'content_removed',
  'cleanup_job_run',
] as const;
export const auditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof auditActionSchema>;

/** audit_log.target_type — broader than report targets (covers raw media, jobs). */
export const AUDIT_TARGET_TYPES = [
  'montage',
  'comment',
  'user',
  'group',
  'media',
  'report',
  'job',
] as const;
export const auditTargetTypeSchema = z.enum(AUDIT_TARGET_TYPES);
export type AuditTargetType = z.infer<typeof auditTargetTypeSchema>;
