/**
 * Remotion config — used by `remotion studio` and the CLI. The worker
 * (`@twenty4/worker`) drives renders programmatically via `@remotion/renderer`
 * and sets codec/concurrency/image-format itself (see RemotionRenderer), so
 * these settings primarily affect the Studio / CLI preview path.
 */
import { Config } from '@remotion/cli/config';

// 9:16 stills use JPEG frames during the H.264 encode (smaller, faster).
Config.setVideoImageFormat('jpeg');
// Deterministic: a single, fixed canvas. Overlays must not produce non-deterministic output.
Config.setConcurrency(null); // null = auto (Remotion picks based on cores)
Config.setChromiumOpenGlRenderer('angle');
