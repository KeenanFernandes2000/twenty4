/**
 * §7.5 gate — vitest smoke. Runs ONE quick variation (smaller pool) end-to-end
 * and asserts it PASSES. The full multi-variation run lives in the `harness`
 * script (`pnpm --filter @twenty4/worker run harness`); this keeps CI fast while
 * still proving the whole intelligence→render→probe path on real output.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGate } from '../src/validation/harness.js';

describe('§7.5 render gate (quick)', () => {
  it(
    'builds a beat-synced 30s EDL from scored fixtures and renders a passing 1080×1920 MP4',
    async () => {
      const outDir = await mkdtemp(path.join(tmpdir(), 'twenty4-gate-test-'));
      const { pass, results } = await runGate({ quick: true, outDir });

      // surface details on failure
      const r = results[0]!;
      if (!pass) {
        // eslint-disable-next-line no-console
        console.error('gate failures:', r.failures);
      }

      expect(results.length).toBe(1);
      expect(r.probe?.width).toBe(1080);
      expect(r.probe?.height).toBe(1920);
      expect(r.probe?.fps).toBe(30);
      expect(r.probe?.videoCodec).toBe('h264');
      expect(r.probe?.hasAudio).toBe(true);
      expect(Math.abs((r.probe?.durationMs ?? 0) - 30000)).toBeLessThanOrEqual(200);
      expect(r.maxBeatErrorMs ?? Infinity).toBeLessThanOrEqual(1000 / 30);
      expect(pass).toBe(true);
    },
    240_000,
  );
});
