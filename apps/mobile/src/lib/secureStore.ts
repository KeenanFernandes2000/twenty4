// secureStore — type-facing re-export of the platform-split implementation.
//
// Metro resolves `./secureStore.native.ts` on iOS/Android and
// `./secureStore.web.ts` on web automatically (platform extensions). This file
// exists so callers can `import { ... } from '@/lib/secureStore'` and get a
// stable type surface on BOTH platforms — TypeScript resolves THIS module (it
// ignores the .native/.web split), so the contract declared here is the source
// of truth that both implementations must satisfy.
//
// Single-token session store. The token is the bearer returned by
// POST /auth/verify; the api-client reads it via `getToken` (in-memory) and the
// authStore mirrors it here for durable persistence across launches.

export { getToken, setToken, deleteToken, SESSION_TOKEN_KEY } from './secureStore.native';
