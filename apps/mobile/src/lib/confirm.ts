// confirm — a themed, promise-based confirm() for destructive actions.
//
// The call API is UNCHANGED: `confirm({ title, message, confirmLabel, destructive })`
// returns `Promise<boolean>`. It no longer uses the native `Alert.alert` / DOM
// `window.confirm` (those looked like default OS dialogs, off-theme). Instead it
// drives a single themed `<ConfirmProvider>` mounted once at the authed-app root
// (see components/ConfirmProvider). The provider REGISTERS its imperative
// open-handler here on mount; `confirm()` delegates to it and the returned promise
// resolves on the themed button taps. Works on web too (react-native-web Modal).

export interface ConfirmOptions {
  title: string;
  message?: string;
  /** Label for the confirm action. Default "Confirm". */
  confirmLabel?: string;
  /** Label for the cancel action. Default "Cancel". */
  cancelLabel?: string;
  /** Style the confirm as destructive (red). Default true. */
  destructive?: boolean;
}

type ConfirmHandler = (opts: ConfirmOptions) => Promise<boolean>;

// The mounted provider's open-handler (null until <ConfirmProvider> mounts).
let activeHandler: ConfirmHandler | null = null;

/**
 * Register the provider's imperative open-handler. Returns an unregister fn for the
 * effect cleanup. Called once by <ConfirmProvider> on mount.
 */
export function registerConfirmHandler(handler: ConfirmHandler): () => void {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) activeHandler = null;
  };
}

/**
 * Ask the user to confirm a (usually destructive) action. Resolves `true` when they
 * confirm, `false` when they cancel/dismiss. Delegates to the mounted
 * `<ConfirmProvider>`; if none is mounted (shouldn't happen inside the authed app)
 * it safely resolves `false` so the destructive action is NOT taken.
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  if (!activeHandler) {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn('[confirm] No <ConfirmProvider> mounted; resolving false.');
    }
    return Promise.resolve(false);
  }
  return activeHandler(options);
}
