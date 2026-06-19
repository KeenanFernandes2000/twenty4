/**
 * The 4am→4am day-window resolver (§6 Q3) — THE SPINE for the deletion promise.
 *
 * A media item belongs to `day_bucket` = the local calendar day under a
 * **4:00 AM → 4:00 AM** window in the **device timezone at capture/upload time**.
 * Example (spec vector): a clip captured at 1:30 AM local on the 12th belongs to
 * `day_bucket = the 11th` (it's still "yesterday" until 4am).
 *
 * This is the SINGLE SOURCE of the algorithm: the API resolves it authoritatively
 * at write time, and the mobile client imports the SAME function to mirror it (the
 * plan's "client mirror" is satisfied by importing this — there is no second copy
 * to drift). The resolved bucket is PERSISTED on `daily_media_item.day_bucket` and
 * is NEVER recomputed from UTC at read time.
 *
 * ## Algorithm
 *   1. Take the UTC instant `atUtc`.
 *   2. Express it as a wall-clock date+time in `deviceTz` (DST-correct, via Intl).
 *   3. Subtract `offsetHours` (default 4) from that wall clock.
 *   4. Floor to the calendar date → `YYYY-MM-DD`.
 *
 * ## DST safety
 * We do NOT do naive `utc - 4h` arithmetic on a fixed offset; the device's offset
 * from UTC changes across DST transitions. Instead we resolve the *wall clock* in
 * the device tz at the instant (via `Intl.DateTimeFormat` with `timeZone`), which
 * is inherently DST-correct, then do the 4h shift + floor on that wall clock. So
 * for any instant, the bucket reflects what the clock on the wall actually read,
 * minus 4h. This is verified with spring-forward / fall-back vectors in the tests.
 *
 * No heavy tz library is added — `Intl` (built into Node 22 / Hermes / browsers)
 * already carries the IANA tz database.
 */

/** Default day-window offset: the local day rolls over at 4:00 AM. */
export const DEFAULT_DAY_WINDOW_OFFSET_HOURS = 4;

/** Parsed wall-clock fields (in some timezone) for an instant. */
interface WallClock {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

/**
 * Resolve the wall-clock date/time that `atUtc` reads as in `timeZone`, using the
 * IANA tz database via Intl (DST-correct). Returns numeric fields, not strings.
 *
 * `hourCycle: 'h23'` forces 0-23 hours (avoids the `24:xx` midnight quirk some
 * engines emit with `hour12: false`).
 */
function wallClockInZone(atUtc: Date, timeZone: string): WallClock {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(atUtc);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : NaN;
  };
  let hour = get('hour');
  // Defensive: some engines still emit hour `24` for midnight under h23.
  if (hour === 24) hour = 0;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Zero-pad a number to a fixed width (no locale, no deps). */
function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/**
 * Convert a wall-clock calendar day (Y/M/D) to a `YYYY-MM-DD` string, applying a
 * whole-day delta. We do the date math in UTC purely as a *calendar* calculator
 * (no tz semantics): `Date.UTC` correctly rolls months/years and handles the
 * delta, then we read the UTC fields back out. This never touches a real timezone,
 * so there's no DST interaction here — it's pure Gregorian arithmetic.
 */
function shiftCalendarDate(
  year: number,
  month: number,
  day: number,
  deltaDays: number,
): string {
  const ms = Date.UTC(year, month - 1, day + deltaDays);
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate(),
  )}`;
}

/**
 * Resolve the `day_bucket` (a `YYYY-MM-DD` calendar date) for an instant under the
 * 4am→4am window in a device timezone.
 *
 * @param atUtc       The instant (capture/upload time) as a JS `Date` (UTC under
 *                    the hood; tz-agnostic).
 * @param deviceTz    The device IANA timezone at capture/upload, e.g.
 *                    `America/New_York`, `Asia/Kolkata`, `UTC`. Invalid zones
 *                    throw (Intl `RangeError`) — callers should validate/ fall
 *                    back to a sane default (the API uses `UTC` if absent).
 * @param offsetHours The hour the local day rolls over (default 4 → 4:00 AM).
 * @returns           The persisted bucket string, e.g. `'2026-06-11'`.
 */
export function resolveDayBucket(
  atUtc: Date,
  deviceTz: string,
  offsetHours: number = DEFAULT_DAY_WINDOW_OFFSET_HOURS,
): string {
  if (!(atUtc instanceof Date) || Number.isNaN(atUtc.getTime())) {
    throw new TypeError('resolveDayBucket: atUtc must be a valid Date');
  }

  // 1+2: the device-local wall clock at this instant (DST-correct via Intl).
  const wall = wallClockInZone(atUtc, deviceTz);

  // 3+4: subtract the offset, then floor to a calendar date. We only need to know
  // whether the local hour is BEFORE the rollover hour: if it is, the item still
  // belongs to the PREVIOUS calendar day. (Hours/minutes finer than the boundary
  // don't change the date floor — only the day rolls.)
  //
  // Equivalent to flooring `wallClock - offsetHours` to a date: any local time in
  // `[00:00, offset:00)` maps to the previous day; `[offset:00, 24:00)` to today.
  const beforeRollover = wall.hour < offsetHours;
  const deltaDays = beforeRollover ? -1 : 0;

  return shiftCalendarDate(wall.year, wall.month, wall.day, deltaDays);
}

/**
 * Convenience guard: is `atUtc` in the SAME bucket as `bucket` for `deviceTz`?
 * Used by the validation job (resolved capture time must fall in the row's bucket)
 * and by clients that want to check "is this still today?".
 */
export function isInDayBucket(
  atUtc: Date,
  bucket: string,
  deviceTz: string,
  offsetHours: number = DEFAULT_DAY_WINDOW_OFFSET_HOURS,
): boolean {
  return resolveDayBucket(atUtc, deviceTz, offsetHours) === bucket;
}

/** A tz-LESS wall clock (e.g. EXIF DateTimeOriginal `YYYY:MM:DD HH:MM:SS`). */
export interface WallClockFields {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

/**
 * Convert a tz-LESS wall clock to a UTC `Date`, interpreting it as local time in
 * `timeZone` (DST-correct, via Intl) — NOT in the server process tz.
 *
 * ## Why this exists
 * EXIF `DateTimeOriginal` (and many container `creation_time`s) are tz-less wall
 * clocks: "14:30:00" with no offset. A naive `new Date("2026-06-19T14:30:00")`
 * (or exifr's auto-revived Date) interprets that string in the SERVER process tz,
 * so the resulting UTC instant — and therefore the resolved day bucket — would
 * SHIFT with the server's `TZ`. That makes the "is this today?" verdict
 * non-deterministic across deploys. We instead anchor the wall clock to the
 * capturing device's tz, which is stable and correct.
 *
 * ## Algorithm
 * There's no built-in "wall clock in zone → UTC". We invert `wallClockInZone`:
 *   1. Guess the instant as if the wall clock were UTC.
 *   2. See what wall clock that guess actually reads as in `timeZone`.
 *   3. The difference between (1) and (2) is the zone's offset at that instant;
 *      subtract it to land on the true UTC instant.
 *   4. One refinement pass handles DST boundaries (the offset can change between
 *      the guess and the corrected instant).
 *
 * Invalid zones throw (Intl `RangeError`) — callers should validate / fall back.
 */
export function zonedWallClockToUtc(
  wall: WallClockFields,
  timeZone: string,
): Date {
  // ms since epoch if the wall clock were literally UTC.
  const asUtcMs = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );

  // The offset of `timeZone` at a given instant = (wall clock there) − (that
  // instant as UTC). Compute it, then correct, then re-check once for DST edges.
  const offsetAt = (instantMs: number): number => {
    const w = wallClockInZone(new Date(instantMs), timeZone);
    const wallAsUtcMs = Date.UTC(
      w.year,
      w.month - 1,
      w.day,
      w.hour,
      w.minute,
      w.second,
    );
    return wallAsUtcMs - instantMs;
  };

  let utcMs = asUtcMs - offsetAt(asUtcMs);
  // Refine once: the offset at the corrected instant may differ across a DST jump.
  utcMs = asUtcMs - offsetAt(utcMs);
  return new Date(utcMs);
}
