/**
 * Fastify app factory.
 *
 * Wires cross-cutting concerns (request-id + logging, CORS, sensible) and a
 * single error handler that maps `@twenty4/contracts/errors` ApiError shapes —
 * and zod validation failures — into the standard `{ error }` envelope. Then
 * mounts the health routes and the per-resource modules under their prefixes.
 *
 * Returns the un-listened app so tests can `app.inject(...)` it directly.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { ApiError, errors as apiErrors } from '@twenty4/contracts/errors';

import { env } from './env.js';
import { healthRoutes } from './routes/health.js';
import { authModule } from './modules/auth/index.js';
import { betterAuthHandler } from './auth/handler.js';
import { usersModule } from './modules/users/index.js';
import { groupsModule } from './modules/groups/index.js';
import { mediaModule } from './modules/media/index.js';
import { montageModule } from './modules/montage/index.js';
import { feedModule } from './modules/feed/index.js';
import { socialModule } from './modules/social/index.js';
import { safetyModule } from './modules/safety/index.js';
import { adminModule } from './modules/admin/index.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Built-in request-id (header 'request-id' or generated) + structured logs.
    genReqId: (req) =>
      (req.headers['x-request-id'] as string | undefined) ??
      crypto.randomUUID(),
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'reqId',
    logger:
      env.NODE_ENV === 'test'
        ? false
        : {
            level: env.NODE_ENV === 'development' ? 'debug' : 'info',
          },
    // Trust proxy so client IPs / proto are correct behind ingress (rate limits later).
    trustProxy: true,
  });

  await app.register(cors, {
    origin: true, // reflect request origin; tighten per-env in a later slice.
    credentials: true,
  });
  await app.register(sensible);

  // Central error mapper → ApiError → `{ error }` envelope.
  app.setErrorHandler((err, req, reply) => {
    // 1) Our typed ApiError → its declared status + envelope.
    if (err instanceof ApiError) {
      reply.code(err.status).send(err.toEnvelope());
      return;
    }

    // 2) Zod validation failure → 422 with field issues as non-PII details.
    if (err instanceof ZodError) {
      const apiErr = apiErrors.validation('Request validation failed', {
        issues: err.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
      });
      reply.code(apiErr.status).send(apiErr.toEnvelope());
      return;
    }

    // 3) Fastify's own validation (schema-driven) → 422.
    if ((err as { validation?: unknown }).validation) {
      const apiErr = apiErrors.validation((err as Error).message, {
        validation: (err as { validation?: unknown }).validation,
      });
      reply.code(apiErr.status).send(apiErr.toEnvelope());
      return;
    }

    // 4) Fastify HTTP errors (e.g. from @fastify/sensible) carrying a statusCode.
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode < 500) {
      const code =
        statusCode === 401
          ? 'unauthorized'
          : statusCode === 403
            ? 'forbidden'
            : statusCode === 404
              ? 'not_found'
              : statusCode === 429
                ? 'rate_limited'
                : 'conflict';
      const mapped = new ApiError(code, (err as Error).message, undefined, statusCode);
      reply.code(mapped.status).send(mapped.toEnvelope());
      return;
    }

    // 5) Anything else → log + opaque 500 (never leak internals).
    req.log.error({ err }, 'unhandled error');
    const internal = apiErrors.internal('Internal server error');
    reply.code(internal.status).send(internal.toEnvelope());
  });

  // Unknown route → typed 404 envelope.
  app.setNotFoundHandler((req, reply) => {
    const nf = apiErrors.notFound(`Route ${req.method} ${req.url} not found`);
    reply.code(nf.status).send(nf.toEnvelope());
  });

  // --- Health (unprefixed) ---
  await app.register(healthRoutes);

  // --- Auth (Better Auth) ---
  // The twenty4 façade routes (/auth/start|verify|refresh|logout|dev/last-otp)
  // and Better Auth's own catch-all handler share the /auth prefix. They are
  // registered in the SAME encapsulated context so the façade's exact-path routes
  // take precedence over the handler's `/*` catch-all.
  await app.register(
    async (authScope) => {
      await authScope.register(authModule);
      await authScope.register(betterAuthHandler);
    },
    { prefix: '/auth' },
  );

  // --- Resource modules (filled in later slices) ---
  await app.register(usersModule, { prefix: '/users' });
  await app.register(groupsModule, { prefix: '/groups' });
  await app.register(mediaModule, { prefix: '/media' });
  await app.register(montageModule, { prefix: '/montages' });
  await app.register(feedModule, { prefix: '/feed' });
  await app.register(socialModule, { prefix: '/social' });
  await app.register(safetyModule, { prefix: '/safety' });
  await app.register(adminModule, { prefix: '/admin' });

  return app;
}
