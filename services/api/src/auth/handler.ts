/**
 * Mounts the Better Auth web handler into Fastify under /auth/*.
 *
 * Better Auth speaks the web Fetch API (`Request` → `Response`). We bridge by
 * building a web `Request` from the Fastify request and streaming the resulting
 * `Response` back. A catch-all route under the `/auth` prefix forwards every
 * method (GET/POST/...) to `auth.handler`.
 *
 * NOTE: this plugin owns ALL Better Auth's own endpoints (e.g.
 * /auth/sign-in/email-otp, /auth/email-otp/send-verification-otp, /auth/get-session,
 * /auth/sign-out, the OAuth callbacks). The twenty4 *façade* routes
 * (/auth/start|verify|refresh|logout|...) live in modules/auth and are registered
 * separately so they take precedence over the catch-all.
 */
import type { FastifyPluginAsync } from 'fastify';
import { auth } from './betterAuth.js';

export const betterAuthHandler: FastifyPluginAsync = async (app) => {
  // Disable Fastify's body parsing for these routes — Better Auth reads the raw
  // body itself from the web Request.
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/*',
    handler: async (req, reply) => {
      const url = new URL(
        req.url,
        `${req.protocol}://${req.headers.host ?? 'localhost'}`,
      );

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
        else headers.append(key, String(value));
      }

      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const body =
        hasBody && req.body != null
          ? Buffer.isBuffer(req.body)
            ? req.body
            : Buffer.from(
                typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
              )
          : undefined;

      const request = new Request(url.toString(), {
        method: req.method,
        headers,
        body,
      });

      const response = await auth.handler(request);

      reply.status(response.status);
      response.headers.forEach((value, key) => {
        // set-cookie may appear multiple times; Headers.forEach folds them, but
        // Fastify handles the folded value fine for our bearer-based flow.
        reply.header(key, value);
      });
      const buf = Buffer.from(await response.arrayBuffer());
      reply.send(buf);
    },
  });
};
