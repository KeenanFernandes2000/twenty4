/**
 * 1.4 Profile setup — display name + username (citext-unique) + photo.
 *
 * PATCH /users/me persists the profile; on success the authStore clears
 * `needsProfile` and we advance to contacts (1.5). Validation mirrors the
 * contracts `usernameSchema` (3–24, [a-zA-Z0-9_]) so 409s on the unique handle
 * are the only server-side surprise — surfaced as a field error.
 *
 * The photo picker is native-only (expo-image-picker); to keep this path
 * web-exportable it's loaded lazily inside the handler and no-ops on web.
 */
import { useState } from 'react';
import { Stack, useRouter } from 'expo-router';
import { Platform, Pressable, Text, View } from 'react-native';

import { AuthScaffold } from '../../components/AuthScaffold';
import { useUpdateProfile, errorMessage } from '../../lib/auth';
import { useTheme } from '../../theme';
import { Avatar, Button, Field, Icon, Toast } from '../../ui';

const USERNAME_RE = /^[a-zA-Z0-9_]+$/;

function validateUsername(v: string): string | null {
  const u = v.trim();
  if (!u) return 'Pick a username.';
  if (u.length < 3) return 'At least 3 characters.';
  if (u.length > 24) return 'At most 24 characters.';
  if (!USERNAME_RE.test(u)) return 'Letters, numbers and underscore only.';
  return null;
}

export default function ProfileSetup() {
  const theme = useTheme();
  const router = useRouter();

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ displayName?: string; username?: string }>({});

  const update = useUpdateProfile();

  async function pickPhoto() {
    // Native-only: lazy import keeps the web bundle free of expo-image-picker.
    if (Platform.OS === 'web') return;
    try {
      const ImagePicker = await import('expo-image-picker');
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) {
        setPhotoUri(result.assets[0].uri);
      }
    } catch {
      // picker unavailable — leave the initials avatar
    }
  }

  function submit() {
    const nextErrors: typeof errors = {};
    if (!displayName.trim()) nextErrors.displayName = 'Enter your name.';
    const uErr = validateUsername(username);
    if (uErr) nextErrors.username = uErr;
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    update.mutate(
      {
        displayName: displayName.trim(),
        username: username.trim(),
        // photoUri is a local file:// in dev; a real upload lands in slice 2.
        ...(photoUri ? { profilePhotoUrl: photoUri } : {}),
      },
      {
        onSuccess: () => router.push('/(auth)/contacts'),
        onError: (err) => {
          // Unique-handle conflict → attach to the username field.
          const message = errorMessage(err);
          if (/username|handle|taken|conflict/i.test(message)) {
            setErrors((e) => ({ ...e, username: 'That username is taken.' }));
          }
        },
      },
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Your profile' }} />
      <AuthScaffold
        step={4}
        title="Set up your profile"
        subtitle="This is how friends will find and recognize you."
        footer={
          <Button
            label="Continue"
            size="lg"
            fullWidth
            loading={update.isPending}
            onPress={submit}
          />
        }
      >
        <View style={{ gap: theme.spacing.xl }}>
          {/* Photo */}
          <View style={{ alignItems: 'center', gap: theme.spacing.sm }}>
            <Pressable onPress={pickPhoto} accessibilityRole="button">
              <Avatar name={displayName || 'You'} uri={photoUri ?? undefined} size={96} />
              <View
                style={{
                  position: 'absolute',
                  right: -2,
                  bottom: -2,
                  width: 32,
                  height: 32,
                  borderRadius: theme.radii.pill,
                  backgroundColor: theme.colors.accent,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: 2,
                  borderColor: theme.colors.bg,
                }}
              >
                <Icon name="camera" size={16} color={theme.colors.onAccent} />
              </View>
            </Pressable>
            <Text style={{ ...theme.typography.caption, color: theme.colors.muted }}>
              Add a photo
            </Text>
          </View>

          <View style={{ gap: theme.spacing.lg }}>
            <Field
              label="Display name"
              placeholder="Maya Lawson"
              value={displayName}
              onChangeText={(t) => {
                setDisplayName(t);
                if (errors.displayName) setErrors((e) => ({ ...e, displayName: undefined }));
              }}
              error={errors.displayName}
              autoCapitalize="words"
              maxLength={60}
              textContentType="name"
            />
            <Field
              label="Username"
              placeholder="mayalawson"
              value={username}
              onChangeText={(t) => {
                setUsername(t);
                if (errors.username) setErrors((e) => ({ ...e, username: undefined }));
              }}
              error={errors.username}
              hint="3–24 characters · letters, numbers, underscore"
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={24}
            />
          </View>

          {update.error && !errors.username ? (
            <Toast tone="error" message={errorMessage(update.error)} />
          ) : null}
        </View>
      </AuthScaffold>
    </>
  );
}
