/**
 * suspensionStore — global "account paused" gate (7.5).
 *
 * The api-client throws `SuspendedError` (403 `suspended`) for any request made
 * by a suspended/banned account. The query client (lib/queryClient.ts) catches
 * it globally and flips `suspended` here; the root layout then renders the
 * Suspended screen INSTEAD of the tabs (the user keeps a live session — sessions
 * are revoked server-side on ban, which surfaces as a 401 → sign-out — but a
 * soft suspension simply blocks every write/read with this code).
 *
 * `reason` carries the optional server message for the copy. `clear()` is used
 * when the user signs out from the Suspended screen.
 */
import { create } from 'zustand';

import { safetyMockMode } from '../lib/safetyMocks';

interface SuspensionState {
  suspended: boolean;
  reason: string | null;
  /** Flip the global gate on (idempotent). */
  setSuspended: (reason?: string | null) => void;
  /** Clear the gate (on sign-out / unsuspend). */
  clear: () => void;
}

// Seed the gate from the safety mock ('suspended') so the web-export screenshot
// harness can render 7.5 without an API. On a device the mock is 'off' → false.
const initialSuspended = safetyMockMode() === 'suspended';

export const useSuspensionStore = create<SuspensionState>((set) => ({
  suspended: initialSuspended,
  reason: null,
  setSuspended: (reason = null) => set({ suspended: true, reason }),
  clear: () => set({ suspended: false, reason: null }),
}));
