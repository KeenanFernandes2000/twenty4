/**
 * feed module (§8 feed) — routes filled in Slice 6 (GET /feed: cursor-paged,
 * member groups, block-filtered). Registered-but-empty in Slice 0.
 */
import type { FastifyPluginAsync } from 'fastify';

export const feedModule: FastifyPluginAsync = async (_app) => {
  // TODO(slice 6): GET /feed (cursor, active memberships, both-direction blocks).
};
