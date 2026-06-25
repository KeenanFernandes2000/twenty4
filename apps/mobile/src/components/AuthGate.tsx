// AuthGate — the routing guard. Renders the navigator (children) and enforces the
// auth status → route-group invariants via the idiomatic expo-router "segments"
// pattern (read status + useSegments + useRouter, then router.replace).
//
// Why segments and not <Stack.Protected guard={...}>: Protected only toggles whole
// route trees on a boolean. Our state machine needs (a) DIFFERENT destinations per
// status (needs-profile → profile-setup, authenticated → (app)), and (b) a GLOBAL
// override that replaces the entire navigator with <SuspendedScreen/> regardless of
// route. The segments pattern expresses both cleanly; Protected can't.
//
// Group invariants:
//   (auth)  — pre-session screens: welcome / sign-in / verify / legal, PLUS
//             profile-setup (needs a token but lives in the auth flow).
//   (app)   — post-session screens (requires authenticated).
//
// Redirect rules (only act when the user is on the WRONG side, to avoid loops):
//   loading                         → render Spinner; don't redirect (hydrate runs).
//   unauthenticated + in (app)      → replace → /(auth)/welcome.
//   authenticated   + in (auth)     → replace → /(app).
//   needs-profile   + not on        → replace → /(auth)/profile-setup
//                     profile-setup   (stays in (auth) but pinned to that screen).
//   suspended                       → render <SuspendedScreen/> instead of children
//                                      (handled globally, route-independent).
//
// Standalone PUBLIC routes (e.g. invites/[code], dev-gallery) live in NEITHER group
// on purpose. The gate must NOT hijack them: an authenticated user on a cold
// /invites/<code> deep link has to actually SEE that screen, not get bounced to
// (app). So "authenticated" only force-redirects when the user is in the (auth)
// group — being merely "not in (app)" (i.e. on a standalone route) is fine.
import { useEffect } from 'react';
import { View } from 'react-native';
import { useRouter, useSegments } from 'expo-router';
import { Spinner } from '@/ui';
import { useTheme } from '@/theme';
import { useAuthStatus } from '@/stores/authStore';
import { SuspendedScreen } from './SuspendedScreen';

function FullScreenSpinner() {
  const theme = useTheme();
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.bg,
      }}
    >
      <Spinner size="large" />
    </View>
  );
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const status = useAuthStatus();
  // useSegments() is generically typed against generated routes; read it as a
  // plain string[] so we can index arbitrary depths regardless of route typing.
  const segments = useSegments() as readonly string[];
  const router = useRouter();

  // segments[0] is the top-level group, e.g. "(auth)" or "(app)".
  const inAuthGroup = segments[0] === '(auth)';
  const inAppGroup = segments[0] === '(app)';
  // Standalone PUBLIC routes that live in NEITHER group — the gate passes these
  // through untouched for authenticated / needs-profile users (each screen does
  // its own inline auth branching). Cold deep links land here, so DON'T bounce.
  const STANDALONE_ROUTES = ['invites', 'dev-gallery'];
  const onStandaloneRoute = STANDALONE_ROUTES.includes(segments[0] ?? '');
  // segments[1] is the screen within (auth), e.g. "profile-setup".
  const onProfileSetup = inAuthGroup && segments[1] === 'profile-setup';

  useEffect(() => {
    // Don't navigate while hydrating or while suspended (suspended is rendered
    // globally below, not routed). Wait for segments to be populated.
    if (status === 'loading' || status === 'suspended') return;
    if (segments.length === 0) return;

    if (status === 'unauthenticated') {
      // Bounce out of (app) to the auth flow. Leave standalone public routes
      // (e.g. invites/[code]) alone — they show their own logged-out CTA and
      // stash the pending invite rather than being hijacked here.
      if (inAppGroup) router.replace('/(auth)/welcome');
      return;
    }

    if (status === 'needs-profile') {
      // Pin the user to profile-setup (which lives in the auth flow) until they
      // complete it. Standalone routes are left alone (the invite screen itself
      // routes needs-profile users to profile-setup with the code stashed); the
      // pin applies everywhere else.
      if (!onProfileSetup && !onStandaloneRoute) router.replace('/(auth)/profile-setup');
      return;
    }

    if (status === 'authenticated') {
      // A fully signed-in user should never sit on an (auth) screen. But a
      // standalone public route (invites/[code], dev-gallery) is a legitimate
      // place to be — only bounce when actually in (auth). NOT for "not in (app)",
      // which would hijack cold deep links.
      if (inAuthGroup) router.replace('/(app)');
      return;
    }
  }, [status, segments, inAuthGroup, inAppGroup, onProfileSetup, onStandaloneRoute, router]);

  // Loading (incl. initial hydrate) → block the UI with a spinner so no screen
  // flashes before the redirect lands.
  if (status === 'loading') return <FullScreenSpinner />;

  // Suspended/banned/deleted → take over the whole navigator, route-independent.
  if (status === 'suspended') return <SuspendedScreen />;

  return <>{children}</>;
}
