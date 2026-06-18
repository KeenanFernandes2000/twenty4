/**
 * Remotion entry point — registers the root. This is the file the worker's
 * `@remotion/bundler` bundles, and the file `remotion studio` opens.
 */
import { registerRoot } from 'remotion';
import { RemotionRoot } from './Root';

registerRoot(RemotionRoot);
