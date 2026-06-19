/**
 * 4.3 Create group — name (+ optional photo URL) → POST /groups (caller becomes
 * owner). On success the list cache invalidates and we replace into the new
 * group's detail (4.2). Validation mirrors the contract (name 1..60). Web-safe.
 */
import { useState } from 'react';
import { Stack, useRouter } from 'expo-router';
import { KeyboardAvoidingView, Platform, Text, View } from 'react-native';

import { Screen } from '../../../components/Screen';
import { useCreateGroup, groupErrorMessage } from '../../../lib/groups';
import { useTheme } from '../../../theme';
import { Avatar, Button, Field, Toast } from '../../../ui';

const NAME_MAX = 60;

export default function CreateGroup() {
  const theme = useTheme();
  const router = useRouter();

  const [name, setName] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const create = useCreateGroup();

  function validate(): string | null {
    const n = name.trim();
    if (!n) return 'Give your group a name.';
    if (n.length > NAME_MAX) return `Keep the name under ${NAME_MAX} characters.`;
    if (photoUrl.trim() && !isUrl(photoUrl.trim())) return 'Photo must be a valid URL.';
    return null;
  }

  function submit() {
    const err = validate();
    setFieldError(err);
    if (err) return;
    create.mutate(
      {
        name: name.trim(),
        ...(photoUrl.trim() ? { photoUrl: photoUrl.trim() } : {}),
      },
      {
        onSuccess: (group) => {
          // Replace so Back from the new group returns to the list, not create.
          router.replace(`/(main)/groups/${group.id}`);
        },
      },
    );
  }

  const trimmed = name.trim();

  return (
    <>
      <Stack.Screen options={{ title: 'New group' }} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Screen scroll>
          <View style={{ alignItems: 'center', gap: theme.spacing.sm }}>
            <Avatar name={trimmed || 'New group'} uri={photoUrl.trim() || undefined} size={84} />
            <Text style={{ ...theme.typography.heading, color: theme.colors.text }}>
              Start a group
            </Text>
            <Text
              style={{ ...theme.typography.body, color: theme.colors.muted, textAlign: 'center' }}
            >
              Groups are private. Invite friends with a link — recaps you publish here are only
              seen by members.
            </Text>
          </View>

          <View style={{ gap: theme.spacing.lg }}>
            <Field
              label="Group name"
              placeholder="Weekend crew"
              value={name}
              onChangeText={(t) => {
                setName(t);
                if (fieldError) setFieldError(null);
              }}
              maxLength={NAME_MAX}
              autoFocus
              returnKeyType="next"
              hint={`${trimmed.length}/${NAME_MAX}`}
              error={fieldError ?? undefined}
            />

            <Field
              label="Group photo URL (optional)"
              placeholder="https://…"
              value={photoUrl}
              onChangeText={(t) => {
                setPhotoUrl(t);
                if (fieldError) setFieldError(null);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              onSubmitEditing={submit}
              returnKeyType="go"
            />

            {create.error ? <Toast tone="error" message={groupErrorMessage(create.error)} /> : null}
          </View>

          <View style={{ gap: theme.spacing.sm, marginTop: theme.spacing.sm }}>
            <Button
              label="Create group"
              size="lg"
              fullWidth
              icon="people"
              loading={create.isPending}
              disabled={!trimmed}
              onPress={submit}
            />
            <Button
              label="Cancel"
              variant="ghost"
              fullWidth
              disabled={create.isPending}
              onPress={() => router.back()}
            />
          </View>
        </Screen>
      </KeyboardAvoidingView>
    </>
  );
}

function isUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
