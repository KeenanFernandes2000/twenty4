/**
 * /states-error — a dev/screenshot-only route that deliberately THROWS during
 * render so the global ErrorBoundary (root layout) is exercised. It exists so the
 * 7.x "Error+retry" global state can be demonstrated/screenshotted without crashing
 * a real screen, and so the boundary's recovery ("Try again") can be verified.
 *
 * It throws unconditionally on render; the nearest ErrorBoundary catches it and
 * shows the themed ErrorRetry fallback. Not linked from any UI — reachable only by
 * navigating to /states-error directly. Harmless in production (an unused route).
 */
export default function StatesError(): never {
  throw new Error('Intentional render error (7.x global ErrorBoundary demo).');
}
