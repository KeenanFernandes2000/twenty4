import { useRef, useState } from 'react';
import {
  Pressable,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme';
import { Text } from './Text';

export interface OTPInputProps {
  length?: number;
  value: string;
  onChangeText: (text: string) => void;
  /** Fired once when the code reaches `length` digits. */
  onComplete?: (code: string) => void;
  autoFocus?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * Robust OTP pattern: a single hidden TextInput captures all input (incl paste),
 * and we render `length` display cells driven by `value`. Tapping any cell focuses
 * the hidden input (works on web). Only digits are kept; input is clamped to length.
 */
export function OTPInput({
  length = 6,
  value,
  onChangeText,
  onComplete,
  autoFocus = false,
  style,
}: OTPInputProps) {
  const theme = useTheme();
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);

  const handleChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, length);
    onChangeText(digits);
    if (digits.length === length) {
      onComplete?.(digits);
    }
  };

  const focus = () => inputRef.current?.focus();

  const cells = Array.from({ length }, (_, i) => {
    const char = value[i] ?? '';
    const isCurrent = focused && i === Math.min(value.length, length - 1);
    const filled = char !== '';
    const borderColor =
      isCurrent || filled ? theme.colors.accent : theme.colors.border;

    return (
      <View
        key={i}
        style={{
          flex: 1,
          aspectRatio: 0.82,
          maxWidth: 56,
          backgroundColor: theme.colors.field,
          borderRadius: theme.radii.md,
          borderWidth: isCurrent ? 2 : 1.5,
          borderColor,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text
          style={{
            fontFamily: theme.fonts.monoBold,
            fontSize: 22,
            color: theme.colors.textPrimary,
          }}
        >
          {char}
        </Text>
      </View>
    );
  });

  return (
    <Pressable onPress={focus} style={[styles.row, { gap: theme.spacing.md }, style]}>
      {cells}
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={handleChange}
        keyboardType="number-pad"
        autoFocus={autoFocus}
        maxLength={length}
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        // Hidden but focusable + still receives paste. Kept on-screen (not
        // display:none) so web/native both deliver key + paste events.
        style={styles.hiddenInput}
        caretHidden
      />
    </Pressable>
  );
}

const styles = {
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  } as ViewStyle,
  hiddenInput: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    top: 0,
    left: 0,
  } as TextStyle,
};
