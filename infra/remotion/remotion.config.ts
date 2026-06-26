// Remotion config — used by `remotion studio` / `remotion render` CLIs and the
// bundler defaults. The programmatic render driver (render.mjs) passes the
// perf-critical knobs (codec, x264Preset, crf, chromiumOptions.gl, concurrency)
// explicitly via renderMedia() options, so it does NOT depend on this file —
// but keeping the defaults here in sync makes `remotion studio` previews match.
import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setStillImageFormat("jpeg");
Config.setCodec("h264");
Config.setCrf(23);
Config.setX264Preset("veryfast");
Config.setConcurrency(1);
// CRITICAL perf knob (PHASE1 recap §8.6): gl MUST be null, not 'angle' (~9x faster).
Config.setChromiumOpenGlRenderer(null);
Config.setOverwriteOutput(true);
