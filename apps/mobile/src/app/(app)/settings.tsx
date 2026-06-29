// (app)/settings — a minimal account/settings surface. Shows the signed-in
// identity, a Sign out affordance, and the M9 destructive Account-deletion confirm
// flow (spec §6 / §9 missing-screen #6).
//
// Account deletion: a destructive confirm with explicit consequence copy → DELETE
// /users/me (the worker purges ALL the user's content + revokes sessions) → then we
// sign the user out locally via authStore.clear(), and the AuthGate routes to
// (auth)/welcome (status flips to unauthenticated). Mirrors the Groups-home sign-out
// path; reuses the shared `confirm()` + Ember styling idioms.
import { View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { Avatar, Button, Card, Screen, Text, useToast } from '@/ui';
import { useTheme } from '@/theme';
import { api } from '@/lib/api';
import { confirm } from '@/lib/confirm';
import { useAuthStore, useAuthUser } from '@/stores/authStore';
import { ScreenHeader } from '@/components/groups/ScreenHeader';

export default function SettingsScreen() {
  const theme = useTheme();
  const toast = useToast();
  const user = useAuthUser();

  const signOut = () => {
    void useAuthStore.getState().clear();
  };

  // DELETE /users/me → on success, sign out locally (clear() also best-effort hits
  // authLogout, which tolerates the now-revoked session). The AuthGate then redirects
  // to (auth)/welcome.
  const deleteAccount = useMutation<{ status: string }, unknown, void>({
    mutationFn: () => api.deleteAccount(),
    onSuccess: () => {
      void useAuthStore.getState().clear();
    },
    onError: () =>
      toast.show({ type: 'error', message: 'Could not delete your account. Please try again.' }),
  });

  const onDeleteAccount = async () => {
    const ok = await confirm({
      title: 'Delete your account?',
      message:
        'All of your recaps, photos, reactions and comments will be permanently deleted. This cannot be undone.',
      confirmLabel: 'Delete account',
    });
    if (ok) deleteAccount.mutate();
  };

  const name = user?.displayName ?? 'You';

  return (
    <Screen scroll>
      <ScreenHeader title="Settings" />

      {/* ── Identity ──────────────────────────────────────────────────────────── */}
      <View
        style={{ alignItems: 'center', gap: theme.spacing.base, paddingVertical: theme.spacing.lg }}
        testID="settings-identity"
      >
        <Avatar size="lg" uri={user?.profilePhotoUrl ?? undefined} name={name} />
        <Text variant="h1" align="center">
          {name}
        </Text>
        {user?.username ? (
          <Text variant="body" color="muted">
            @{user.username}
          </Text>
        ) : null}
      </View>

      <View style={{ gap: theme.spacing.base, marginTop: theme.spacing.lg }}>
        <Button
          variant="secondary"
          fullWidth
          title="Sign out"
          onPress={signOut}
          testID="settings-sign-out"
        />

        <Card variant="compact" flat>
          <View style={{ gap: theme.spacing.sm }}>
            <Text variant="body">Delete account</Text>
            <Text variant="caption" color="muted">
              Permanently deletes your account and all of your recaps, photos, reactions and comments.
              This cannot be undone.
            </Text>
            <Button
              variant="danger"
              fullWidth
              title="Delete account"
              onPress={onDeleteAccount}
              loading={deleteAccount.isPending}
              disabled={deleteAccount.isPending}
              testID="settings-delete-account"
            />
          </View>
        </Card>
      </View>
    </Screen>
  );
}
