/**
 * EmptyState — centered icon + title + body + optional action.
 */
import { Text, View } from 'react-native';
import { useTheme } from '../theme';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({
  icon = 'sparkles-outline',
  title,
  body,
  actionLabel,
  onAction,
}: EmptyStateProps) {
  const theme = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: theme.spacing.md, padding: theme.spacing.xl }}>
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
        <Icon name={icon} size={30} color={theme.colors.accent} />
      </View>
      <Text
        style={{ ...theme.typography.heading, color: theme.colors.text, textAlign: 'center' }}
      >
        {title}
      </Text>
      {body ? (
        <Text
          style={{ ...theme.typography.body, color: theme.colors.muted, textAlign: 'center' }}
        >
          {body}
        </Text>
      ) : null}
      {actionLabel && onAction ? (
        <Button label={actionLabel} onPress={onAction} variant="primary" />
      ) : null}
    </View>
  );
}
