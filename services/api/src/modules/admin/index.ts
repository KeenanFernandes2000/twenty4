/**
 * admin module (§8 admin/ops) — routes filled in Slice 8 (search/suspend/ban,
 * review reports, remove content, failed jobs/metrics). Registered-but-empty
 * in Slice 0.
 */
import type { FastifyPluginAsync } from 'fastify';

export const adminModule: FastifyPluginAsync = async (_app) => {
  // TODO(slice 8): moderation + ops endpoints (admin-guarded).
};
