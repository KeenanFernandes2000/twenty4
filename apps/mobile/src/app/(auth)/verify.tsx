/**
 * 1.3 Verify — enter the 6-digit OTP → POST /auth/verify → persist session.
 *
 * Reads { challengeId, identifier, method } from the sign-in step. On a verified
 * code the authStore stores the session and the root gate routes onward (to
 * profile-setup if `needsProfile`, else the tabs). A resend countdown re-issues
 * the OTP via /auth/start. In dev, a "use last code" helper pulls the latest OTP
 * from GET /auth/dev/last-otp so the flow is testable end-to-end.
 */
import { useEffect, useState } from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Text, View } from 'react-native';

import { AuthScaffold } from '../../components/AuthScaffold';
import { apiClient } from '../../lib/apiClient';
import { useAuthStart, useAuthVerify, errorMessage } from '../../lib/auth';
import { useTheme } from '../../theme';
import { Button, OtpInput, Toast } from '../../ui';

const RESEND_SECONDS = 30;
const CODE_LENGTH = 6;
const IS_DEV = process.env.NODE_ENV !== 'production';

/** Mask an email/phone for the "we sent a code to …" line. */
function maskTarget(identifier: string, method: string): string {
  if (method === 'apple' || method === 'google') return `your ${method} account`;
  if (method === 'email') {
    const [name, domain] = identifier.split('@');
    if (!domain) return identifier;
    const head = name.slice(0, 2);
    return `${head}${'•'.repeat(Math.max(1, name.length - 2))}@${domain}`;
  }
  // phone — keep last 4
  const tail = identifier.slice(-4);
  return `${identifier.slice(0, 4)} ••• ${tail}`;
}

export default function Verify() {
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{
    challengeId?: string;
    identifier?: string;
    method?: string;
  }>();
  const challengeId = params.challengeId ?? '';
  const identifier = params.identifier ?? '';
  const method = params.method ?? 'email';

  const [code, setCode] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(RESEND_SECONDS);

  const verify = useAuthVerify();
  const resend = useAuthStart();

  // Resend countdown.
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft]);

  function submit(value: string = code) {
    if (value.length !== CODE_LENGTH || verify.isPending) return;
    // On success the root gate handles navigation off the (auth) stack.
    verify.mutate({ challengeId, code: value });
  }

  function handleResend() {
    if (secondsLeft > 0 || !identifier) return;
    resend.mutate(
      { method: method as 'email' | 'phone', identifier },
      { onSuccess: () => setSecondsLeft(RESEND_SECONDS) },
    );
  }

  /** Dev-only: pull the latest OTP the server logged for this identifier. */
  async function fillDevCode() {
    try {
      const res = await apiClient.request<{ identifier: string; code: string }>(
        '/auth/dev/last-otp',
        { query: { identifier } },
      );
      if (res?.code) {
        setCode(res.code);
        submit(res.code);
      }
    } catch {
      // dev convenience only; ignore failures
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Verify' }} />
      <AuthScaffold
        step={2}
        title="Enter the code"
        subtitle={`We sent a 6-digit code to ${maskTarget(identifier, method)}.`}
        footer={
          <>
            <Button
              label="Verify"
              size="lg"
              fullWidth
              loading={verify.isPending}
              disabled={code.length !== CODE_LENGTH}
              onPress={() => submit()}
            />
            <Button
              label={
                secondsLeft > 0 ? `Resend code in ${secondsLeft}s` : 'Resend code'
              }
              variant="ghost"
              fullWidth
              disabled={secondsLeft > 0 || resend.isPending}
              onPress={handleResend}
            />
          </>
        }
      >
        <View style={{ gap: theme.spacing.lg, marginTop: theme.spacing.md }}>
          <OtpInput
            value={code}
            onChange={setCode}
            error={!!verify.error}
            onComplete={(v) => submit(v)}
          />

          {verify.error ? <Toast tone="error" message={errorMessage(verify.error)} /> : null}

          <Text
            style={{ ...theme.typography.caption, color: theme.colors.muted, textAlign: 'center' }}
            onPress={() => router.back()}
          >
            Wrong number?{' '}
            <Text style={{ color: theme.colors.accent, fontFamily: theme.fontFamily.bold }}>
              Change it
            </Text>
          </Text>

          {IS_DEV && identifier ? (
            <Button
              label="Dev: use last code"
              variant="secondary"
              size="sm"
              icon="bug-outline"
              onPress={fillDevCode}
            />
          ) : null}
        </View>
      </AuthScaffold>
    </>
  );
}
