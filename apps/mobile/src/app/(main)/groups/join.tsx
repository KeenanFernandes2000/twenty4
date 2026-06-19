/**
 * 4.5 Join — two entry paths:
 *   1. user types/pastes an invite code, or
 *   2. they arrived via the deep link `twenty4://invite/{code}` → the linking
 *      config (app.config) routes here with the `code` route param prefilled.
 *
 * Once a code is present we preview the group (GET /invites/:code →
 * name/photo/count/valid) and offer Join (POST /invites/:code/join). The join
 * mutation maps the backend's precise failures to friendly copy:
 *   - 410 invite_invalid → expired / used-up / revoked
 *   - 409 already_member → you're already in; offer to open the group
 * On success we replace into the joined group's detail (4.2).
 */
import { useEffect, useState } from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { KeyboardAvoidingView, Platform, Text, View } from 'react-native';

import { Screen } from '../../../components/Screen';
import {
  useInvitePreview,
  useJoinInvite,
  groupErrorMessage,
  errorStatus,
  errorReason,
} from '../../../lib/groups';
import { useTheme } from '../../../theme';
import { Avatar, Button, Card, Field, Icon, Skeleton, Toast } from '../../../ui';

/** Normalize a pasted code (strip a full deep-link, upper-case, drop spaces). */
function normalizeCode(raw: string): string {
  let c = raw.trim();
  const marker = 'invite/';
  const i = c.toLowerCase().lastIndexOf(marker);
  if (i >= 0) c = c.slice(i + marker.length);
  c = c.replace(/[/?#].*$/, ''); // strip any trailing path/query
  return c.replace(/\s+/g, '').toUpperCase();
}

export default function Join() {
  const theme = useTheme();
  const router = useRouter();
  // `code` arrives from the deep link; absent for manual entry.
  const params = useLocalSearchParams<{ code?: string }>();

  const [code, setCode] = useState(params.code ? normalizeCode(params.code) : '');
  const [submitted, setSubmitted] = useState(!!params.code);

  // Keep in sync if the deep link changes while mounted.
  useEffect(() => {
    if (params.code) {
      setCode(normalizeCode(params.code));
      setSubmitted(true);
    }
  }, [params.code]);

  const trimmed = code.trim();
  const preview = useInvitePreview(trimmed, { enabled: submitted && !!trimmed });
  const join = useJoinInvite();

  const [joinError, setJoinError] = useState<string | null>(null);
  const [alreadyMember, setAlreadyMember] = useState(false);

  function lookUp() {
    setJoinError(null);
    setAlreadyMember(false);
    if (!trimmed) return;
    setSubmitted(true);
    void preview.refetch();
  }

  function doJoin() {
    setJoinError(null);
    setAlreadyMember(false);
    join.mutate(trimmed, {
      onSuccess: (group) => {
        router.replace(`/(main)/groups/${group.id}`);
      },
      onError: (e) => {
        const status = errorStatus(e);
        const reason = errorReason(e);
        if (status === 409 || reason === 'already_member') {
          setAlreadyMember(true);
          setJoinError('You’re already a member of this group.');
        } else if (status === 410) {
          setJoinError('This invite is no longer valid — it expired or reached its limit.');
        } else if (status === 429) {
          setJoinError('Too many attempts. Please wait a moment and try again.');
        } else {
          setJoinError(groupErrorMessage(e));
        }
      },
    });
  }

  const showPreviewPane = submitted && !!trimmed;
  const previewInvalid = preview.data && !preview.data.valid;

  return (
    <>
      <Stack.Screen options={{ title: 'Join a group' }} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Screen scroll>
          <View style={{ alignItems: 'center', gap: theme.spacing.sm }}>
            <View
              style={{
                width: 64,
                height: 64,
                borderRadius: 32,
                backgroundColor: theme.colors.accentSoft,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="enter-outline" size={30} color={theme.colors.accent} />
            </View>
            <Text style={{ ...theme.typography.heading, color: theme.colors.text }}>
              Join a group
            </Text>
            <Text
              style={{ ...theme.typography.body, color: theme.colors.muted, textAlign: 'center' }}
            >
              Paste an invite link or enter the code a friend shared with you.
            </Text>
          </View>

          <Field
            label="Invite code"
            placeholder="e.g. K7P2Q R4M9"
            value={code}
            onChangeText={(t) => {
              setCode(normalizeCode(t));
              setSubmitted(false);
              setJoinError(null);
              setAlreadyMember(false);
            }}
            autoCapitalize="characters"
            autoCorrect={false}
            autoFocus={!params.code}
            onSubmitEditing={lookUp}
            returnKeyType="search"
          />

          {!showPreviewPane ? (
            <Button
              label="Look up group"
              icon="search"
              size="lg"
              fullWidth
              disabled={!trimmed}
              onPress={lookUp}
            />
          ) : null}

          {/* Preview pane */}
          {showPreviewPane ? (
            <Card style={{ gap: theme.spacing.md }}>
              {preview.isLoading || preview.isFetching ? (
                <View style={{ alignItems: 'center', gap: theme.spacing.sm }}>
                  <Skeleton width={72} height={72} radius={36} />
                  <Skeleton width="55%" height={18} />
                  <Skeleton width="35%" height={12} />
                </View>
              ) : preview.isError ? (
                <View style={{ gap: theme.spacing.sm }}>
                  <Toast
                    tone="error"
                    message={
                      errorStatus(preview.error) === 404
                        ? 'No group found for that code. Double-check it and try again.'
                        : groupErrorMessage(preview.error)
                    }
                  />
                  <Button label="Try again" icon="refresh" variant="secondary" fullWidth onPress={lookUp} />
                </View>
              ) : preview.data ? (
                <View style={{ gap: theme.spacing.md }}>
                  <View style={{ alignItems: 'center', gap: theme.spacing.sm }}>
                    <Avatar
                      name={preview.data.groupName}
                      uri={preview.data.groupPhotoUrl ?? undefined}
                      size={72}
                    />
                    <Text style={{ ...theme.typography.heading, color: theme.colors.text }}>
                      {preview.data.groupName}
                    </Text>
                    <Text style={{ ...theme.typography.caption, color: theme.colors.muted }}>
                      {preview.data.memberCount}{' '}
                      {preview.data.memberCount === 1 ? 'member' : 'members'}
                    </Text>
                  </View>

                  {previewInvalid ? (
                    <Toast
                      tone="error"
                      message="This invite has expired or reached its limit. Ask for a new one."
                    />
                  ) : null}

                  {joinError ? <Toast tone={alreadyMember ? 'info' : 'error'} message={joinError} /> : null}

                  {alreadyMember ? (
                    <Button
                      label="Open group"
                      icon="arrow-forward"
                      fullWidth
                      onPress={() => router.replace('/(main)/groups')}
                    />
                  ) : (
                    <Button
                      label={`Join ${preview.data.groupName}`}
                      icon="checkmark"
                      size="lg"
                      fullWidth
                      disabled={previewInvalid}
                      loading={join.isPending}
                      onPress={doJoin}
                    />
                  )}
                </View>
              ) : null}
            </Card>
          ) : null}

          <Button label="Cancel" variant="ghost" fullWidth onPress={() => router.back()} />
        </Screen>
      </KeyboardAvoidingView>
    </>
  );
}
