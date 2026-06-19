/**
 * 5.6 Delete account — permanent, irreversible account deletion.
 *
 * Strong-confirm flow:
 *   1. A consequences list (profile, owned groups, live recaps, reactions/comments
 *      all permanently removed) + a type-to-confirm Field (must type DELETE).
 *   2. A final confirm Sheet ("Delete your account? … This cannot be undone."
 *      → "Yes, delete everything" / "Cancel"), matching the Ember prototype 5.6.
 *   3. On confirm → DELETE /users/me (revokes sessions + enqueues the purge job),
 *      then signOut() locally so the root gate routes back to the (auth) stack.
 *
 * Web-safe: the destructive call is real, but the screenshot harness only renders
 * the screen + open sheet (it never taps confirm against a live API).
 */
import { useState } from 'react';
import { Stack, useRouter } from 'expo-router';
import { Text, View } from 'react-native';

import { useTheme } from '../../../theme';
import { Button, Card, Field, Icon, Sheet, Toast } from '../../../ui';
import type { IconName } from '../../../ui';
import { safetyErrorMessage, useDeleteAccount } from '../../../lib/safety';
import { useAuthStore } from '../../../stores/authStore';

const CONFIRM_WORD = 'DELETE';

const CONSEQUENCES: Array<{ icon: IconName; text: string }> = [
  { icon: 'person-remove-outline', text: 'Your profile and account are removed for good.' },
  { icon: 'people-outline', text: 'Groups you own are deleted; you leave every other group.' },
  { icon: 'film-outline', text: 'Any live recaps, reactions and comments are erased.' },
  { icon: 'lock-closed-outline', text: 'This cannot be undone. There is no recovery.' },
];

export default function DeleteAccount() {
  const theme = useTheme();
  const c = theme.colors;
  const router = useRouter();

  const [confirmText, setConfirmText] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signOut = useAuthStore((s) => s.signOut);
  const del = useDeleteAccount();

  const armed = confirmText.trim().toUpperCase() === CONFIRM_WORD;

  const onConfirmDelete = async () => {
    setError(null);
    try {
      await del.mutateAsync();
      // Session is revoked server-side; clear locally → root gate → (auth).
      await signOut();
      setSheetOpen(false);
      router.replace('/(auth)/welcome');
    } catch (e) {
      setError(safetyErrorMessage(e));
      setSheetOpen(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ title: 'Delete account', headerTintColor: c.danger }} />

      <View style={{ flex: 1, padding: theme.spacing.lg, gap: theme.spacing.lg }}>
        <View style={{ alignItems: 'center', gap: theme.spacing.sm, paddingVertical: theme.spacing.md }}>
          <View
            style={{
              width: 64,
              height: 64,
              borderRadius: 32,
              backgroundColor: `${c.danger}22`,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="warning-outline" size={30} color={c.danger} />
          </View>
          <Text style={{ ...theme.typography.heading, color: c.text, textAlign: 'center' }}>
            Delete your account?
          </Text>
          <Text style={{ ...theme.typography.body, color: c.muted, textAlign: 'center' }}>
            This permanently deletes your profile, groups you own, and any live recaps.
          </Text>
        </View>

        <Card>
          <View style={{ gap: theme.spacing.md }}>
            {CONSEQUENCES.map((row) => (
              <View key={row.text} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                <Icon name={row.icon} size={20} color={c.danger} />
                <Text style={{ ...theme.typography.body, color: c.text2, flex: 1 }}>{row.text}</Text>
              </View>
            ))}
          </View>
        </Card>

        <Field
          label={`Type ${CONFIRM_WORD} to confirm`}
          value={confirmText}
          onChangeText={setConfirmText}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder={CONFIRM_WORD}
        />

        {error ? <Toast message={error} tone="error" /> : null}

        <View style={{ flex: 1 }} />

        <Button
          label="Delete my account"
          variant="danger"
          fullWidth
          disabled={!armed}
          onPress={() => setSheetOpen(true)}
        />
        <Button label="Cancel" variant="ghost" fullWidth onPress={() => router.back()} />
      </View>

      <Sheet visible={sheetOpen} onClose={() => setSheetOpen(false)} title="Delete your account?">
        <Text style={{ ...theme.typography.body, color: c.text2 }}>
          This permanently deletes your profile, groups you own, and any live recaps. This cannot be
          undone.
        </Text>
        <View style={{ gap: theme.spacing.sm, marginTop: theme.spacing.sm }}>
          <Button
            label="Yes, delete everything"
            variant="danger"
            fullWidth
            loading={del.isPending}
            onPress={() => void onConfirmDelete()}
          />
          <Button
            label="Cancel"
            variant="ghost"
            fullWidth
            disabled={del.isPending}
            onPress={() => setSheetOpen(false)}
          />
        </View>
      </Sheet>
    </View>
  );
}
