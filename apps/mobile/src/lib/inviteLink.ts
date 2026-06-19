/**
 * Invite deep-link helpers (single source for the `twenty4://invite/{code}`
 * scheme, mirroring the backend's `inviteDeepLink`). `inviteUrl` uses
 * expo-linking's `createURL` so it produces the right scheme on native (the
 * configured `twenty4://`) and an `https://host/--/invite/{code}` form on web —
 * either deep-links back into the join screen via the linking config.
 *
 * We keep a plain `customSchemeLink` too for the copy/share affordances so the
 * shared text is always the friendly `twenty4://invite/{code}` form.
 */
import * as Linking from 'expo-linking';

/** Canonical custom-scheme link, identical to the API's `deepLink`. */
export function customSchemeLink(code: string): string {
  return `twenty4://invite/${code}`;
}

/**
 * A link expo-router can resolve back to the join screen. On native this is the
 * `twenty4://` scheme; on web it's the dev/host URL with the `invite/{code}`
 * path. Falls back to the custom-scheme link if `createURL` is unavailable.
 */
export function inviteUrl(code: string): string {
  try {
    return Linking.createURL(`invite/${code}`);
  } catch {
    return customSchemeLink(code);
  }
}
