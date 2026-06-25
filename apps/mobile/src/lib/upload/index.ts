// upload — barrel for the M6 transfer subsystem.
//
// `putFile` is re-exported from ./transfer, which Metro resolves to
// ./transfer.native.ts or ./transfer.web.ts at bundle time (platform split);
// tsc resolves ./transfer.ts (the type face + tripwire). The contract types and
// the abort-error helpers come from ./types.
//
// `statSize` is re-exported from ./fileInfo (same platform-split scheme): Metro
// resolves ./fileInfo.native.ts or ./fileInfo.web.ts at bundle time; tsc resolves
// ./fileInfo.ts (the type face + tripwire). Splitting keeps expo-file-system out
// of the web bundle for size-resolution too.
//
// Callers: import { putFile, statSize, isAbortError, UploadAbortedError } from '@/lib/upload'.
export { putFile } from './transfer';
export { statSize } from './fileInfo';
export * from './types';
