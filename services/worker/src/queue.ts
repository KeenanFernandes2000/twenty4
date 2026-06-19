/**
 * Shared BullMQ queue/job names + payload shapes for the worker side.
 *
 * These MUST match the API producer (services/api/src/queue/producers.ts). They
 * are plain infra constants (not API logic), so the worker declares its own copy
 * rather than importing across service boundaries.
 */
export const MEDIA_QUEUE = 'media';
export const VALIDATE_MEDIA_JOB = 'validate-media';

/** Payload for the `validate-media` job (see producers.ts ValidateMediaJob). */
export interface ValidateMediaJob {
  mediaId: string;
  serverReceiveTime: string;
}

/* ---------------------------- montage queue ------------------------------- */

export const MONTAGE_QUEUE = 'montage';
export const RENDER_MONTAGE_JOB = 'render-montage';
export const EXPIRE_MONTAGE_JOB = 'expire-montage';
export const CLEANUP_RAW_JOB = 'cleanup-raw';
/** Replace cascade (§6 Q2): hard-delete the prior (superseded) montage's content. */
export const SUPERSEDE_CLEANUP_JOB = 'supersede-cleanup';
/** Repeatable §6 sweeps (registered on the montage queue at boot). */
export const SWEEP_EXPIRIES_JOB = 'sweep-expiries';
export const DAY_CLOSE_SWEEP_JOB = 'day-close-sweep';
/** Raw-reclamation backstop (Fix 2b): hard-delete raw rows whose expiry_at passed. */
export const RAW_PURGE_SWEEP_JOB = 'raw-purge-sweep';

/* ----------------------------- account queue ------------------------------ */

/** Account purge queue + job (must match the API producer's ACCOUNT_QUEUE). */
export const ACCOUNT_QUEUE = 'account';
export const PURGE_ACCOUNT_JOB = 'purge-account';

/** Payload for the `render-montage` job (see producers.ts RenderMontageJob). */
export interface RenderMontageJob {
  montageId: string;
}

/** Payload for the delayed `expire-montage` job (see producers.ts ExpireMontageJob). */
export interface ExpireMontageJob {
  montageId: string;
  expiryAt: string;
}

/** Payload for the delayed `cleanup-raw` job (see producers.ts CleanupRawJob). */
export interface CleanupRawJob {
  userId: string;
  dayBucket: string;
  montageId: string;
}

/** Payload for the `supersede-cleanup` job (see producers.ts SupersedeCleanupJob). */
export interface SupersedeCleanupJob {
  priorMontageId: string;
  replacementId: string;
}

/** Payload for the `purge-account` job (see producers.ts PurgeAccountJob). */
export interface PurgeAccountJob {
  userId: string;
  requestedAt: string;
}
