import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';

/**
 * Regression: @fastify/cors v11 defaults `Access-Control-Allow-Methods` to
 * `GET,HEAD,POST` only, so a browser PATCH/PUT/DELETE preflight is rejected
 * (e.g. PATCH /users/me from the Expo web app). The in-process integration
 * tests use app.inject and never issue a real preflight, so this guards it.
 */
describe('CORS preflight', () => {
  it('allows PATCH/PUT/DELETE for a browser origin', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/users/me',
        headers: {
          origin: 'http://localhost:8081',
          'access-control-request-method': 'PATCH',
          'access-control-request-headers': 'content-type,authorization',
        },
      });
      expect(res.statusCode).toBe(204);
      const allow = String(res.headers['access-control-allow-methods'] ?? '').toUpperCase();
      for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(allow, `Allow-Methods should include ${m}`).toContain(m);
      }
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8081');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    } finally {
      await app.close();
    }
  });
});
