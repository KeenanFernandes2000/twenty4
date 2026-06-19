/**
 * OtpInput — 6-cell one-time-code entry (Ember-themed).
 *
 * A single hidden TextInput owns the value; the cells are presentational. This
 * keeps native autofill / paste working while letting us style each digit. The
 * active (next-to-fill) cell gets an accent border.
 */
import { useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { useTheme } from '../theme';

export interface OtpInputProps {
  value: string;
  onChange: (value: string) => void;
  length?: number;
  /** Fires when the full code length is entered. */
  onComplete?: (value: string) => void;
  error?: boolean;
  autoFocus?: boolean;
}

export function OtpInput({
  value,
  onChange,
  length = 6,
  onComplete,
  error = false,
  autoFocus = true,
}: OtpInputProps) {
  const theme = useTheme();
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);

  const cells = Array.from({ length });

  function handleChange(raw: string) {
    const digits = raw.replace(/[^0-9]/g, '').slice(0, length);
    onChange(digits);
    if (digits.length === length) onComplete?.(digits);
  }

  return (
    <Pressable onPress={() => inputRef.current?.focus()}>
      <View style={{ flexDirection: 'row', gap: theme.spacing.sm, justifyContent: 'center' }}>
        {cells.map((_, i) => {
          const char = value[i] ?? '';
          const isActive = focused && i === value.length;
          const borderColor = error
            ? theme.colors.danger
            : isActive
              ? theme.colors.accent
              : theme.colors.border;
          return (
            <View
              key={i}
              style={{
                flex: 1,
                aspectRatio: 1,
                maxWidth: 56,
                borderRadius: theme.radii.lg,
                backgroundColor: theme.colors.field,
                borderWidth: 1.5,
                borderColor,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text
                style={{
                  fontFamily: theme.fontFamily.monoBold,
                  fontSize: 24,
                  color: theme.colors.text,
                }}
              >
                {char}
              </Text>
            </View>
          );
        })}
      </View>

      {/* Hidden controller input */}
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={handleChange}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={length}
        autoFocus={autoFocus}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        // Visually hidden but still interactive/focusable.
        style={{ position: 'absolute', opacity: 0, height: 1, width: 1 }}
      />
    </Pressable>
  );
}
