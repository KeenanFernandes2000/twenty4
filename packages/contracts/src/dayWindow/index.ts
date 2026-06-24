// 4am→4am day-window logic (M4 §6 / A10) — DST-correct via Intl.
//
// twenty4's "day" runs 04:00 → 04:00 in the DEVICE-LOCAL timezone. A capture at
// 03:59 local belongs to the PREVIOUS calendar day's bucket; 04:01 to the current.
// The bucket is a calendar DATE string (YYYY-MM-DD) persisted on the media row at
// init and NEVER recomputed at read.
//
// Correctness requirements:
//  - DST-correct: we derive the local wall-clock date/time via Intl
//    (`Intl.DateTimeFormat` with the IANA tz) rather than fixed UTC offset math, so
//    a capture near a DST transition lands in the right bucket.
//  - Deterministic: same (instant, tz) → same bucket, regardless of server tz.

/** The hour (local) the day rolls over. 04:00 → 04:00. */
export const DAY_BUCKET_ROLLOVER_HOUR = 4;

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
}

// Extract local wall-clock parts for `instant` in IANA `tz` using Intl.
// Using `en-CA` gives ISO-ish YYYY-MM-DD ordering, but we read named parts to be safe.
function localParts(instant: Date, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(instant);
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new Error(`Intl part ${type} missing for tz ${tz}`);
    return Number(p.value);
  };
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") };
}

// Format a (year, month, day) as a YYYY-MM-DD string (zero-padded).
function ymd(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

// Subtract one calendar day from a (year, month, day), handling month/year rollover.
// We anchor on a UTC Date purely for the date arithmetic (no tz involved here — the
// inputs are already the local wall-clock Y/M/D), then read it back.
function subtractOneDay(year: number, month: number, day: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() - 1);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Resolve the 4am→4am day-bucket (a YYYY-MM-DD DATE string) for `instant` as
 * observed in IANA timezone `tz`. A wall-clock time before 04:00 local belongs to
 * the previous calendar day's bucket.
 *
 * @param instant  the capture/upload instant (a JS Date / epoch).
 * @param tz       an IANA timezone id (e.g. "America/New_York"). Validated by Intl.
 */
export function resolveDayBucket(instant: Date, tz: string): string {
  // localParts throws a RangeError on an invalid tz via Intl — surface it.
  const { year, month, day, hour } = localParts(instant, tz);
  if (hour < DAY_BUCKET_ROLLOVER_HOUR) {
    const prev = subtractOneDay(year, month, day);
    return ymd(prev.year, prev.month, prev.day);
  }
  return ymd(year, month, day);
}

/**
 * Validate that an IANA timezone string is understood by the runtime's Intl. Used
 * by the init DTO to reject a bogus deviceTimezone early.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
