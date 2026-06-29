// ConfirmProvider — the app's single themed destructive-confirm dialog (Ember).
//
// Mounted ONCE under the authed-app layout ((app)/_layout). It registers an
// imperative open-handler with @/lib/confirm, so the standalone `confirm({...})`
// call used across the screens drives THIS dialog and its promise resolves on the
// themed button taps. Replaces the old native Alert / window.confirm (off-theme).
//
// Web-safe: uses react-native-web's <Modal> + the Ember UI primitives only.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { Button, Text } from '@/ui';
import { useTheme } from '@/theme';
import { registerConfirmHandler, type ConfirmOptions } from '@/lib/confirm';

interface ActiveConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const [active, setActive] = useState<ActiveConfirm | null>(null);
  // Guards a double-resolve (e.g. a button tap racing onRequestClose).
  const resolvedRef = useRef(false);

  // Register the imperative open-handler once; confirm() delegates here.
  useEffect(
    () =>
      registerConfirmHandler(
        (options) =>
          new Promise<boolean>((resolve) => {
            resolvedRef.current = false;
            setActive({ ...options, resolve });
          }),
      ),
    [],
  );

  // Resolve the pending promise (once) and close.
  const settle = useCallback((value: boolean) => {
    setActive((cur) => {
      if (cur && !resolvedRef.current) {
        resolvedRef.current = true;
        cur.resolve(value);
      }
      return null;
    });
  }, []);

  const destructive = active?.destructive ?? true;

  return (
    <>
      {children}
      <Modal
        visible={active != null}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => settle(false)}
      >
        {active ? (
          // Scrim — tapping outside the panel cancels.
          <Pressable
            onPress={() => settle(false)}
            style={{
              flex: 1,
              backgroundColor: theme.colors.scrim,
              alignItems: 'center',
              justifyContent: 'center',
              padding: theme.spacing.xl,
            }}
            testID="confirm-overlay"
          >
            {/* Panel — captures inner taps so they don't dismiss. */}
            <Pressable
              onPress={() => {}}
              style={[
                {
                  width: '100%',
                  maxWidth: 420,
                  backgroundColor: theme.colors.surface,
                  borderRadius: theme.radii.xxl,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  padding: theme.spacing.xxl,
                  gap: theme.spacing.base,
                },
                theme.shadow('modal'),
              ]}
              testID="confirm-modal"
            >
              <Text variant="title">{active.title}</Text>
              {active.message ? (
                <Text variant="body" color="secondary">
                  {active.message}
                </Text>
              ) : null}
              <View
                style={{
                  flexDirection: 'row',
                  gap: theme.spacing.base,
                  marginTop: theme.spacing.sm,
                }}
              >
                <Button
                  variant="secondary"
                  title={active.cancelLabel ?? 'Cancel'}
                  onPress={() => settle(false)}
                  style={{ flex: 1 }}
                  fullWidth
                  testID="confirm-cancel"
                />
                <Button
                  variant={destructive ? 'danger' : 'primary'}
                  title={active.confirmLabel ?? 'Confirm'}
                  onPress={() => settle(true)}
                  style={{ flex: 1 }}
                  fullWidth
                  testID="confirm-accept"
                />
              </View>
            </Pressable>
          </Pressable>
        ) : null}
      </Modal>
    </>
  );
}
