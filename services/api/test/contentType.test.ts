import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';

/**
 * Regression: Fastify's default content-type parser only accepts
 * application/json + text/plain. A React Native / Expo fetch that posts a body
 * with a missing or non-JSON Content-Type (e.g. application/octet-stream) was
 * rejected with a blanket 415 *before* the body ever reached the route. The root
 * '*' fallback parser registered in src/app.ts now parses any other content-type
 * as a string (JSON-parsing it when possible), so a body-bearing request reaches
 * the route and is handled by auth/zod (401/422) instead of 415-ing up front.
 *
 * These tests use app.inject so they never hit a real network or storage; they
 * target POST /media (a body-bearing, session-gated route) and only assert the
 * status is NOT 415.
 */
describe('content-type fallback parser', () => {
  it('does NOT 415 a body-bearing request with a non-JSON Content-Type', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/media',
        headers: { 'content-type': 'application/octet-stream' },
        // A JSON *string* under a non-JSON content-type: the fallback parser
        // should JSON.parse it and let the request flow into the route.
        payload: JSON.stringify({ mediaType: 'photo', contentType: 'image/jpeg' }),
      });
      // Without the fallback parser this was a 415. With it, the request reaches
      // the route and is rejected by requireSession (401) — never 415.
      expect(res.statusCode).not.toBe(415);
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('does NOT 415 even when the non-JSON body is not valid JSON', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/media',
        headers: { 'content-type': 'application/octet-stream' },
        // Non-JSON payload: the parser falls through to the raw string and the
        // request still reaches the route (rejected by auth, not by a 415).
        payload: 'not-json-at-all',
      });
      expect(res.statusCode).not.toBe(415);
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('still handles a normal application/json request as before', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/media',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ mediaType: 'photo', contentType: 'image/jpeg' }),
      });
      // Same behaviour as the legacy path: parsed fine, gated by auth (401).
      expect(res.statusCode).not.toBe(415);
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
