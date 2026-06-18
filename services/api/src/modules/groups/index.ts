/**
 * groups module (§8 groups) — routes filled in Slice 4 (groups + invite/join).
 * Registered-but-empty in Slice 0.
 */
import type { FastifyPluginAsync } from 'fastify';

export const groupsModule: FastifyPluginAsync = async (_app) => {
  // TODO(slice 4): group CRUD, invites (expiry + use-cap), members, leave, join.
};
