/**
 * safety module (§8 reports/blocks) — routes filled in Slice 8 (reports, blocks,
 * suspended gate). Registered-but-empty in Slice 0.
 */
import type { FastifyPluginAsync } from 'fastify';

export const safetyModule: FastifyPluginAsync = async (_app) => {
  // TODO(slice 8): POST /reports, block/unblock, suspended/banned gating.
};
