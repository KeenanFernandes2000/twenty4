/**
 * montage module (§8 montages) — routes filled in Slice 5 (generate → review →
 * publish, replace/republish). Registered-but-empty in Slice 0.
 */
import type { FastifyPluginAsync } from 'fastify';

export const montageModule: FastifyPluginAsync = async (_app) => {
  // TODO(slice 5): POST /montages (enqueue), poll status, theme/music, publish,
  // replace (idempotency-guarded).
};
