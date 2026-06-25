// upload/transfer.native — NATIVE platform implementation (iOS/Android).
//
// Metro picks this over transfer.web.ts on native. It presence-DETECTS the
// background-upload native module via NativeModules — it NEVER imports
// `react-native-background-upload`. That package is not installed, and a static
// `import 'react-native-background-upload'` would break the Metro bundle. So we
// only probe the already-loaded native registry; no static import exists
// anywhere for it.
//
// In Expo Go the module is always absent → we delegate to the expo-file-system
// streaming uploader (disk-backed, heap-safe) and emit a ONE-TIME dev warning.
// Real native/background upload lands in M13.

import { NativeModules } from 'react-native';

import { putFile as putFileViaFileSystem } from './transfer.fileSystem.native';
import type { PutFile } from './types';

// Detect WITHOUT importing the package. RNFileUploader is the module name
// exposed by react-native-background-upload; VydiaRNFileUploader is its older
// alias. Both absent in Expo Go.
const hasBgUploader = !!(
  NativeModules.RNFileUploader || NativeModules.VydiaRNFileUploader
);

// Fire the dev warning exactly once across all uploads.
let warned = false;

export const putFile: PutFile = (args) => {
  if (!warned) {
    warned = true;
    if (hasBgUploader) {
      // Module is present but we can't call it: the package isn't installed, so
      // there's no JS binding. Still fall through to the file-system path so M6
      // works everywhere.
      console.warn(
        '[twenty4] background-upload native module present but not wired until M13 — using expo-file-system streaming.',
      );
    } else {
      console.warn(
        '[twenty4] background-upload native module not found — using expo-file-system streaming (Expo Go). Native/background upload lands in M13.',
      );
    }
  }
  // Always delegate to the heap-safe streaming uploader in M6.
  return putFileViaFileSystem(args);
};
