/**
 * media module (§8 media) — routes filled in Slice 2 (capture + upload via
 * signed URLs, POST /media). Registered-but-empty in Slice 0.
 */
import type { FastifyPluginAsync } from 'fastify';

export const mediaModule: FastifyPluginAsync = async (_app) => {
  // TODO(slice 2): presigned upload + POST /media row creation + validation.
};
