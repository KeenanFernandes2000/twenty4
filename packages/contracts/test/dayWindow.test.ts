/**
 * Day-window resolver vectors (§6 Q3) — the spec example + DST transitions +
 * negative-offset tz + UTC. The bucket is a `YYYY-MM-DD` calendar date under the
 * 4am→4am window in the DEVICE timezone at the instant.
 *
 * These run as pure unit tests (no infra): `resolveDayBucket` is deterministic.
 * The Intl-based wall-clock resolution is inherently DST-correct, so the DST
 * vectors below assert real spring-forward / fall-back behavior, not a fixed
 * `utc - 4h` offset (which would be WRONG across a transition).
 */
import { describe, it, expect } from 'vitest';
import { resolveDayBucket, isInDayBucket } from '../src/dayWindow.js';

describe('resolveDayBucket — §6 Q3 4am→4am day window', () => {
  /* -------------------------------------------------------------------------- */
  /*  THE SPEC VECTOR                                                            */
  /* -------------------------------------------------------------------------- */

  it('spec vector: 01:30 local on the 12th → bucket = the 11th', () => {
    // 01:30 on the 12th in New York. EST (UTC-5) in January → 06:30 UTC.
    // Local hour 1 < 4 → still "yesterday" → bucket 2026-01-11.
    const atUtc = new Date('2026-01-12T06:30:00Z');
    expect(resolveDayBucket(atUtc, 'America/New_York')).toBe('2026-01-11');
  });

  it('04:00 local exactly → rolls into the NEW day (boundary is inclusive of 4am)', () => {
    // 04:00 on the 12th, NY EST (UTC-5) → 09:00 UTC. Hour 4 is NOT < 4 → today.
    const atUtc = new Date('2026-01-12T09:00:00Z');
    expect(resolveDayBucket(atUtc, 'America/New_York')).toBe('2026-01-12');
  });

  it('03:59 local → still the previous day', () => {
    const atUtc = new Date('2026-01-12T08:59:00Z'); // 03:59 NY EST
    expect(resolveDayBucket(atUtc, 'America/New_York')).toBe('2026-01-11');
  });

  it('noon local → same calendar day', () => {
    const atUtc = new Date('2026-01-12T17:00:00Z'); // 12:00 NY EST
    expect(resolveDayBucket(atUtc, 'America/New_York')).toBe('2026-01-12');
  });

  it('23:30 local → same calendar day (well after rollover)', () => {
    const atUtc = new Date('2026-01-13T04:30:00Z'); // 23:30 NY on the 12th EST
    expect(resolveDayBucket(atUtc, 'America/New_York')).toBe('2026-01-12');
  });

  /* -------------------------------------------------------------------------- */
  /*  UTC (offset-0 reference)                                                   */
  /* -------------------------------------------------------------------------- */

  it('UTC: 01:30 UTC on the 12th → bucket 11th', () => {
    expect(resolveDayBucket(new Date('2026-06-12T01:30:00Z'), 'UTC')).toBe(
      '2026-06-11',
    );
  });

  it('UTC: 04:00 UTC on the 12th → bucket 12th', () => {
    expect(resolveDayBucket(new Date('2026-06-12T04:00:00Z'), 'UTC')).toBe(
      '2026-06-12',
    );
  });

  it('UTC: 03:59:59 → 11th; 00:00 → 11th', () => {
    expect(resolveDayBucket(new Date('2026-06-12T03:59:59Z'), 'UTC')).toBe(
      '2026-06-11',
    );
    expect(resolveDayBucket(new Date('2026-06-12T00:00:00Z'), 'UTC')).toBe(
      '2026-06-11',
    );
  });

  /* -------------------------------------------------------------------------- */
  /*  POSITIVE-OFFSET tz with a fractional offset (Asia/Kolkata, +5:30)          */
  /* -------------------------------------------------------------------------- */

  it('Asia/Kolkata (+5:30): 01:30 IST → previous day', () => {
    // 01:30 IST on the 12th = 20:00 UTC on the 11th. Local hour 1 < 4 → 11th.
    const atUtc = new Date('2026-06-11T20:00:00Z');
    expect(resolveDayBucket(atUtc, 'Asia/Kolkata')).toBe('2026-06-11');
  });

  it('Asia/Kolkata (+5:30): 09:00 IST → same day', () => {
    // 09:00 IST on the 12th = 03:30 UTC on the 12th. Local hour 9 ≥ 4 → 12th.
    const atUtc = new Date('2026-06-12T03:30:00Z');
    expect(resolveDayBucket(atUtc, 'Asia/Kolkata')).toBe('2026-06-12');
  });

  /* -------------------------------------------------------------------------- */
  /*  NEGATIVE-OFFSET tz (Pacific/Honolulu, -10, no DST)                         */
  /* -------------------------------------------------------------------------- */

  it('Pacific/Honolulu (-10): 02:00 HST → previous day; 04:00 → same day', () => {
    // 02:00 HST on the 12th = 12:00 UTC on the 12th. Hour 2 < 4 → 11th.
    expect(
      resolveDayBucket(new Date('2026-06-12T12:00:00Z'), 'Pacific/Honolulu'),
    ).toBe('2026-06-11');
    // 04:00 HST on the 12th = 14:00 UTC on the 12th. Hour 4 ≥ 4 → 12th.
    expect(
      resolveDayBucket(new Date('2026-06-12T14:00:00Z'), 'Pacific/Honolulu'),
    ).toBe('2026-06-12');
  });

  it('negative-offset day-edge: 23:59 local stays on the same calendar day', () => {
    // 23:59 HST on the 12th = 09:59 UTC on the 13th.
    expect(
      resolveDayBucket(new Date('2026-06-13T09:59:00Z'), 'Pacific/Honolulu'),
    ).toBe('2026-06-12');
  });

  /* -------------------------------------------------------------------------- */
  /*  DST: SPRING-FORWARD (US, 2026-03-08 — clocks jump 02:00 → 03:00)           */
  /* -------------------------------------------------------------------------- */

  it('spring-forward: 01:30 local before the gap → previous day (still EST)', () => {
    // 2026-03-08 the US springs forward at 02:00 (EST UTC-5 → EDT UTC-4).
    // 01:30 EST = 06:30 UTC. Hour 1 < 4 → 2026-03-07.
    expect(
      resolveDayBucket(new Date('2026-03-08T06:30:00Z'), 'America/New_York'),
    ).toBe('2026-03-07');
  });

  it('spring-forward: 03:30 local after the gap → same day, NOT shifted by the lost hour', () => {
    // After the jump it's EDT (UTC-4). 03:30 EDT = 07:30 UTC. The wall clock reads
    // 03:30 (NOT 02:30) — the 02:00–03:00 hour does not exist. Hour 3 < 4 → 03-07.
    expect(
      resolveDayBucket(new Date('2026-03-08T07:30:00Z'), 'America/New_York'),
    ).toBe('2026-03-07');
  });

  it('spring-forward: 04:00 EDT exactly → rolls to the new day', () => {
    // 04:00 EDT = 08:00 UTC. Hour 4 ≥ 4 → 2026-03-08.
    expect(
      resolveDayBucket(new Date('2026-03-08T08:00:00Z'), 'America/New_York'),
    ).toBe('2026-03-08');
  });

  /* -------------------------------------------------------------------------- */
  /*  DST: FALL-BACK (US, 2026-11-01 — clocks fall 02:00 EDT → 01:00 EST)         */
  /* -------------------------------------------------------------------------- */

  it('fall-back: first 01:30 (EDT) → previous day', () => {
    // 2026-11-01 the US falls back at 02:00 EDT → 01:00 EST. The 01:30 wall clock
    // happens TWICE. First occurrence is EDT (UTC-4): 01:30 EDT = 05:30 UTC.
    // Hour 1 < 4 → 2026-10-31.
    expect(
      resolveDayBucket(new Date('2026-11-01T05:30:00Z'), 'America/New_York'),
    ).toBe('2026-10-31');
  });

  it('fall-back: second 01:30 (EST) → previous day (the repeated hour stays "yesterday")', () => {
    // Second occurrence is EST (UTC-5): 01:30 EST = 06:30 UTC. Still hour 1 < 4.
    expect(
      resolveDayBucket(new Date('2026-11-01T06:30:00Z'), 'America/New_York'),
    ).toBe('2026-10-31');
  });

  it('fall-back: 04:00 EST → rolls to the new day', () => {
    // 04:00 EST = 09:00 UTC. Hour 4 ≥ 4 → 2026-11-01.
    expect(
      resolveDayBucket(new Date('2026-11-01T09:00:00Z'), 'America/New_York'),
    ).toBe('2026-11-01');
  });

  /* -------------------------------------------------------------------------- */
  /*  configurable offset + isInDayBucket guard                                  */
  /* -------------------------------------------------------------------------- */

  it('offsetHours=0 reduces to plain local calendar day (midnight rollover)', () => {
    // With offset 0, 01:30 local belongs to the SAME calendar day.
    expect(resolveDayBucket(new Date('2026-06-12T01:30:00Z'), 'UTC', 0)).toBe(
      '2026-06-12',
    );
  });

  it('isInDayBucket agrees with resolveDayBucket', () => {
    const at = new Date('2026-01-12T06:30:00Z'); // 01:30 NY → 01-11
    expect(isInDayBucket(at, '2026-01-11', 'America/New_York')).toBe(true);
    expect(isInDayBucket(at, '2026-01-12', 'America/New_York')).toBe(false);
  });

  it('month/year rollover at the boundary works (Jan 1 03:00 → previous Dec 31)', () => {
    // 03:00 NY EST on 2026-01-01 = 08:00 UTC. Hour 3 < 4 → 2025-12-31.
    expect(
      resolveDayBucket(new Date('2026-01-01T08:00:00Z'), 'America/New_York'),
    ).toBe('2025-12-31');
  });

  it('throws on an invalid timezone', () => {
    expect(() => resolveDayBucket(new Date(), 'Not/AZone')).toThrow();
  });

  it('throws on an invalid date', () => {
    expect(() => resolveDayBucket(new Date('nope'), 'UTC')).toThrow();
  });
});
