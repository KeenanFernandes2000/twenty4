/**
 * ErrorRetry — error state with a retry action (network/query failure).
 */
import { Text, View } from 'react-native';
import { useTheme } from '../theme';
import { Button } from './Button';
import { Icon } from './Icon';

export interface ErrorRetryProps {
  title?: string;
  message?: string;
  onRetry?: () => void;
}

export function ErrorRetry({
  title = 'Something went wrong',
  message = 'We couldn’t load this. Check your connection and try again.',
  onRetry,
}: ErrorRetryProps) {
  const theme = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: theme.spacing.md, padding: theme.spacing.xl }}>
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 32,
          backgroundColor: theme.colors.surface2,
          borderWidth: 1,
          borderColor: theme.colors.border,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name="cloud-offline-outline" size={30} color={theme.colors.danger} />
      </View>
      <Text style={{ ...theme.typography.heading, color: theme.colors.text, textAlign: 'center' }}>
        {title}
      </Text>
      <Text style={{ ...theme.typography.body, color: theme.colors.muted, textAlign: 'center' }}>
        {message}
      </Text>
      {onRetry ? <Button label="Try again" icon="refresh" onPress={onRetry} variant="secondary" /> : null}
    </View>
  );
}
