// upload/transfer — type face + misconfiguration tripwire for the platform split.
//
// Metro resolves `./transfer.native.ts` on iOS/Android and `./transfer.web.ts`
// on web (platform extensions). TypeScript, which ignores the .native/.web
// split, resolves THIS module — so the `PutFile` type declared here (imported
// from ./types) is the contract both platform impls must satisfy. Mirrors the
// existing secureStore.ts pattern.
//
// UNLIKE secureStore.ts (which re-exports from .native for its type face), the
// runtime body here is a TRIPWIRE: if Metro ever resolves this base module
// instead of a platform file (a misconfigured split), the upload fails loudly
// instead of silently doing nothing. At bundle time Metro prefers
// transfer.web.ts / transfer.native.ts, so this throw is only ever hit on a
// misconfiguration.

import type { PutFile } from './types';

export const putFile: PutFile = () => {
  throw new Error(
    'upload transfer: no platform implementation resolved (transfer.ts loaded instead of .native/.web)',
  );
};
