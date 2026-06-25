// AccountRestrictedNotice — a full-screen, Ember-styled notice shown when a
// restricted account is detected at VERIFY time (POST /auth/verify → 403 with code
// ACCOUNT_SUSPENDED | ACCOUNT_BANNED | ACCOUNT_DELETED). At verify time there is no
// session/token yet, so we render this directly in the verify flow rather than
// routing through the authStore `suspended` status / SuspendedScreen (that path
// needs a live session for its in-screen sign-out).
//
// `onBack` returns the caller to (auth)/welcome and clears any local verify state.
import { View } from 'react-native';
import { Screen, Text, Button } from '@/ui';
import { useTheme } from '@/theme';

// The subset of ErrorCode that lands here. Narrowed deliberately so callers can't
// pass an unrelated code.
export type RestrictedCode =
  | 'ACCOUNT_SUSPENDED'
  | 'ACCOUNT_BANNED'
  | 'ACCOUNT_DELETED';

const COPY: Record<RestrictedCode, { title: string; body: string }> = {
  ACCOUNT_SUSPENDED: {
    title: 'Account suspended',
    body: 'This account has been suspended. Contact support if you think this is a mistake.',
  },
  ACCOUNT_BANNED: {
    title: 'Account banned',
    body: 'This account has been permanently restricted.',
  },
  ACCOUNT_DELETED: {
    title: 'Account not found',
    body: 'This account no longer exists.',
  },
};

export interface AccountRestrictedNoticeProps {
  code: RestrictedCode;
  onBack: () => void;
}

export function AccountRestrictedNotice({ code, onBack }: AccountRestrictedNoticeProps) {
  const theme = useTheme();
  const { title, body } = COPY[code];
  return (
    <Screen>
      <View
        testID="restricted-notice"
        style={{
          flex: 1,
          justifyContent: 'center',
          gap: theme.spacing.lg,
          paddingVertical: theme.spacing.section,
        }}
      >
        <Text variant="h1" weight="black">
          {title}
        </Text>
        <Text variant="body" color="muted">
          {body}
        </Text>
        <View style={{ height: theme.spacing.lg }} />
        <Button
          variant="primary"
          size="lg"
          fullWidth
          title="Back to sign in"
          testID="restricted-back-button"
          accessibilityLabel="Back to sign in"
          onPress={onBack}
        />
      </View>
    </Screen>
  );
}
