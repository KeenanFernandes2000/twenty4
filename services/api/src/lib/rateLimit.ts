/**
 * Reusable Redis-backed rate limiting for the auth surface (§8 security-hardening).
 *
 * Two distinct mechanisms live here:
 *
 *  1. `consumeFixedWindow` — a generic fixed-window counter in Redis. INCR on a
 *     namespaced key with an EX on first hit; over the cap → over-limit. Used to
 *     cap OTP SENDS (per-identifier + per-IP) and VERIFY ATTEMPTS (per-identifier).
 *
 *  2. The verify-attempt budget is deliberately keyed on the IDENTIFIER (not the
 *     challenge/code), so re-calling POST /auth/start (which re-issues a fresh
 *     OTP) does NOT reset the failure budget — closing the "brute-force reset via
 *     re-issue" hole. The counter only resets when the window elapses OR a verify
 *     genuinely succeeds (caller clears it).
 *
 * The shared ioredis client (lazyConnect) is used. If Redis is unreachable we
 * FAIL CLOSED for security-relevant counters (treat as over-limit) rather than
 * silently allowing unbounded attempts — callers pass `failClosed`.
 */
import { errors } from '@twenty4/contracts/errors';
import { redis } from '../redis/index.js';
import { env } from '../env.js';

/** Connect the shared lazy client if it isn't already up. */
async function ensureRedis(): Promise<void> {
  if (
    redis.status === 'wait' ||
    redis.status === 'close' ||
    redis.status === 'end'
  ) {
    await redis.connect();
  }
}

/** Normalize an identifier for keying (lowercase, trim) so EMAIL == email. */
export function normalizeIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase();
}

export interface FixedWindowOptions {
  /** Logical bucket name, e.g. 'otp:send:id' — namespaced into the Redis key. */
  bucket: string;
  /** The per-subject key suffix (identifier or IP). */
  subject: string;
  /** Max permitted hits within the window. */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /**
   * When Redis is unreachable: if true, treat as over-limit (fail closed). For
   * security counters (OTP send / verify attempts) we fail closed.
   */
  failClosed?: boolean;
}

export interface FixedWindowResult {
  /** True when this hit is WITHIN the cap (allowed). */
  allowed: boolean;
  /** Current count after this hit (0 if it could not be recorded). */
  count: number;
  /** Seconds until the window resets (best-effort; 0 if unknown). */
  retryAfter: number;
}

/** Build the namespaced Redis key for a fixed-window bucket. */
function windowKey(bucket: string, subject: string): string {
  return `rl:${bucket}:${subject}`;
}

/**
 * Record one hit against a fixed-window counter and report whether it is allowed.
 * INCR is atomic; we set the TTL only on the first hit so the window is anchored
 * to the FIRST request in the window (a true fixed window).
 */
export async function consumeFixedWindow(
  opts: FixedWindowOptions,
): Promise<FixedWindowResult> {
  const key = windowKey(opts.bucket, opts.subject);
  try {
    await ensureRedis();
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, opts.windowSeconds);
    }
    let ttl = await redis.ttl(key);
    // ttl can be -1 (no expire) or -2 (no key) on races; re-arm defensively.
    if (ttl < 0) {
      await redis.expire(key, opts.windowSeconds);
      ttl = opts.windowSeconds;
    }
    return {
      allowed: count <= opts.max,
      count,
      retryAfter: ttl > 0 ? ttl : opts.windowSeconds,
    };
  } catch {
    // Redis down: fail closed for security counters, open otherwise.
    if (opts.failClosed) {
      return { allowed: false, count: opts.max + 1, retryAfter: opts.windowSeconds };
    }
    return { allowed: true, count: 0, retryAfter: 0 };
  }
}

/**
 * Read the current count WITHOUT incrementing (used to enforce the verify-attempt
 * budget BEFORE attempting a verify, so a re-issued OTP can't grant fresh tries).
 */
export async function peekFixedWindow(
  bucket: string,
  subject: string,
  failClosed = false,
): Promise<number> {
  try {
    await ensureRedis();
    const raw = await redis.get(windowKey(bucket, subject));
    return raw ? Number(raw) : 0;
  } catch {
    // Fail closed → report a high count so the caller blocks.
    return failClosed ? Number.MAX_SAFE_INTEGER : 0;
  }
}

/** Clear a counter (e.g. after a SUCCESSFUL verify resets the attempt budget). */
export async function clearFixedWindow(
  bucket: string,
  subject: string,
): Promise<void> {
  try {
    await ensureRedis();
    await redis.del(windowKey(bucket, subject));
  } catch {
    /* best-effort */
  }
}

/* --------------------------- auth-specific limits -------------------------- */

/**
 * OTP send caps per 10-minute window:
 *  - per IDENTIFIER: ≤ OTP_SEND_MAX (strict, fixed). This is the real
 *    brute-force/enumeration defense the security tests assert — do NOT relax it.
 *  - per IP: ≤ OTP_SEND_IP_MAX (env-configurable, defaults to OTP_SEND_MAX). The
 *    per-IP dimension is a COARSE abuse-shaper that legitimately needs raising
 *    behind shared NAT / CI / the api test host (where every test file signs up
 *    many users from one IP). Raising it does NOT weaken the per-identifier cap.
 */
export const OTP_SEND_BUCKET_ID = 'otp:send:id';
export const OTP_SEND_BUCKET_IP = 'otp:send:ip';
export const OTP_SEND_MAX = 5;
/** Env-configurable per-IP send cap (defaults to the strict per-identifier value). */
export const OTP_SEND_IP_MAX = env.OTP_SEND_IP_MAX;
export const OTP_SEND_WINDOW = 600;

/** Verify attempt cap: ≤5 per identifier per 10 minutes (survives re-issue). */
export const VERIFY_ATTEMPT_BUCKET = 'otp:verify:id';
export const VERIFY_ATTEMPT_MAX = 5;
export const VERIFY_ATTEMPT_WINDOW = 600;

/**
 * Throttle an OTP SEND. Caps per-identifier and per-IP independently; exceeding
 * EITHER → throws 429 rate_limited. Fails closed if Redis is down.
 */
export async function throttleOtpSend(args: {
  identifier: string;
  ip: string;
}): Promise<void> {
  const id = normalizeIdentifier(args.identifier);
  const byId = await consumeFixedWindow({
    bucket: OTP_SEND_BUCKET_ID,
    subject: id,
    max: OTP_SEND_MAX,
    windowSeconds: OTP_SEND_WINDOW,
    failClosed: true,
  });
  const byIp = await consumeFixedWindow({
    bucket: OTP_SEND_BUCKET_IP,
    subject: args.ip,
    max: OTP_SEND_IP_MAX,
    windowSeconds: OTP_SEND_WINDOW,
    failClosed: true,
  });
  if (!byId.allowed || !byIp.allowed) {
    const retryAfter = Math.max(byId.retryAfter, byIp.retryAfter);
    throw errors.rateLimited('too many OTP requests; try again later', {
      retryAfter,
    });
  }
}

/**
 * Enforce + record a VERIFY attempt budget keyed on the identifier. Call this
 * BEFORE attempting the verify. Crucially the counter is keyed on the identifier
 * and is NOT cleared by /auth/start re-issuing an OTP, so re-issue cannot reset
 * the budget. On a successful verify the caller MUST call `clearVerifyBudget`.
 *
 * Returns the normalized identifier (for the caller to clear on success).
 */
export async function consumeVerifyBudget(identifier: string): Promise<string> {
  const id = normalizeIdentifier(identifier);
  // Block on the EXISTING count first (so a re-issue can't grant a fresh try
  // beyond the cap), then record this attempt.
  const existing = await peekFixedWindow(VERIFY_ATTEMPT_BUCKET, id, true);
  if (existing >= VERIFY_ATTEMPT_MAX) {
    const retryAfter = await ttlOf(VERIFY_ATTEMPT_BUCKET, id);
    throw errors.rateLimited('too many verification attempts; try again later', {
      retryAfter,
    });
  }
  const res = await consumeFixedWindow({
    bucket: VERIFY_ATTEMPT_BUCKET,
    subject: id,
    max: VERIFY_ATTEMPT_MAX,
    windowSeconds: VERIFY_ATTEMPT_WINDOW,
    failClosed: true,
  });
  if (!res.allowed) {
    throw errors.rateLimited('too many verification attempts; try again later', {
      retryAfter: res.retryAfter,
    });
  }
  return id;
}

/** Reset the verify-attempt budget for an identifier (after a real success). */
export async function clearVerifyBudget(identifier: string): Promise<void> {
  await clearFixedWindow(VERIFY_ATTEMPT_BUCKET, normalizeIdentifier(identifier));
}

/** Best-effort TTL lookup for a bucket key (for retryAfter hints). */
async function ttlOf(bucket: string, subject: string): Promise<number> {
  try {
    await ensureRedis();
    const ttl = await redis.ttl(windowKey(bucket, subject));
    return ttl > 0 ? ttl : VERIFY_ATTEMPT_WINDOW;
  } catch {
    return VERIFY_ATTEMPT_WINDOW;
  }
}

/* --------------------------- group / invite limits ------------------------- */

/**
 * Invite-join cap (§8 "rate limits on … invite-join"; PLAN §3). Bound how often
 * invite codes can be ATTEMPTED, so a leaked/guessed-code brute force or
 * join-spam is throttled. Keyed on BOTH the caller's user id AND the client IP:
 * the per-user key bounds a single account; the per-IP key bounds multi-account
 * abuse (sign up N throwaway users behind one IP and brute the code space). The
 * DB transaction remains the hard race/cap guarantee — these limiters are only
 * abuse-shaping on top.
 *
 * Fails OPEN (not closed) if Redis is down. Justification: invite-join is a
 * legitimate, user-initiated flow; a transient Redis outage must NOT lock real
 * users out of joining their groups (availability). The DB txn's guarded
 * `use_count < max_uses` UPDATE is still the hard cap that a brute force cannot
 * exceed, so failing open here only removes the abuse-shaping layer, not the
 * correctness/cap guarantee. (Contrast OTP/verify, which fail CLOSED because
 * there the limiter IS the brute-force defense.)
 */
export const INVITE_JOIN_BUCKET = 'invite:join:user';
export const INVITE_JOIN_BUCKET_IP = 'invite:join:ip';
export const INVITE_JOIN_MAX = 20;
export const INVITE_JOIN_IP_MAX = 60; // per-IP allows a few users behind one NAT.
export const INVITE_JOIN_WINDOW = 600; // per 10 min.

/**
 * Throttle an invite-join attempt; throws 429 when EITHER the per-user OR the
 * per-IP cap is exceeded. Both dimensions fail OPEN (see note above).
 */
export async function throttleInviteJoin(args: {
  userId: string;
  ip: string;
}): Promise<void> {
  const byUser = await consumeFixedWindow({
    bucket: INVITE_JOIN_BUCKET,
    subject: args.userId,
    max: INVITE_JOIN_MAX,
    windowSeconds: INVITE_JOIN_WINDOW,
    // Fail open: don't block real joins on a Redis blip (DB txn is the hard cap).
    failClosed: false,
  });
  const byIp = await consumeFixedWindow({
    bucket: INVITE_JOIN_BUCKET_IP,
    subject: args.ip,
    max: INVITE_JOIN_IP_MAX,
    windowSeconds: INVITE_JOIN_WINDOW,
    failClosed: false,
  });
  if (!byUser.allowed || !byIp.allowed) {
    throw errors.rateLimited('too many join attempts; try again later', {
      retryAfter: Math.max(byUser.retryAfter, byIp.retryAfter),
    });
  }
}

/**
 * Invite-preview cap (GET /invites/:code). The preview returns an invite's
 * VALIDITY, which makes the endpoint a code-validity oracle: an attacker could
 * enumerate the code space to discover live invites without ever attempting a
 * join. Throttle it per-user AND per-IP (≤30/10min each) so the oracle can't be
 * cheaply mined. Fails OPEN — a preview is a low-stakes read and the DB join txn
 * is the real cap; we only want to blunt enumeration, not lock out browsing.
 */
export const INVITE_PREVIEW_BUCKET = 'invite:preview:user';
export const INVITE_PREVIEW_BUCKET_IP = 'invite:preview:ip';
export const INVITE_PREVIEW_MAX = 30;
export const INVITE_PREVIEW_WINDOW = 600; // 30 previews / 10 min.

/**
 * Throttle an invite-preview; throws 429 when EITHER the per-user OR per-IP cap
 * is exceeded.
 */
export async function throttleInvitePreview(args: {
  userId: string;
  ip: string;
}): Promise<void> {
  const byUser = await consumeFixedWindow({
    bucket: INVITE_PREVIEW_BUCKET,
    subject: args.userId,
    max: INVITE_PREVIEW_MAX,
    windowSeconds: INVITE_PREVIEW_WINDOW,
    failClosed: false,
  });
  const byIp = await consumeFixedWindow({
    bucket: INVITE_PREVIEW_BUCKET_IP,
    subject: args.ip,
    max: INVITE_PREVIEW_MAX,
    windowSeconds: INVITE_PREVIEW_WINDOW,
    failClosed: false,
  });
  if (!byUser.allowed || !byIp.allowed) {
    throw errors.rateLimited('too many invite previews; try again later', {
      retryAfter: Math.max(byUser.retryAfter, byIp.retryAfter),
    });
  }
}

/* ------------------------------- media limits ------------------------------ */

/**
 * Upload-init cap (§8 "rate limits on uploads", §10 max 50 daily items). Bounds
 * how often a user can mint upload slots per window so a runaway client / abuse
 * can't flood the raw bucket or the validate-media queue. The per-day item cap
 * (§10) is enforced separately in the media module against the DB; this is the
 * burst limiter. Fails OPEN (a Redis blip must not block a legitimate user from
 * collecting today's moments; the DB item-cap is the hard ceiling).
 */
export const MEDIA_INIT_BUCKET = 'media:init:user';
export const MEDIA_INIT_MAX = 60; // generous: 50 items + a few retries.
export const MEDIA_INIT_WINDOW = 600; // per 10 min.

/** Throttle a media upload-init; throws 429 over the per-user cap. */
export async function throttleMediaInit(args: { userId: string }): Promise<void> {
  const res = await consumeFixedWindow({
    bucket: MEDIA_INIT_BUCKET,
    subject: args.userId,
    max: MEDIA_INIT_MAX,
    windowSeconds: MEDIA_INIT_WINDOW,
    failClosed: false,
  });
  if (!res.allowed) {
    throw errors.rateLimited('too many uploads; slow down', {
      retryAfter: res.retryAfter,
    });
  }
}

/* ------------------------------ montage limits ----------------------------- */

/**
 * Render-trigger cap (§7.3 / §8 "rate limits"). A montage render is EXPENSIVE
 * (headless Chrome + ffmpeg, ~25-30s, worker concurrency=1) — every render-
 * triggering call (generate / regenerate / replace) competes for that single
 * renderer. Without a throttle a user can enqueue an unbounded burst of renders
 * (a "render storm" / resource-exhaustion DoS) by hammering regenerate/replace.
 *
 * The one-active-montage-per-day guard already caps CONCURRENT generates, but it
 * does NOT cap the regenerate/replace CHURN (each flips the row back to generating
 * and enqueues a fresh render). This is the per-user burst limiter for that churn.
 *
 * Fails CLOSED (unlike the upload/invite limiters): this guards a real, scarce
 * compute resource, so a Redis blip must NOT open the floodgates to render-storm.
 * A 10/10min cap leaves ample room for legitimate "generate then tweak a couple
 * times" review loops while making a storm impossible.
 */
export const RENDER_TRIGGER_BUCKET = 'montage:render:user';
export const RENDER_TRIGGER_MAX = 10; // ≤10 render triggers per window.
export const RENDER_TRIGGER_WINDOW = 600; // per 10 min.

/**
 * Throttle a render-triggering action (generate / regenerate / replace) per user.
 * Call BEFORE enqueueing the render. Throws 429 rate_limited over the cap. Fails
 * CLOSED (a real compute resource — don't let a Redis outage open render-storm).
 */
export async function throttleRenderTrigger(args: { userId: string }): Promise<void> {
  const res = await consumeFixedWindow({
    bucket: RENDER_TRIGGER_BUCKET,
    subject: args.userId,
    max: RENDER_TRIGGER_MAX,
    windowSeconds: RENDER_TRIGGER_WINDOW,
    failClosed: true,
  });
  if (!res.allowed) {
    throw errors.rateLimited('too many montage renders; slow down', {
      retryAfter: res.retryAfter,
    });
  }
}

/* ------------------------------- social limits ----------------------------- */

/**
 * Reaction cap (§8 "rate limits on … reaction endpoints"). A reaction is a cheap
 * write, but the upsert/delete pair is a trivial spam target (toggle a reaction in
 * a loop). Bound it per user so a runaway client can't hammer the table. Fails
 * OPEN — reacting is a legitimate, low-stakes social action and the unique
 * (montage,user) constraint already caps the row count to one per montage; the
 * limiter only shapes burst churn.
 */
export const REACTION_BUCKET = 'social:react:user';
export const REACTION_MAX = 120; // generous: rapid feed browsing + toggles.
export const REACTION_WINDOW = 600; // per 10 min.

/** Throttle a reaction upsert/delete per user; 429 over cap (fails open). */
export async function throttleReaction(args: { userId: string }): Promise<void> {
  const res = await consumeFixedWindow({
    bucket: REACTION_BUCKET,
    subject: args.userId,
    max: REACTION_MAX,
    windowSeconds: REACTION_WINDOW,
    failClosed: false,
  });
  if (!res.allowed) {
    throw errors.rateLimited('too many reactions; slow down', {
      retryAfter: res.retryAfter,
    });
  }
}

/**
 * Comment cap (§8 "rate limits on comment endpoints"). Comments are user content;
 * bound how fast a user can post so comment-spam / flooding a montage is throttled.
 * Fails OPEN — commenting is legitimate and the length bound + status filter are
 * the content guards; the limiter only blunts flood bursts. Tighter than the
 * reaction cap because each comment is a persisted, visible content row.
 */
export const COMMENT_BUCKET = 'social:comment:user';
export const COMMENT_MAX = 60; // per 10 min — ample for real conversation.
export const COMMENT_WINDOW = 600;

/** Throttle a comment create per user; 429 over cap (fails open). */
export async function throttleComment(args: { userId: string }): Promise<void> {
  const res = await consumeFixedWindow({
    bucket: COMMENT_BUCKET,
    subject: args.userId,
    max: COMMENT_MAX,
    windowSeconds: COMMENT_WINDOW,
    failClosed: false,
  });
  if (!res.allowed) {
    throw errors.rateLimited('too many comments; slow down', {
      retryAfter: res.retryAfter,
    });
  }
}

/* ----------------------------- analytics limits ---------------------------- */

/**
 * Analytics-ingest cap (§12 / PLAN slice 9 "POST /analytics … rate-limited"). The
 * ingest endpoint accepts a BATCH of client events; bound how often a client can
 * POST so a runaway/abusive client can't flood the aggregate writer (or inflate
 * counters). Generous — a normal client flushes a small batch periodically. Fails
 * OPEN: analytics is non-essential telemetry; a Redis blip must not block a real
 * client's session-critical traffic, and the firewall (strict parse → counts only)
 * already bounds what a flood can ever persist (no content, just inflated counts).
 */
export const ANALYTICS_BUCKET = 'analytics:ingest:user';
export const ANALYTICS_MAX = 120; // batches per 10 min — ample for periodic flush.
export const ANALYTICS_WINDOW = 600;

/** Throttle an analytics-ingest batch per user; 429 over cap (fails open). */
export async function throttleAnalyticsIngest(args: {
  userId: string;
}): Promise<void> {
  const res = await consumeFixedWindow({
    bucket: ANALYTICS_BUCKET,
    subject: args.userId,
    max: ANALYTICS_MAX,
    windowSeconds: ANALYTICS_WINDOW,
    failClosed: false,
  });
  if (!res.allowed) {
    throw errors.rateLimited('too many analytics requests; slow down', {
      retryAfter: res.retryAfter,
    });
  }
}
