/**
 * 1.2 Sign in — email/phone OTP entry + Apple/Google social entry (stubbed).
 *
 * Flow: pick email|phone → type identifier → POST /auth/start → on success push
 * verify (1.3) with the challengeId + identifier as route params. Apple/Google
 * call the same `start` with the social method (backend social entry is a stub).
 * Web-safe: no native auth SDKs imported here.
 */
import { useState } from 'react';
import { Stack, useRouter } from 'expo-router';
import { Text, View } from 'react-native';

import { AuthScaffold } from '../../components/AuthScaffold';
import { useAuthStart, errorMessage } from '../../lib/auth';
import { useTheme } from '../../theme';
import { Button, Field, Icon, SegmentedControl, Toast } from '../../ui';

type Method = 'email' | 'phone';

function validate(method: Method, value: string): string | null {
  const v = value.trim();
  if (!v) return method === 'email' ? 'Enter your email.' : 'Enter your phone number.';
  if (method === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    return 'That doesn’t look like a valid email.';
  }
  if (method === 'phone' && !/^\+?[0-9\s().-]{7,}$/.test(v)) {
    return 'Enter a valid phone number (with country code).';
  }
  return null;
}

export default function SignIn() {
  const theme = useTheme();
  const router = useRouter();
  const [method, setMethod] = useState<Method>('email');
  const [value, setValue] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const start = useAuthStart();

  function submit() {
    const err = validate(method, value);
    setFieldError(err);
    if (err) return;
    const identifier = value.trim();
    start.mutate(
      { method, identifier },
      {
        onSuccess: (res) => {
          router.push({
            pathname: '/(auth)/verify',
            params: { challengeId: res.challengeId ?? '', identifier, method },
          });
        },
      },
    );
  }

  function social(provider: 'apple' | 'google') {
    // Backend social entry is a stub; we still drive the same start endpoint.
    start.mutate(
      { method: provider },
      {
        onSuccess: (res) => {
          if (res.authenticated) {
            // A real social flow would have issued a session here.
            return;
          }
          router.push({
            pathname: '/(auth)/verify',
            params: { challengeId: res.challengeId ?? '', identifier: provider, method: provider },
          });
        },
      },
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Sign in' }} />
      <AuthScaffold
        step={1}
        title="Welcome to twenty4"
        subtitle="Sign in or create an account to start your first recap."
        footer={
          <>
            <Button
              label="Continue"
              size="lg"
              fullWidth
              loading={start.isPending}
              onPress={submit}
            />
            <Text
              style={{
                ...theme.typography.caption,
                color: theme.colors.faint,
                textAlign: 'center',
              }}
            >
              We’ll text or email you a 6-digit code to verify it’s you.
            </Text>
          </>
        }
      >
        <View style={{ gap: theme.spacing.lg }}>
          <SegmentedControl
            value={method}
            onChange={(m) => {
              setMethod(m);
              setValue('');
              setFieldError(null);
            }}
            options={[
              { label: 'Email', value: 'email' },
              { label: 'Phone', value: 'phone' },
            ]}
          />

          <Field
            label={method === 'email' ? 'Email address' : 'Phone number'}
            placeholder={method === 'email' ? 'you@example.com' : '+1 555 123 4567'}
            value={value}
            onChangeText={(t) => {
              setValue(t);
              if (fieldError) setFieldError(null);
            }}
            error={fieldError ?? undefined}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType={method === 'email' ? 'email-address' : 'phone-pad'}
            textContentType={method === 'email' ? 'emailAddress' : 'telephoneNumber'}
            onSubmitEditing={submit}
            returnKeyType="go"
          />

          {start.error ? <Toast tone="error" message={errorMessage(start.error)} /> : null}

          {/* divider */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
            <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.border }} />
            <Text style={{ ...theme.typography.label, color: theme.colors.faint }}>OR</Text>
            <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.border }} />
          </View>

          <View style={{ gap: theme.spacing.sm }}>
            <SocialButton
              label="Continue with Apple"
              icon="logo-apple"
              onPress={() => social('apple')}
              disabled={start.isPending}
            />
            <SocialButton
              label="Continue with Google"
              icon="logo-google"
              onPress={() => social('google')}
              disabled={start.isPending}
            />
          </View>
        </View>
      </AuthScaffold>
    </>
  );
}

/** A neutral surface social button (kept theme-driven, not the accent CTA). */
function SocialButton({
  label,
  icon,
  onPress,
  disabled,
}: {
  label: string;
  icon: 'logo-apple' | 'logo-google';
  onPress: () => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <Text
        accessibilityRole="button"
        onPress={disabled ? undefined : onPress}
        style={{
          ...theme.typography.bodyStrong,
          color: theme.colors.text,
          textAlign: 'center',
          paddingVertical: 14,
        }}
      >
        {label}
      </Text>
      <View style={{ position: 'absolute', left: theme.spacing.lg, top: 0, bottom: 0, justifyContent: 'center' }}>
        <Icon name={icon} size={20} color={theme.colors.text} />
      </View>
    </View>
  );
}
