import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Animated,
  Pressable,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { Text } from './Text';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastOptions {
  type?: ToastType;
  message: string;
  /** Auto-dismiss after ms (default 3000). */
  duration?: number;
}

interface ToastContextValue {
  show: (opts: ToastOptions) => void;
  hide: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

interface ActiveToast extends Required<Omit<ToastOptions, 'duration'>> {
  id: number;
  duration: number;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ActiveToast | null>(null);
  const idRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    clearTimer();
    setToast(null);
  }, [clearTimer]);

  const show = useCallback(
    (opts: ToastOptions) => {
      clearTimer();
      const duration = opts.duration ?? 3000;
      const next: ActiveToast = {
        id: ++idRef.current,
        type: opts.type ?? 'info',
        message: opts.message,
        duration,
      };
      setToast(next);
      if (duration > 0) {
        timerRef.current = setTimeout(() => {
          setToast((cur) => (cur?.id === next.id ? null : cur));
        }, duration);
      }
    },
    [clearTimer],
  );

  useEffect(() => clearTimer, [clearTimer]);

  return (
    <ToastContext.Provider value={{ show, hide }}>
      {children}
      {toast ? <ToastView key={toast.id} toast={toast} onDismiss={hide} /> : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a <ToastProvider>');
  }
  return ctx;
}

function ToastView({
  toast,
  onDismiss,
}: {
  toast: ActiveToast;
  onDismiss: () => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [anim]);

  const accentColor =
    toast.type === 'success'
      ? theme.colors.success
      : toast.type === 'error'
        ? theme.colors.danger
        : theme.colors.accent;

  const wrapStyle: ViewStyle = {
    position: 'absolute',
    left: theme.spacing.xl,
    right: theme.spacing.xl,
    bottom: insets.bottom + theme.spacing.xl,
  };

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        wrapStyle,
        {
          opacity: anim,
          transform: [
            {
              translateY: anim.interpolate({
                inputRange: [0, 1],
                outputRange: [24, 0],
              }),
            },
          ],
        },
      ]}
    >
      <Pressable
        onPress={onDismiss}
        accessibilityRole="alert"
        style={[
          {
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: theme.colors.surface2,
            borderRadius: theme.radii.lg,
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderLeftWidth: 4,
            borderLeftColor: accentColor,
            paddingVertical: theme.spacing.lg,
            paddingHorizontal: theme.spacing.xl,
          },
          theme.shadow('modal'),
        ]}
      >
        <Text variant="body" color="primary" style={{ flex: 1 }}>
          {toast.message}
        </Text>
      </Pressable>
    </Animated.View>
  );
}
