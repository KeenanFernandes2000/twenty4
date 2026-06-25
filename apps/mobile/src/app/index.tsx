// Root route "/" — the entry point. It doesn't render UI; it just redirects into
// the (app) group. The AuthGate (mounted in _layout.tsx) then corrects the
// destination based on auth status:
//   • loading        → the gate shows a Spinner over everything (no flash here).
//   • unauthenticated → gate bounces (app) → /(auth)/welcome.
//   • needs-profile   → gate bounces → /(auth)/profile-setup.
//   • suspended       → gate renders SuspendedScreen globally.
//   • authenticated   → stays in /(app).
import { Redirect } from 'expo-router';

export default function Index() {
  return <Redirect href="/(app)" />;
}
