/**
 * social module (§8 reactions/comments) — routes filled in Slice 6 (reactions,
 * comments, owner delete/download). Registered-but-empty in Slice 0.
 */
import type { FastifyPluginAsync } from 'fastify';

export const socialModule: FastifyPluginAsync = async (_app) => {
  // TODO(slice 6): reactions (optimistic), comments, owner delete + download-url.
};
