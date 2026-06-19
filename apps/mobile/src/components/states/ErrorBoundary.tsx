/**
 * ErrorBoundary — the global 7.x render-error catch (Error+retry).
 *
 * Wraps the navigator in the root layout. A render-time crash anywhere in the
 * tree is caught here and shown as the themed ErrorRetry state instead of a white
 * screen / red box. "Try again" remounts the subtree (resets the boundary) so a
 * transient render error recovers without a full app restart.
 *
 * This complements (does not replace) React Query's GLOBAL error handling: query
 * failures (401 → sign-out, SuspendedError → 7.5, transient → ErrorRetry pane in
 * the screen) are handled in lib/queryClient + per-screen `isError`. This boundary
 * is the last-resort net for an actual render exception.
 *
 * Class component because error boundaries require the lifecycle API; the fallback
 * is a themed function component (hooks live there, not in the class).
 *
 * Web-safe: pure RN + theme.
 */
import { Component, type ReactNode } from 'react';
import { View } from 'react-native';

import { useTheme } from '../../theme';
import { ErrorRetry } from '../../ui';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/** Themed fallback shown when the boundary has caught an error. */
function BoundaryFallback({ onRetry }: { onRetry: () => void }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.bg,
        justifyContent: 'center',
      }}
    >
      <ErrorRetry
        title="Something broke"
        message="The app hit an unexpected error. Try again — if it keeps happening, restart the app."
        onRetry={onRetry}
      />
    </View>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // Surface in dev; a [TEAM] crash reporter (Sentry, etc.) hooks in here in prod.
    if (__DEV__) console.error('[ErrorBoundary] caught render error:', error);
  }

  reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    if (this.state.error) {
      return <BoundaryFallback onRetry={this.reset} />;
    }
    return this.props.children;
  }
}
