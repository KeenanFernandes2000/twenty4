/**
 * Card — surface container with border + radius, Ember-themed.
 */
import { View, type ViewProps } from 'react-native';
import { useTheme } from '../theme';

export interface CardProps extends ViewProps {
  padded?: boolean;
  /** Use the slightly-raised surface tone. */
  raised?: boolean;
}

export function Card({ children, padded = true, raised = false, style, ...rest }: CardProps) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: raised ? theme.colors.surface2 : theme.colors.surface,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: theme.radii.lg,
          padding: padded ? theme.spacing.lg : 0,
        },
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}
