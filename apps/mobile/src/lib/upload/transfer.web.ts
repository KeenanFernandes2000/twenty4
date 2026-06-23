/**
 * transfer.web — foreground PUT for web export (the screenshot/preview target).
 *
 * Web has no background-upload module, so we use XHR for real upload-progress
 * events (fetch can't report request-body progress in browsers). The blob is
 * fetched from the local `uri` (blob:/data:/http) then PUT to the presigned URL.
 * This is the spec's "foreground uploadAsync/fetch fallback on web".
 *
 * The implementation lives in `transfer.foreground.ts` (shared with the native
 * Expo-Go fallback in transfer.native.ts) — behavior here is unchanged.
 */
import { putFileForeground } from './transfer.foreground';
import type { PutFile } from './transfer';

export const putFile: PutFile = putFileForeground;
