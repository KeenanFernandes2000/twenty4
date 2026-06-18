/**
 * users module (§8 users) — routes filled in Slice 3 (auth/onboarding) and
 * Slice 8 (DELETE /users/me purge). Registered-but-empty in Slice 0.
 */
import type { FastifyPluginAsync } from 'fastify';

export const usersModule: FastifyPluginAsync = async (_app) => {
  // TODO(slice 3): profile + account routes; (slice 8) account deletion/purge.
};
