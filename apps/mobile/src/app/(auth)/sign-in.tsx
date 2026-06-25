// (auth)/sign-in — identifier entry. A phone|email segmented toggle drives ONE
// adapting Input. "Send code" calls api.authStart({identifier, channel}); on 202
// we push to /(auth)/verify with the identifier+channel as params. We send what the
// user typed (trimmed) — the server re-normalizes.
//
// Error handling (branch on ApiError.code, never the message):
//   RATE_LIMITED (429)      → toast "Too many requests, try again later"
//   VALIDATION_FAILED (422) → inline "Enter a valid phone/email"
//   anything else / network → generic toast.
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { Link, useRouter } from 'expo-router';
import { ApiError } from '@twenty4/api-client';
import type { Channel } from '@twenty4/contracts';
import { Screen, Text, Button, Input, useToast } from '@/ui';
import { useTheme } from '@/theme';
import { api } from '@/lib/api';
import { AuthSegmentedControl } from '@/components/AuthSegmentedControl';

// Cheap client-side "is this plausibly submittable" check — just to gate the
// button + give an early inline hint. The real validation is server-side.
function looksValid(identifier: string, channel: Channel): boolean {
  const v = identifier.trim();
  if (channel === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  // phone: optional leading +, then 7–15 digits (after stripping separators).
  const digits = v.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

export default function SignInScreen() {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();

  const [channel, setChannel] = useState<Channel>('phone');
  const [identifier, setIdentifier] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const valid = useMemo(() => looksValid(identifier, channel), [identifier, channel]);

  const onChangeChannel = (next: Channel) => {
    setChannel(next);
    setError(null);
  };

  const onChangeIdentifier = (text: string) => {
    setIdentifier(text);
    if (error) setError(null);
  };

  const onSend = async () => {
    const trimmed = identifier.trim();
    if (!looksValid(trimmed, channel)) {
      setError(channel === 'email' ? 'Enter a valid email' : 'Enter a valid phone number');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.authStart({ identifier: trimmed, channel });
      router.push({
        pathname: '/(auth)/verify',
        params: { identifier: trimmed, channel },
      });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'RATE_LIMITED') {
          toast.show({ type: 'error', message: 'Too many requests, try again later' });
        } else if (err.code === 'VALIDATION_FAILED') {
          setError(channel === 'email' ? 'Enter a valid email' : 'Enter a valid phone number');
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
    <Screen keyboardAvoiding>
      <View style={{ flex: 1, paddingTop: theme.spacing.section }}>
        <Text variant="h1" weight="black">
          Sign in
        </Text>
        <Text variant="body" color="muted" style={{ marginTop: theme.spacing.sm }}>
          We’ll text or email you a one-time code.
        </Text>

        <View style={{ marginTop: theme.spacing.huge, gap: theme.spacing.xl }}>
          <AuthSegmentedControl<Channel>
            value={channel}
            onChange={onChangeChannel}
            options={[
              { value: 'phone', label: 'Phone', testID: 'auth-channel-phone' },
              { value: 'email', label: 'Email', testID: 'auth-channel-email' },
            ]}
          />

          <View testID="auth-identifier-input">
            <Input
              label={channel === 'email' ? 'Email address' : 'Phone number'}
              value={identifier}
              onChangeText={onChangeIdentifier}
              placeholder={channel === 'email' ? 'you@example.com' : '+1 555 123 4567'}
              error={error ?? undefined}
              keyboardType={channel === 'email' ? 'email-address' : 'phone-pad'}
              autoCapitalize="none"
              autoFocus
              returnKeyType="go"
              onSubmitEditing={() => {
                if (valid && !submitting) void onSend();
              }}
            />
          </View>
        </View>

        <View style={{ flex: 1 }} />

        <View style={{ gap: theme.spacing.xl, paddingBottom: theme.spacing.xl }}>
          <Button
            variant="primary"
            size="lg"
            fullWidth
            title="Send code"
            testID="auth-send-button"
            accessibilityLabel="Send code"
            loading={submitting}
            disabled={!valid}
            onPress={() => void onSend()}
          />
          <Text variant="caption" color="faint" align="center">
            By continuing you agree to our{' '}
            <Link href="/(auth)/legal" style={{ color: theme.colors.accent }}>
              Terms &amp; Privacy
            </Link>
            .
          </Text>
        </View>
      </View>
    </Screen>
  );
}
