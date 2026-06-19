/**
 * Local reminders (PLAN slice 9 / §2 "local reminders", spec §7 capture habit).
 *
 * Phase-1 notifications are LOCAL ONLY (no push server — APNs/FCM dispatch is
 * Phase-2). Two reminders:
 *   1. A daily "collect today's moments" CAPTURE reminder (repeating, evening) so
 *      the daily habit doesn't slip — the core BeReal-style loop.
 *   2. A one-shot "your montage expires soon" reminder, scheduled from a published
 *      montage's `expiryAt` (a nudge ~2h before the 24h hard-delete).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ WEB-SAFE: every entry point no-ops on web (`Platform.OS === 'web'`) and    │
 * │ lazily `import('expo-notifications')` INSIDE the handler so the module is   │
 * │ never pulled into the web bundle (matches the 1.6 priming screen). The     │
 * │ permission ask is POLITE — we never prompt blind; callers check            │
 * │ `getPermissionStatus()` and route to the 1.6 priming screen first.         │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Device-pending: ACTUAL notification DELIVERY (and exact-alarm behavior on
 * Android 13+) can only be verified on a physical device — the headless web/CI
 * harness can confirm the scheduling calls + the web no-op, not OS delivery.
 */
import { Platform } from 'react-native';

/** Stable identifiers so re-scheduling REPLACES rather than stacks duplicates. */
const CAPTURE_REMINDER_ID = 'twenty4.capture-daily';
const EXPIRY_REMINDER_PREFIX = 'twenty4.expiry.';

/** Default evening capture-reminder time (local). 8pm: after the day, before bed. */
const CAPTURE_HOUR = 20;
const CAPTURE_MINUTE = 0;

/** Lead time before a montage's 24h expiry to fire the "expiring soon" nudge. */
const EXPIRY_LEAD_MS = 2 * 60 * 60 * 1000; // 2h
/** iOS requires a repeating/scheduled local notification to be ≥ a few seconds out. */
const MIN_LEAD_MS = 60 * 1000; // 1 min

/** Web is a hard no-op for every reminder op. */
function isWeb(): boolean {
  return Platform.OS === 'web';
}

/** Lazy import keeps expo-notifications out of the web bundle. */
async function loadNotifications() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await import('expo-notifications')) as typeof import('expo-notifications');
}

/**
 * Current notification permission status WITHOUT prompting ('granted' |
 * 'denied' | 'undetermined'; 'unavailable' on web). Callers use this to decide
 * whether to route to the 1.6 priming screen before scheduling.
 */
export async function getPermissionStatus(): Promise<
  'granted' | 'denied' | 'undetermined' | 'unavailable'
> {
  if (isWeb()) return 'unavailable';
  try {
    const N = await loadNotifications();
    const { status } = await N.getPermissionsAsync();
    if (status === 'granted') return 'granted';
    if (status === 'denied') return 'denied';
    return 'undetermined';
  } catch {
    return 'unavailable';
  }
}

/**
 * Politely request notification permission (only call after the 1.6 priming
 * screen has set expectations). Returns whether it's now granted. No-op on web.
 */
export async function requestPermission(): Promise<boolean> {
  if (isWeb()) return false;
  try {
    const N = await loadNotifications();
    const existing = await N.getPermissionsAsync();
    if (existing.status === 'granted') return true;
    const { status } = await N.requestPermissionsAsync();
    return status === 'granted';
  } catch {
    return false;
  }
}

/**
 * Schedule (or re-schedule) the daily capture reminder. Idempotent: cancels any
 * existing one first so we never stack duplicates. No-ops on web / when
 * permission isn't granted (we don't silently prompt here).
 */
export async function scheduleCaptureReminder(opts?: {
  hour?: number;
  minute?: number;
}): Promise<boolean> {
  if (isWeb()) return false;
  try {
    const N = await loadNotifications();
    const perm = await N.getPermissionsAsync();
    if (perm.status !== 'granted') return false;

    await N.cancelScheduledNotificationAsync(CAPTURE_REMINDER_ID).catch(() => {});
    await N.scheduleNotificationAsync({
      identifier: CAPTURE_REMINDER_ID,
      content: {
        title: 'Today’s moments',
        body: 'Capture a few photos or clips before the day closes — your recap builds from them.',
        // No user content; a static habit nudge.
      },
      trigger: {
        type: N.SchedulableTriggerInputTypes.DAILY,
        hour: opts?.hour ?? CAPTURE_HOUR,
        minute: opts?.minute ?? CAPTURE_MINUTE,
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** Cancel the daily capture reminder (e.g. user toggles it off in 5.4). */
export async function cancelCaptureReminder(): Promise<void> {
  if (isWeb()) return;
  try {
    const N = await loadNotifications();
    await N.cancelScheduledNotificationAsync(CAPTURE_REMINDER_ID);
  } catch {
    /* best-effort */
  }
}

/**
 * Schedule a one-shot "your montage expires soon" reminder, EXPIRY_LEAD_MS before
 * the given `expiryAt`. Identified per-montage so re-publishing replaces it; a
 * past/too-soon lead time is skipped (returns false). No-op on web / ungranted.
 */
export async function scheduleExpiryReminder(args: {
  montageId: string;
  expiryAt: string | number | Date;
}): Promise<boolean> {
  if (isWeb()) return false;
  try {
    const N = await loadNotifications();
    const perm = await N.getPermissionsAsync();
    if (perm.status !== 'granted') return false;

    const expiryMs = new Date(args.expiryAt).getTime();
    if (!Number.isFinite(expiryMs)) return false;

    const fireMs = expiryMs - EXPIRY_LEAD_MS;
    const seconds = Math.round((fireMs - Date.now()) / 1000);
    // Too late to be useful (already inside the lead window or expired) → skip.
    if (fireMs - Date.now() < MIN_LEAD_MS) return false;

    const id = `${EXPIRY_REMINDER_PREFIX}${args.montageId}`;
    await N.cancelScheduledNotificationAsync(id).catch(() => {});
    await N.scheduleNotificationAsync({
      identifier: id,
      content: {
        title: 'Your recap is expiring',
        body: 'It disappears soon — watch it or save it to your device before it’s gone.',
        // montage id stays in code only (not surfaced as content) — no PII here.
      },
      trigger: {
        type: N.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds,
        repeats: false,
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** Cancel a montage's expiry reminder (e.g. it was deleted/replaced early). */
export async function cancelExpiryReminder(montageId: string): Promise<void> {
  if (isWeb()) return;
  try {
    const N = await loadNotifications();
    await N.cancelScheduledNotificationAsync(`${EXPIRY_REMINDER_PREFIX}${montageId}`);
  } catch {
    /* best-effort */
  }
}

/** Cancel every scheduled local reminder (e.g. on sign-out / disable-all). */
export async function cancelAllReminders(): Promise<void> {
  if (isWeb()) return;
  try {
    const N = await loadNotifications();
    await N.cancelAllScheduledNotificationsAsync();
  } catch {
    /* best-effort */
  }
}
