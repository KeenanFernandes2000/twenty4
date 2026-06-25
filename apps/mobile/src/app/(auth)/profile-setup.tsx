// (auth)/profile-setup — shown when status==='needs-profile' (valid token, no
// displayName/username). The gate PINS the user here until the profile is complete.
// We collect a display name + username, then call api.createUser({displayName,
// username}) and useAuthStore.getState().refreshMe() — the gate then advances into
// (app). We never navigate manually.
//
// Photo upload is DEFERRED: we show an Avatar (initials from displayName) and a
// disabled "Add photo (soon)" control; we pass NO profilePhotoUrl.
//
// Error handling (branch on ApiError.code):
//   CONFLICT (409)          → inline "That username is taken" on the username field
//   VALIDATION_FAILED (422) → inline hint on the relevant field
//   else / network          → generic toast.
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { ApiError } from '@twenty4/api-client';
import { Screen, Text, Button, Input, Avatar, useToast } from '@/ui';
import { useTheme } from '@/theme';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';

const USERNAME_RE = /^[a-zA-Z0-9_.]+$/;

// Strip anything outside the server's username charset as the user types (a hint —
// the server is still the authority).
function sanitizeUsername(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_.]/g, '');
}

export default function ProfileSetupScreen() {
  const theme = useTheme();
  const toast = useToast();

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const trimmedName = displayName.trim();
  const nameOk = trimmedName.length >= 1 && trimmedName.length <= 80;
  const usernameOk =
    username.length >= 3 && username.length <= 30 && USERNAME_RE.test(username);
  const canSubmit = useMemo(() => nameOk && usernameOk, [nameOk, usernameOk]);

  const onChangeName = (text: string) => {
    setDisplayName(text);
    if (nameError) setNameError(null);
  };

  const onChangeUsername = (text: string) => {
    setUsername(sanitizeUsername(text));
    if (usernameError) setUsernameError(null);
  };

  const onContinue = async () => {
    setNameError(null);
    setUsernameError(null);
    if (!nameOk) {
      setNameError('Enter a name (1–80 characters)');
      return;
    }
    if (!usernameOk) {
      setUsernameError('3–30 chars: letters, numbers, _ or .');
      return;
    }
    setSubmitting(true);
    try {
      await api.createUser({ displayName: trimmedName, username });
      // Profile complete → re-derive status; the gate moves the user into (app).
      await useAuthStore.getState().refreshMe();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'CONFLICT') {
          setUsernameError('That username is taken');
        } else if (err.code === 'VALIDATION_FAILED') {
          // We can't know which field server-side; hint on username (the strict one).
          setUsernameError('That username isn’t allowed');
        } else {
          toast.show({ type: 'error', message: 'Something went wrong' });
        }
      } else {
        toast.show({ type: 'error', message: 'Something went wrong' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen scroll keyboardAvoiding>
      <View style={{ flex: 1, paddingTop: theme.spacing.section, paddingBottom: theme.spacing.xl }}>
        <Text variant="h1" weight="black">
          Set up your profile
        </Text>
        <Text variant="body" color="muted" style={{ marginTop: theme.spacing.sm }}>
          This is how your people will see you.
        </Text>

        {/* Avatar + deferred photo control. */}
        <View style={{ alignItems: 'center', marginTop: theme.spacing.huge, gap: theme.spacing.base }}>
          <Avatar size="lg" name={trimmedName || undefined} />
          <Pressable
            disabled
            accessibilityRole="button"
            accessibilityState={{ disabled: true }}
            style={{ opacity: 0.5 }}
          >
            <Text variant="caption" weight="extrabold" color="muted">
              Add photo (soon)
            </Text>
          </Pressable>
        </View>

        <View style={{ marginTop: theme.spacing.huge, gap: theme.spacing.xl }}>
          <View testID="auth-displayname-input">
            <Input
              label="Display name"
              value={displayName}
              onChangeText={onChangeName}
              placeholder="Your name"
              error={nameError ?? undefined}
              autoCapitalize="words"
              maxLength={80}
              returnKeyType="next"
            />
          </View>

          <View testID="auth-username-input">
            <Input
              label="Username"
              value={username}
              onChangeText={onChangeUsername}
              placeholder="username"
              error={usernameError ?? undefined}
              autoCapitalize="none"
              maxLength={30}
              returnKeyType="done"
              rightSlot={
                <Text variant="body" color="faint">
                  @
                </Text>
              }
            />
          </View>
        </View>

        <View style={{ flex: 1, minHeight: theme.spacing.xxl }} />

        <Button
          variant="primary"
          size="lg"
          fullWidth
          title="Continue"
          testID="auth-continue-button"
          accessibilityLabel="Continue"
          loading={submitting}
          disabled={!canSubmit}
          onPress={() => void onContinue()}
        />
      </View>
    </Screen>
  );
}
