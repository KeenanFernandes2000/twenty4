// Day-window unit tests (M4 §7.8) — 4am→4am boundary across timezones + DST.
import { describe, expect, test } from "bun:test";
import { resolveDayBucket, isValidTimezone } from "./index.ts";

// Helper: build an instant from a local wall-clock time in a tz by brute-forcing
// the UTC instant whose Intl-rendered local time matches. Simpler: we pass a known
// UTC instant and assert the bucket, choosing UTC offsets we can reason about.

describe("resolveDayBucket — 4am boundary", () => {
  test("03:59 local maps to the PREVIOUS day's bucket", () => {
    // 2026-03-10 is after spring-forward → EDT (UTC-4). 03:59 EDT = 07:59 UTC.
    const instant = new Date("2026-03-10T07:59:00Z");
    expect(resolveDayBucket(instant, "America/New_York")).toBe("2026-03-09");
  });

  test("04:01 local maps to the CURRENT day's bucket", () => {
    // 2026-03-10 04:01 EDT (UTC-4) = 08:01 UTC.
    const instant = new Date("2026-03-10T08:01:00Z");
    expect(resolveDayBucket(instant, "America/New_York")).toBe("2026-03-10");
  });

  test("exactly 04:00 local is the current day (rollover is inclusive of >=4)", () => {
    const instant = new Date("2026-03-10T08:00:00Z"); // 04:00 EDT
    expect(resolveDayBucket(instant, "America/New_York")).toBe("2026-03-10");
  });
});

describe("resolveDayBucket — multiple timezones for one instant", () => {
  // A single UTC instant lands in different local buckets depending on tz.
  const instant = new Date("2026-06-15T05:30:00Z");
  test("UTC: 05:30 → 2026-06-15", () => {
    expect(resolveDayBucket(instant, "UTC")).toBe("2026-06-15");
  });
  test("America/New_York: 01:30 EDT → previous day 2026-06-14", () => {
    expect(resolveDayBucket(instant, "America/New_York")).toBe("2026-06-14");
  });
  test("Asia/Tokyo: 14:30 JST → 2026-06-15", () => {
    expect(resolveDayBucket(instant, "Asia/Tokyo")).toBe("2026-06-15");
  });
  test("Pacific/Kiritimati (+14): 19:30 → 2026-06-15", () => {
    expect(resolveDayBucket(instant, "Pacific/Kiritimati")).toBe("2026-06-15");
  });
});

describe("resolveDayBucket — across a DST transition (DST-correct via Intl)", () => {
  // US spring-forward 2026: clocks jump 02:00 → 03:00 on 2026-03-08 in NY.
  // Pick instants around the following 4am rollover to prove offset is derived
  // correctly (EDT = UTC-4 after the transition, vs EST = UTC-5 before).

  test("after spring-forward, 03:59 EDT → previous bucket", () => {
    // 2026-03-09 03:59 EDT (UTC-4) = 07:59 UTC.
    const instant = new Date("2026-03-09T07:59:00Z");
    expect(resolveDayBucket(instant, "America/New_York")).toBe("2026-03-08");
  });

  test("after spring-forward, 04:01 EDT → current bucket", () => {
    // 2026-03-09 04:01 EDT (UTC-4) = 08:01 UTC.
    const instant = new Date("2026-03-09T08:01:00Z");
    expect(resolveDayBucket(instant, "America/New_York")).toBe("2026-03-09");
  });

  test("a naive fixed -5 offset would mislabel this; Intl gets it right", () => {
    // 2026-03-09 04:30 EDT = 08:30 UTC. With a wrong EST(-5) assumption this would
    // read as 03:30 local → previous day. Intl yields 04:30 EDT → current day.
    const instant = new Date("2026-03-09T08:30:00Z");
    expect(resolveDayBucket(instant, "America/New_York")).toBe("2026-03-09");
  });

  // US fall-back 2026: clocks 02:00 → 01:00 on 2026-11-01 (EDT→EST).
  test("around fall-back, 04:01 EST → current bucket", () => {
    // 2026-11-01 04:01 EST (UTC-5) = 09:01 UTC.
    const instant = new Date("2026-11-01T09:01:00Z");
    expect(resolveDayBucket(instant, "America/New_York")).toBe("2026-11-01");
  });
});

describe("month/year rollover from the previous-day subtraction", () => {
  test("03:59 on the 1st of a month rolls to the last day of the previous month", () => {
    // 2026-04-01 03:59 EDT (UTC-4) = 07:59 UTC.
    const instant = new Date("2026-04-01T07:59:00Z");
    expect(resolveDayBucket(instant, "America/New_York")).toBe("2026-03-31");
  });
  test("03:59 on Jan 1 rolls to Dec 31 of the previous year", () => {
    // 2026-01-01 03:59 EST (UTC-5) = 08:59 UTC.
    const instant = new Date("2026-01-01T08:59:00Z");
    expect(resolveDayBucket(instant, "America/New_York")).toBe("2025-12-31");
  });
});

describe("isValidTimezone", () => {
  test("accepts a real IANA tz", () => {
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
  });
  test("rejects garbage", () => {
    expect(isValidTimezone("Not/AZone")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});
