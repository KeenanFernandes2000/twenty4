// Health, readiness, error-envelope, content-type regression — inject-based.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { errorEnvelopeSchema } from "@twenty4/contracts";
import { makeApp, makeDb } from "./helpers.ts";
import type { DbClient } from "../src/db.ts";

let app: FastifyInstance;
let db: DbClient;

beforeAll(async () => {
  db = makeDb();
  app = await makeApp(db);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.sql.end({ timeout: 5 });
});

test("GET /health → 200 {status:'ok'}", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: "ok" });
});

test("GET /healthz → 200 when DB up", async () => {
  const res = await app.inject({ method: "GET", url: "/healthz" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ status: "ok", db: "up" });
});

test("unknown route → NOT_FOUND/404 envelope (no leakage)", async () => {
  const res = await app.inject({ method: "GET", url: "/does-not-exist" });
  expect(res.statusCode).toBe(404);
  const body = res.json();
  expect(errorEnvelopeSchema.parse(body)).toBeDefined();
  expect(body.error.code).toBe("NOT_FOUND");
  expect(body.error.status).toBe(404);
  // No stack / internal leakage.
  expect(JSON.stringify(body)).not.toContain("stack");
});

test("Zod-invalid request → VALIDATION_FAILED/422 envelope", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/_echo?validate=1",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ notPing: true }),
  });
  expect(res.statusCode).toBe(422);
  const body = res.json();
  expect(errorEnvelopeSchema.parse(body)).toBeDefined();
  expect(body.error.code).toBe("VALIDATION_FAILED");
  expect(body.error.status).toBe(422);
});

// ── Content-type regression (the v1 §5 415 bug) ─────────────────────────────
// A POST body with missing / octet-stream / non-JSON content type must REACH the
// route and return a clean 200 — NEVER 415.
test("POST with NO content-type header → reaches route, not 415", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/_echo",
    payload: JSON.stringify({ ping: "x" }),
    // inject sets a default content-type; clear it to simulate a raw RN body.
    headers: { "content-type": "" },
  });
  expect(res.statusCode).not.toBe(415);
  expect(res.statusCode).toBe(200);
});

test("POST with application/octet-stream → reaches route, not 415", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/_echo",
    headers: { "content-type": "application/octet-stream" },
    payload: JSON.stringify({ ping: "x" }),
  });
  expect(res.statusCode).not.toBe(415);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ echoed: { ping: "x" } });
});

test("POST with non-JSON body + weird content-type → reaches route as raw, not 415", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/_echo",
    headers: { "content-type": "text/yaml" },
    payload: "not: json: at: all",
  });
  expect(res.statusCode).not.toBe(415);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ echoed: "not: json: at: all" });
});
