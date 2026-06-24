// Real CORS preflight — MUST use a real socket (fastify.listen + real fetch).
// inject does NOT issue a true preflight, which is exactly how the v1 CORS bug
// (PATCH/PUT/DELETE rejected) slipped through. We bind an ephemeral port and
// issue genuine OPTIONS preflights.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { request } from "undici";
import { makeApp, makeDb } from "./helpers.ts";
import type { DbClient } from "../src/db.ts";

let app: FastifyInstance;
let db: DbClient;
let base: string;

beforeAll(async () => {
  db = makeDb();
  app = await makeApp(db);
  // Ephemeral port on loopback — a real listening socket.
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no socket address");
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
  await db.sql.end({ timeout: 5 });
});

for (const method of ["PATCH", "PUT", "DELETE"] as const) {
  test(`OPTIONS preflight for ${method} succeeds with Allow-Methods incl. ${method}`, async () => {
    const res = await request(`${base}/_echo`, {
      method: "OPTIONS",
      headers: {
        origin: "http://192.168.1.50:8081",
        "access-control-request-method": method,
        "access-control-request-headers": "content-type,authorization",
      },
    });
    // Preflight must succeed (204 or 200), never be rejected.
    expect([200, 204]).toContain(res.statusCode);

    const allowMethods = (res.headers["access-control-allow-methods"] as string) ?? "";
    expect(allowMethods.toUpperCase()).toContain(method);
    // The full explicit set should be present.
    for (const m of ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"]) {
      expect(allowMethods.toUpperCase()).toContain(m);
    }

    // Origin reflected (dev-permissive policy).
    const allowOrigin = res.headers["access-control-allow-origin"];
    expect(allowOrigin).toBeDefined();

    // allowed headers reflect content-type + authorization.
    const allowHeaders = ((res.headers["access-control-allow-headers"] as string) ?? "").toLowerCase();
    expect(allowHeaders).toContain("content-type");
    expect(allowHeaders).toContain("authorization");
  });
}

test("real POST over the socket with no content-type → not 415", async () => {
  const res = await request(`${base}/_echo`, {
    method: "POST",
    body: JSON.stringify({ ping: "device" }),
    // Deliberately omit content-type to mimic an RN/Expo fetch.
    headers: {},
  });
  expect(res.statusCode).not.toBe(415);
  expect(res.statusCode).toBe(200);
  const json = (await res.body.json()) as { echoed: unknown };
  expect(json.echoed).toEqual({ ping: "device" });
});
