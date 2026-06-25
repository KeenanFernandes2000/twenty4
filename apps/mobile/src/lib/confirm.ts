// confirm — a tiny cross-platform confirm() for destructive actions.
//
// On native we use RN's Alert.alert with a cancel + a (destructive) confirm button
// and resolve a boolean. On web, react-native-web's Alert.alert does not render a
// real dialog, so we fall back to the DOM `window.confirm`. Either way the caller
// gets a `Promise<boolean>`.
import { Alert, Platform } from 'react-native';

export interface ConfirmOptions {
  title: string;
  message?: string;
  /** Label for the confirm action. Default "Confirm". */
  confirmLabel?: string;
  /** Label for the cancel action. Default "Cancel". */
  cancelLabel?: string;
  /** Style the confirm as destructive (native only). Default true. */
  destructive?: boolean;
}

export function confirm({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = true,
}: ConfirmOptions): Promise<boolean> {
  if (Platform.OS === 'web') {
    // window may be undefined during SSR/static export; guard it.
    if (typeof globalThis !== 'undefined' && typeof (globalThis as { confirm?: unknown }).confirm === 'function') {
      const text = message != null ? `${title}\n\n${message}` : title;
      return Promise.resolve((globalThis as unknown as { confirm: (m: string) => boolean }).confirm(text));
    }
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: cancelLabel, style: 'cancel', onPress: () => resolve(false) },
        {
          text: confirmLabel,
          style: destructive ? 'destructive' : 'default',
          onPress: () => resolve(true),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
