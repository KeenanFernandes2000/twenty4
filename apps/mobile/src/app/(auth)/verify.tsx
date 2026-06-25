// (auth)/verify — OTP entry. Reads {identifier, channel} from the route params.
// 6-cell OTPInput (autofocus). On complete (or the Verify button) we call
// api.authVerify → SessionDTO, then setSession(token); the AuthGate routes onward
// (we never navigate into (app) manually).
//
// Resend: a ~30s cooldown timer; tapping re-calls api.authStart and restarts it.
// Dev affordance (__DEV__ only): "Use dev code" fetches api.getDevLastOtp and fills
// the cells; it also auto-fills once on mount in dev. Guarded so it never ships.
//
// Error handling (branch on ApiError.code):
//   UNAUTHORIZED (401) → toast "Invalid or expired code" + clear the cells
//   RATE_LIMITED (429) → toast "Too many attempts, request a new code"
//   else / network     → generic toast.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ApiError } from '@twenty4/api-client';
import type { Channel } from '@twenty4/contracts';
import { Screen, Text, Button, OTPInput, useToast } from '@/ui';
import { useTheme } from '@/theme';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';

const OTP_LENGTH = 6;
const RESEND_SECONDS = 30;

// Narrow a possibly-array route param to a single string.
function paramString(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export default function VerifyScreen() {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();

  const params = useLocalSearchParams<{ identifier?: string; channel?: string }>();
  const identifier = paramString(params.identifier);
  const rawChannel = paramString(params.channel);
  const channel: Channel = rawChannel === 'email' ? 'email' : 'phone';

  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(RESEND_SECONDS);
  // Guard so an in-flight / completed verify isn't fired twice (onComplete + button).
  const verifyingRef = useRef(false);

  // ── Resend cooldown ticker ─────────────────────────────────────────────────
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const submitVerify = useCallback(
    async (fullCode: string) => {
      if (verifyingRef.current) return;
      if (fullCode.length < 4) return;
      verifyingRef.current = true;
      setVerifying(true);
      try {
        const session = await api.authVerify({ identifier, channel, code: fullCode });
        // Hand the token to the store; the AuthGate observes the status change and
        // routes onward (→ (app) or → profile-setup). Do NOT navigate here.
        await useAuthStore.getState().setSession(session.token);
      } catch (err) {
        // Reset so the user can retry with a fresh code.
        setCode('');
        if (err instanceof ApiError) {
          if (err.code === 'UNAUTHORIZED') {
            toast.show({ type: 'error', message: 'Invalid or expired code' });
          } else if (err.code === 'RATE_LIMITED') {
            toast.show({ type: 'error', message: 'Too many attempts, request a new code' });
          } else {
            toast.show({ type: 'error', message: 'Something went wrong' });
          }
        } else {
          toast.show({ type: 'error', message: 'Something went wrong' });
        }
      } finally {
        verifyingRef.current = false;
        setVerifying(false);
      }
    },
    [identifier, channel, toast],
  );

  // ── Dev: fetch + fill the last OTP (dev server only; 403 when disabled) ──────
  const fillDevCode = useCallback(
    async (autoVerify: boolean) => {
      try {
        const res = await api.getDevLastOtp(identifier, channel);
        if (res.code) {
          setCode(res.code);
          if (autoVerify) void submitVerify(res.code);
        }
      } catch {
        // Silent: dev-OTP may be disabled (403) or the server unreachable.
      }
    },
    [identifier, channel, submitVerify],
  );

  // Auto-fill once on mount in dev to make the web QA loop one tap shorter.
  useEffect(() => {
    if (__DEV__ && identifier) {
      void fillDevCode(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onResend = async () => {
    if (cooldown > 0 || resending) return;
    setResending(true);
    try {
      await api.authStart({ identifier, channel });
      setCode('');
      setCooldown(RESEND_SECONDS);
      toast.show({ type: 'success', message: 'New code sent' });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
        toast.show({ type: 'error', message: 'Too many requests, try again later' });
      } else {
        toast.show({ type: 'error', message: 'Something went wrong' });
      }
    } finally {
      setResending(false);
    }
  };

  return (
    <Screen keyboardAvoiding>
      <View style={{ flex: 1, paddingTop: theme.spacing.section }}>
        <Text variant="h1" weight="black">
          Enter your code
        </Text>
        <Text variant="body" color="muted" style={{ marginTop: theme.spacing.sm }}>
          We sent a {OTP_LENGTH}-digit code to{' '}
          <Text variant="body" color="primary" weight="black">
            {identifier || 'your device'}
          </Text>
          .
        </Text>

        <View style={{ marginTop: theme.spacing.huge }} testID="auth-otp-input">
          <OTPInput
            length={OTP_LENGTH}
            value={code}
            onChangeText={setCode}
            onComplete={(c) => void submitVerify(c)}
            autoFocus
          />
        </View>

        {/* Resend row. */}
        <View style={{ marginTop: theme.spacing.xl, alignItems: 'flex-start' }}>
          <Pressable
            testID="auth-resend-button"
            disabled={cooldown > 0 || resending}
            onPress={() => void onResend()}
            accessibilityRole="button"
          >
            <Text
              variant="body"
              weight="extrabold"
              color={cooldown > 0 ? 'faint' : 'accent'}
            >
              {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
            </Text>
          </Pressable>
        </View>

        {__DEV__ ? (
          <View style={{ marginTop: theme.spacing.lg, alignItems: 'flex-start' }}>
            <Pressable
              testID="auth-dev-code-button"
              onPress={() => void fillDevCode(false)}
              accessibilityRole="button"
            >
              <Text variant="caption" weight="extrabold" color="accent">
                Use dev code
              </Text>
            </Pressable>
          </View>
        ) : null}

        <View style={{ flex: 1 }} />

        <View style={{ gap: theme.spacing.base, paddingBottom: theme.spacing.xl }}>
          <Button
            variant="primary"
            size="lg"
            fullWidth
            title="Verify"
            testID="auth-verify-button"
            accessibilityLabel="Verify"
            loading={verifying}
            disabled={code.length < 4}
            onPress={() => void submitVerify(code)}
          />
          <Button
            variant="ghost"
            fullWidth
            title="Change number or email"
            accessibilityLabel="Change number or email"
            onPress={() => router.back()}
          />
        </View>
      </View>
    </Screen>
  );
}
