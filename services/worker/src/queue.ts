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
