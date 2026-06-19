/**
 * Deep-link entry: `twenty4://invite/{code}` (and the universal-link form
 * `https://<host>/invite/{code}`) resolve to this file-based route via
 * expo-router's automatic linking. We forward into the Groups → Join screen
 * (4.5) with the code prefilled.
 *
 * Why a redirect (not the join UI here): the join flow lives under the (main)
 * tabs and requires a session. The root AuthGate (app/_layout) gates (main); a
 * signed-out deep-link visitor is sent to (auth) first, and on sign-in the
 * stored intent isn't needed because the link reopens here. When signed in, we
 * immediately `Redirect` into the tabbed join screen carrying `?code=`.
 *
 * Web-safe and SSR-safe: a plain `<Redirect>` with no native imports.
 */
import { Redirect, useLocalSearchParams } from 'expo-router';

export default function InviteDeepLink() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  const c = (Array.isArray(code) ? code[0] : code) ?? '';
  return (
    <Redirect
      href={{
        pathname: '/(main)/groups/join',
        params: c ? { code: c } : {},
      }}
    />
  );
}
