// invites/[code] — the invite DEEP-LINK route. Handles twenty4://invites/<code> (and
// web /invites/<code>) for BOTH cold-start (app launched by the link) and warm-start
// (already running). It lives OUTSIDE the (app) group so the AuthGate does NOT
// force-redirect it; we branch on auth status inline here:
//
//   loading                          → full-screen Spinner (session still hydrating;
//                                       hydrate() runs once in the root layout).
//   authenticated                    → render the shared <InvitePreviewJoin/> (same
//                                       preview→join UI as (app)/join). Join → replace
//                                       to the group.
//   needs-profile                    → the user has a token but must finish their
//                                       profile first. Stash the code and let the
//                                       global AuthGate pin them to profile-setup; the
//                                       code resumes from (app) home after they finish.
//   suspended                        → show a brief notice (can't join while suspended).
//   unauthenticated                  → "Sign in to join" screen: stash the code
//                                       (pendingInvite) and send them to (auth)/welcome.
//                                       After they sign in, (app)/index consumes the
//                                       stashed code and bounces back here so the invite
//                                       "resumes". (At minimum, re-opening the link while
//                                       signed in works too.) No crash on a cold,
//                                       logged-out deep link — that's the key guarantee.
import { useEffect } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Screen, Spinner, Text } from '@/ui';
import { useTheme } from '@/theme';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useAuthStatus } from '@/stores/authStore';
import { setPendingInvite } from '@/lib/pendingInvite';
import { invitePreviewErrorCopy } from '@/lib/inviteErrors';
import { ScreenHeader } from '@/components/groups/ScreenHeader';
import { InvitePreviewJoin } from '@/components/InvitePreviewJoin';

export default function InviteDeepLinkScreen() {
  const theme = useTheme();
  const router = useRouter();
  const status = useAuthStatus();
  const { code: rawCode } = useLocalSearchParams<{ code: string }>();
  const code = (rawCode ?? '').trim();

  // CTA-copy preview. GET /invites/:code REQUIRES a session (requireSession on the
  // backend), so we may ONLY fetch it when we actually hold a token. A logged-out
  // user must NOT call it — a 401 would trip the client's onUnauthorized → clear().
  // needs-profile users DO have a token, so they can fetch the group name for copy.
  const showPreviewCopy = status === 'unauthenticated' || status === 'needs-profile';
  const canFetchPreview = status === 'needs-profile'; // has a token; auth'd request OK
  const previewQuery = useQuery({
    queryKey: queryKeys.invites.preview(code),
    queryFn: () => api.getInvitePreview(code),
    enabled: code.length > 0 && canFetchPreview,
    retry: 0,
  });

  // Stash the code as soon as we know the user can't act on it yet, so it can resume
  // after auth/profile completes.
  useEffect(() => {
    if (code.length > 0 && showPreviewCopy) setPendingInvite(code);
  }, [code, showPreviewCopy]);

  // ── Missing/empty code ───────────────────────────────────────────────────────
  if (code.length === 0) {
    return (
      <Screen>
        <ScreenHeader title="Invite" onBack={() => router.replace('/(app)')} />
        <View style={centered(theme)}>
          <Text variant="title" align="center">
            Invalid invite link
          </Text>
          <Text variant="body" color="muted" align="center">
            This link is missing its code.
          </Text>
        </View>
      </Screen>
    );
  }

  // ── Still hydrating the session ──────────────────────────────────────────────
  if (status === 'loading') {
    return (
      <Screen>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Spinner size="large" />
        </View>
      </Screen>
    );
  }

  // ── Authenticated → full preview→join (shared component) ─────────────────────
  if (status === 'authenticated') {
    return (
      <Screen scroll>
        <ScreenHeader title="Invite" onBack={() => router.replace('/(app)')} />
        <InvitePreviewJoin code={code} heading="You're invited" />
      </Screen>
    );
  }

  // ── Suspended → can't join ───────────────────────────────────────────────────
  if (status === 'suspended') {
    return (
      <Screen>
        <ScreenHeader title="Invite" back={false} />
        <View style={centered(theme)}>
          <Text variant="title" align="center">
            Account unavailable
          </Text>
          <Text variant="body" color="muted" align="center">
            You can’t join groups while your account is unavailable.
          </Text>
        </View>
      </Screen>
    );
  }

  // ── needs-profile OR unauthenticated → sign-in / finish-profile gate ─────────
  const groupName = previewQuery.data?.name ?? null;
  const previewBroken = previewQuery.isError;
  const needsProfile = status === 'needs-profile';

  const ctaTitle = needsProfile ? 'Finish your profile' : 'Sign in to join';
  const onCta = () => {
    setPendingInvite(code); // belt-and-suspenders; effect already did this
    router.replace(needsProfile ? '/(auth)/profile-setup' : '/(auth)/welcome');
  };

  return (
    <Screen>
      <ScreenHeader title="Invite" back={false} />
      <View style={centered(theme)}>
        {previewBroken ? (
          <>
            <Text variant="title" align="center">
              Invite unavailable
            </Text>
            <Text variant="body" color="muted" align="center">
              {invitePreviewErrorCopy(previewQuery.error)}
            </Text>
          </>
        ) : (
          <>
            <Text variant="micro" color="accent" align="center">
              You're invited
            </Text>
            <Text variant="h1" align="center">
              {groupName ?? 'Join on twenty4'}
            </Text>
            <Text variant="body" color="muted" align="center">
              {needsProfile
                ? 'Finish setting up your profile to join'
                : 'Sign in or create an account to join'}
              {groupName ? ` ${groupName}.` : '.'}
            </Text>
          </>
        )}
        {!previewBroken ? (
          <Button
            variant="primary"
            title={ctaTitle}
            onPress={onCta}
            testID="invite-signin-button"
          />
        ) : null}
      </View>
    </Screen>
  );
}

function centered(theme: ReturnType<typeof useTheme>) {
  return {
    flex: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: theme.spacing.base,
    paddingVertical: theme.spacing.huge,
  };
}
