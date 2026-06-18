/**
 * Analytics event schemas (§12).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ CRITICAL: events carry NO USER CONTENT.                                    │
 * │ Payloads contain ONLY ids, counts, enums, durations, and timestamps —      │
 * │ never photo/video bytes, comment text, captions, names, emails, phones, or │
 * │ any free text. This is a hard privacy invariant (§12 + §6: only anonymized │
 * │ aggregate counts may persist). Every property below is an id/number/enum.  │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Shape: a Zod discriminated union keyed on `event`. Each event embeds a common
 * envelope (`user_id` or anonymized id pre-auth, `ts`). The vendor is [TEAM].
 */
import { z } from 'zod';
import { mediaTypeSchema, reactionTypeSchema, themeSchema } from './enums.js';

/* ------------------------------ common envelope ---------------------------- */

/** Fields every event carries. `userId` may be an anonymized pre-auth id. */
export const analyticsEnvelope = {
  /** Stable user id, or anonymized id before auth. */
  userId: z.string().min(1),
  /** Event timestamp (ms epoch). */
  ts: z.number().int(),
} as const;

/** All §12 event names (the closed set). */
export const ANALYTICS_EVENTS = [
  // Acquisition
  'app_installed',
  'signup_started',
  'signup_completed',
  'first_group_joined',
  'first_friend_invited',
  // Activation
  'first_media_captured',
  'first_media_uploaded',
  'first_montage_generated',
  'first_montage_published',
  'first_recap_viewed',
  // Engagement
  'media_added',
  'montage_generated',
  'montage_published',
  'feed_viewed',
  'recap_watch',
  'reaction_sent',
  'comment_sent',
  // Retention (mostly derived server-side, but emittable)
  'dau',
  'd1_retained',
  'd7_retained',
  'd30_retained',
  'group_active',
  // Operational
  'upload_failed',
  'montage_render_failed',
  'render_duration_ms',
  'storage_used',
  'cleanup_job_result',
  'expired_media_deleted_count',
] as const;
export const analyticsEventNameSchema = z.enum(ANALYTICS_EVENTS);
export type AnalyticsEventName = z.infer<typeof analyticsEventNameSchema>;

/**
 * Build a single-event schema: envelope + literal `event` + (optional) props.
 * `props` defaults to an empty shape so the spread is always a concrete object —
 * this keeps `event: z.literal(name)` narrowed to `ZodLiteral<N>` per call site,
 * which is what `z.discriminatedUnion('event', ...)` requires.
 */
const ev = <N extends AnalyticsEventName, P extends z.ZodRawShape = {}>(
  name: N,
  props: P = {} as P,
) =>
  z
    .object({
      event: z.literal(name),
      ...analyticsEnvelope,
      ...props,
    })
    .strict();

/* --------------------------------- events ---------------------------------- */
// Acquisition
const appInstalled = ev('app_installed');
const signupStarted = ev('signup_started');
const signupCompleted = ev('signup_completed', { provider: z.string() });
const firstGroupJoined = ev('first_group_joined', { groupId: z.string() });
const firstFriendInvited = ev('first_friend_invited');

// Activation
const firstMediaCaptured = ev('first_media_captured', { mediaType: mediaTypeSchema });
const firstMediaUploaded = ev('first_media_uploaded', { mediaType: mediaTypeSchema });
const firstMontageGenerated = ev('first_montage_generated');
const firstMontagePublished = ev('first_montage_published');
const firstRecapViewed = ev('first_recap_viewed');

// Engagement
const mediaAdded = ev('media_added', {
  mediaType: mediaTypeSchema,
  /** Count of items in today's bucket after add. */
  dayItemCount: z.number().int().min(0).optional(),
});
const montageGenerated = ev('montage_generated', {
  theme: themeSchema,
  musicId: z.string(),
  itemCount: z.number().int().min(0),
});
const montagePublished = ev('montage_published', {
  montageId: z.string(),
  groupCount: z.number().int().min(0),
});
const feedViewed = ev('feed_viewed', { groupId: z.string().optional() });
const recapWatch = ev('recap_watch', {
  montageId: z.string(),
  /** §12 explicit fields. */
  watchMs: z.number().int().min(0),
  completionRate: z.number().min(0).max(1),
});
const reactionSent = ev('reaction_sent', {
  montageId: z.string(),
  reactionType: reactionTypeSchema,
});
const commentSent = ev('comment_sent', { montageId: z.string() });

// Retention
const dau = ev('dau');
const d1Retained = ev('d1_retained');
const d7Retained = ev('d7_retained');
const d30Retained = ev('d30_retained');
const groupActive = ev('group_active', { groupId: z.string() });

// Operational
const uploadFailed = ev('upload_failed', {
  mediaType: mediaTypeSchema.optional(),
  /** Stable error code (from errors.ts), not a message. */
  errorCode: z.string().optional(),
});
const montageRenderFailed = ev('montage_render_failed', {
  montageId: z.string(),
  /** Retry attempt index (0-based). */
  attempt: z.number().int().min(0).optional(),
  errorCode: z.string().optional(),
});
const renderDurationMs = ev('render_duration_ms', {
  montageId: z.string(),
  durationMs: z.number().int().min(0),
});
const storageUsed = ev('storage_used', {
  /** Aggregate bytes — no per-object/user content. */
  bytes: z.number().int().min(0),
  bucket: z.string().optional(),
});
const cleanupJobResult = ev('cleanup_job_result', {
  job: z.string(),
  ok: z.boolean(),
  deletedCount: z.number().int().min(0).optional(),
  durationMs: z.number().int().min(0).optional(),
});
const expiredMediaDeletedCount = ev('expired_media_deleted_count', {
  count: z.number().int().min(0),
});

/* --------------------------- discriminated union --------------------------- */

export const analyticsEventSchema = z.discriminatedUnion('event', [
  appInstalled,
  signupStarted,
  signupCompleted,
  firstGroupJoined,
  firstFriendInvited,
  firstMediaCaptured,
  firstMediaUploaded,
  firstMontageGenerated,
  firstMontagePublished,
  firstRecapViewed,
  mediaAdded,
  montageGenerated,
  montagePublished,
  feedViewed,
  recapWatch,
  reactionSent,
  commentSent,
  dau,
  d1Retained,
  d7Retained,
  d30Retained,
  groupActive,
  uploadFailed,
  montageRenderFailed,
  renderDurationMs,
  storageUsed,
  cleanupJobResult,
  expiredMediaDeletedCount,
]);

export type AnalyticsEvent = z.infer<typeof analyticsEventSchema>;
