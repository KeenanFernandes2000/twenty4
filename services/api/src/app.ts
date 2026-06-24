// buildApp() — the testable Fastify factory for @twenty4/api.
// Wires: root '*' content-type parser, CORS (explicit methods), rate-limit
// scaffold (global-disabled), pino request logging w/ redaction, the global
// error envelope handler + not-found handler, and the health/readiness/echo
// routes. The DB client is injected so tests/boot share one pool.
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError, NotFoundError, toErrorEnvelope, type Env, type ErrorEnvelope } from "@twenty4/contracts";
import { registerAuth } from "./auth/index.ts";
import { registerGroups } from "./groups/index.ts";
import { registerMedia } from "./media/index.ts";
import type { DbClient } from "./db.ts";
import type { RedisClient } from "./redis.ts";

export interface BuildAppOptions {
  db: DbClient;
  // NODE_ENV — gates the dev-permissive CORS origin policy.
  nodeEnv?: string;
  // Redis + env enable the M2 auth subsystem. When omitted (M1-only tests), the
  // /auth + /users routes are simply not registered.
  redis?: RedisClient;
  env?: Env;
  // M4: optional injected validate-media queue (tests share/inspect one). When
  // omitted, registerMedia creates a queue from REDIS_URL.
  mediaQueue?: import("bullmq").Queue<import("./media/queue.ts").ValidateMediaJobData>;
}

// Explicit CORS method list. v1's bug: @fastify/cors defaults to GET/HEAD/POST,
// silently rejecting every PATCH/PUT/DELETE preflight. We list them explicitly.
const CORS_METHODS = ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"];

// Echo body schema for the test/echo route's Zod-validation path.
const echoSchema = z.object({ ping: z.string() }).passthrough();

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { db } = opts;
  const isProd = (opts.nodeEnv ?? process.env.NODE_ENV) === "production";

  const app = Fastify({
    // trustProxy: correct client IP behind the dev proxy / Tailscale (single hop).
    trustProxy: true,
    // pino request logging: method/path/status/latency come from Fastify's
    // default serializers; redact auth + cookie headers from logs.
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
        ],
        censor: "[REDACTED]",
      },
    },
    // Disable Fastify's default 404 so our envelope not-found handler always wins.
    disableRequestLogging: false,
  });

  // ── Normalize an empty content-type to absent ──────────────────────────────
  // An RN/Expo fetch can send a body with the Content-Type header present-but-
  // EMPTY (""). Fastify treats present-but-empty differently from absent and
  // raises "Unsupported Media Type" before the '*' parser can run. Strip an empty
  // header so the catch-all parser below always applies → never a spurious 415.
  app.addHook("onRequest", async (req) => {
    const ct = req.headers["content-type"];
    if (typeof ct === "string" && ct.trim().length === 0) {
      delete req.headers["content-type"];
    }
  });

  // ── Root '*' content-type parser (the v1 §5 415 bug pre-empt) ──────────────
  // Fastify's default parser only handles application/json + text/plain. RN/Expo
  // fetch often sends a body with a missing or application/octet-stream content
  // type → spurious 415 BEFORE the route runs. Parse everything as a string and
  // try JSON.parse; fall back to the raw string so the request reaches the route
  // and gets a clean 200/401/422 — never a 415.
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => {
    const raw = body as string;
    if (raw === undefined || raw === null || raw.length === 0) {
      // Empty body → undefined so routes see no payload (no spurious parse error).
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch {
      // Non-JSON body: hand the route the raw string rather than erroring out.
      done(null, raw);
    }
  });

  // ── CORS — explicit methods incl. PATCH/PUT/DELETE/OPTIONS ─────────────────
  // Dev: permissive origin (reflect any origin) so LAN/Tailscale device origins
  // work. Tighten to an allow-list at launch (M15). Method list is always explicit.
  await app.register(cors, {
    origin: isProd ? false : true,
    methods: CORS_METHODS,
    allowedHeaders: ["content-type", "authorization"],
    credentials: true,
  });

  // ── Rate-limit scaffold — registered GLOBAL-DISABLED (opt-in per route later) ─
  await app.register(rateLimit, {
    global: false,
    max: 100,
    timeWindow: "1 minute",
  });

  // ── Global error handler → { error: { code, status, message } } envelope ───
  app.setErrorHandler((err, req, reply) => {
    // AppError → its own code/status (the contracts taxonomy).
    if (err instanceof AppError) {
      reply.status(err.status).send(err.toEnvelope());
      return;
    }

    // Zod errors → VALIDATION_FAILED/422.
    if (err instanceof z.ZodError) {
      const message = err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      const env: ErrorEnvelope = toErrorEnvelope("VALIDATION_FAILED", message || "Validation failed");
      reply.status(env.error.status).send(env);
      return;
    }

    const e = err as { validation?: unknown; statusCode?: number; message?: string };

    // Fastify-native validation errors (schema) → VALIDATION_FAILED/422.
    if (e.validation) {
      const env = toErrorEnvelope("VALIDATION_FAILED", e.message || "Validation failed");
      reply.status(env.error.status).send(env);
      return;
    }

    // @fastify/rate-limit throws a 429 with statusCode set.
    if (e.statusCode === 429) {
      const env = toErrorEnvelope("RATE_LIMITED", "Too many requests");
      reply.status(env.error.status).send(env);
      return;
    }

    // Respect an explicit 4xx statusCode (e.g. malformed JSON Fastify raises as 400,
    // present-but-empty/unsupported content-type raises 415) → VALIDATION_FAILED/422.
    if (typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500) {
      const env = toErrorEnvelope("VALIDATION_FAILED", e.message || "Bad request");
      reply.status(env.error.status).send(env);
      return;
    }

    // Unknown → INTERNAL/500. Log the real error; NEVER leak it on the wire.
    req.log.error({ err }, "unhandled error");
    const env = toErrorEnvelope("INTERNAL", "Internal server error");
    reply.status(env.error.status).send(env);
  });

  // ── Not-found handler → NOT_FOUND/404 envelope ─────────────────────────────
  app.setNotFoundHandler((req, reply) => {
    const err = new NotFoundError(`Route ${req.method} ${req.url} not found`);
    reply.status(err.status).send(err.toEnvelope());
  });

  // ── Routes ─────────────────────────────────────────────────────────────────

  // Liveness: process is up.
  app.get("/health", async () => {
    return { status: "ok" };
  });

  // Readiness: DB reachable (SELECT 1) → 200, else 503 in the envelope.
  app.get("/healthz", async (_req, reply) => {
    try {
      await db.db.execute(sql`select 1`);
      return { status: "ok", db: "up" };
    } catch (err) {
      _req.log.error({ err }, "readiness DB check failed");
      reply.status(503).send(toErrorEnvelope("INTERNAL", "Database unreachable", 503));
      return reply;
    }
  });

  // Test/echo POST target — gives the content-type regression + device-acceptance
  // POST a non-415 destination. If ?validate is set, runs the Zod path (422 on bad
  // body) so the error-envelope validation test has a target.
  app.post("/_echo", async (req) => {
    const q = req.query as { validate?: string };
    if (q.validate !== undefined) {
      // Throws ZodError on a bad body → handled as VALIDATION_FAILED/422.
      const parsed = echoSchema.parse(req.body);
      return { echoed: parsed, validated: true };
    }
    return { echoed: req.body ?? null };
  });

  // ── M2 auth subsystem (/auth + /users) ─────────────────────────────────────
  // Registered only when redis + env are provided (M1-only tests skip it).
  if (opts.redis && opts.env) {
    const { auth } = await registerAuth(app, { db, redis: opts.redis, env: opts.env });
    // ── M3 groups subsystem (/groups + /invites) — reuses the BA auth instance
    // for requireSession. Registered only alongside auth (M1-only tests skip it).
    await registerGroups(app, { db, redis: opts.redis, env: opts.env, auth });
    // ── M4 media subsystem (/media) — reuses the BA auth instance + S3 + the
    // validate-media queue. Registered only alongside auth.
    await registerMedia(app, { db, env: opts.env, auth, queue: opts.mediaQueue });
  }

  return app;
}
