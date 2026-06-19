/**
 * dayClose — when does TODAY's bucket close? (the 4am rollover, §6 Q3).
 *
 * The Today screen shows a countdown to the next 4:00 AM in the device timezone —
 * the instant the current `day_bucket` closes and a new one opens. We compute the
 * next 4am as a real instant so the existing CountdownBadge (which ticks to a ms
 * epoch) can render it. DST-correct enough for a countdown: we find the device
 * wall-clock, then step to the next 04:00 boundary.
 */
import { DEFAULT_DAY_WINDOW_OFFSET_HOURS } from '@twenty4/contracts/dayWindow';

function deviceTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The current device-local wall-clock hour (0-23). */
function localHour(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  return h === 24 ? 0 : h;
}

/**
 * Next 4:00 AM (device tz) as a ms-epoch instant. If it's currently before 4am we
 * target today's 4am, else tomorrow's. Approximated via local-hour stepping from
 * `now`; precise to the minute, which is all a countdown needs.
 */
export function nextDayClose(now: Date = new Date(), offsetHours = DEFAULT_DAY_WINDOW_OFFSET_HOURS): number {
  const tz = deviceTz();
  const hour = localHour(now, tz);

  // Hours until the next rollover boundary (handles wrap past midnight).
  let hoursUntil = offsetHours - hour;
  if (hoursUntil <= 0) hoursUntil += 24;

  // Step forward whole hours, then floor to the top of that hour (minute/sec 0).
  const target = new Date(now.getTime() + hoursUntil * 3600_000);
  // Zero the minutes/seconds relative to the wall clock by snapping to the hour.
  const snapped = new Date(target);
  snapped.setMinutes(0, 0, 0);
  return snapped.getTime();
}
