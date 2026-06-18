/**
 * Toast — inline notification banner. Tones: info | success | error.
 * Presentational (host/queue lands in a later slice); used in the gallery to
 * show all three tones.
 */
import { Text, View } from 'react-native';
import { useTheme, type Theme } from '../theme';
import { Icon, type IconName } from './Icon';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastProps {
  message: string;
  tone?: ToastTone;
}

function toneStyle(theme: Theme, tone: ToastTone): { color: string; icon: IconName } {
  switch (tone) {
    case 'success':
      return { color: theme.colors.success, icon: 'checkmark-circle' };
    case 'error':
      return { color: theme.colors.danger, icon: 'alert-circle' };
    case 'info':
      return { color: theme.colors.accent, icon: 'information-circle' };
  }
}

export function Toast({ message, tone = 'info' }: ToastProps) {
  const theme = useTheme();
  const t = toneStyle(theme, tone);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderRadius: theme.radii.md,
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderLeftWidth: 4,
        borderColor: theme.colors.border,
        borderLeftColor: t.color,
        alignSelf: 'stretch',
      }}
    >
      <Icon name={t.icon} size={20} color={t.color} />
      <Text style={{ flex: 1, color: theme.colors.text, fontFamily: theme.fontFamily.medium, fontSize: 14 }}>
        {message}
      </Text>
    </View>
  );
}
