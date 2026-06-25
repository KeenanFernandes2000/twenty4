import { useState, type ReactNode } from 'react';
import {
  TextInput,
  View,
  type KeyboardTypeOptions,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme';
import { Text } from './Text';

export interface InputProps
  extends Pick<
    TextInputProps,
    'autoFocus' | 'onBlur' | 'onFocus' | 'onSubmitEditing' | 'returnKeyType' | 'maxLength' | 'editable'
  > {
  label?: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  error?: string;
  secureTextEntry?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: TextInputProps['autoCapitalize'];
  /** Trailing element inside the field (e.g. an eye toggle). */
  rightSlot?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function Input({
  label,
  value,
  onChangeText,
  placeholder,
  error,
  secureTextEntry,
  keyboardType,
  autoCapitalize = 'none',
  rightSlot,
  autoFocus,
  onBlur,
  onFocus,
  style,
  ...rest
}: InputProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);

  const borderColor = error
    ? theme.colors.danger
    : focused
      ? theme.colors.accent
      : theme.colors.border;

  return (
    <View style={style}>
      {label != null ? (
        <Text variant="label" color="label" style={{ marginBottom: theme.spacing.sm }}>
          {label}
        </Text>
      ) : null}

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: theme.colors.field,
          borderRadius: theme.radii.lg,
          borderWidth: focused || error ? 2 : 1.5,
          borderColor,
          paddingHorizontal: theme.spacing.lg,
          minHeight: 52,
        }}
      >
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textFaint}
          secureTextEntry={secureTextEntry}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoFocus={autoFocus}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={{
            flex: 1,
            color: theme.colors.textPrimary,
            fontFamily: theme.fonts.bold,
            fontSize: theme.type.body.fontSize,
            paddingVertical: theme.spacing.base,
          }}
          {...rest}
        />
        {rightSlot != null ? (
          <View style={{ marginLeft: theme.spacing.md }}>{rightSlot}</View>
        ) : null}
      </View>

      {error != null && error.length > 0 ? (
        <Text variant="caption" color="danger" style={{ marginTop: theme.spacing.sm }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
