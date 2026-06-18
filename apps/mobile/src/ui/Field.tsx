/**
 * Field — labeled text input with optional error, Ember-themed.
 */
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { useTheme } from '../theme';

export interface FieldProps extends Omit<TextInputProps, 'style'> {
  label?: string;
  error?: string;
  hint?: string;
}

export function Field({ label, error, hint, ...inputProps }: FieldProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const borderColor = error
    ? theme.colors.danger
    : focused
      ? theme.colors.accent
      : theme.colors.border;

  return (
    <View style={styles.wrap}>
      {label ? (
        <Text style={{ ...theme.typography.label, color: theme.colors.label }}>{label}</Text>
      ) : null}
      <TextInput
        placeholderTextColor={theme.colors.faint}
        onFocus={(e) => {
          setFocused(true);
          inputProps.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          inputProps.onBlur?.(e);
        }}
        style={[
          styles.input,
          {
            backgroundColor: theme.colors.field,
            borderColor,
            borderRadius: theme.radii.md,
            color: theme.colors.text,
            fontFamily: theme.fontFamily.regular,
          },
        ]}
        {...inputProps}
      />
      {error ? (
        <Text style={{ ...theme.typography.caption, color: theme.colors.danger }}>{error}</Text>
      ) : hint ? (
        <Text style={{ ...theme.typography.caption, color: theme.colors.muted }}>{hint}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6, alignSelf: 'stretch' },
  input: {
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontSize: 15,
  },
});
