/**
 * ffprobe/ffmpeg helpers (via execa, using the static binaries from the dev env).
 *
 * The renderer uses these to (a) probe the rendered MP4's real dims/duration/codec
 * for the §7.2 return value and the §7.5 gate assertions, and (b) extract a poster
 * frame for the thumbnail. Binaries come from FFMPEG_PATH / FFPROBE_PATH.
 */
import { execa } from 'execa';

export const FFMPEG_PATH = process.env.FFMPEG_PATH ?? 'ffmpeg';
export const FFPROBE_PATH = process.env.FFPROBE_PATH ?? 'ffprobe';

export interface ProbeResult {
  width: number;
  height: number;
  durationMs: number;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  /** The raw ffprobe JSON (for logging / the gate's "print the raw ffprobe"). */
  raw: unknown;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}
interface FfprobeJson {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

/** Probe a media file → normalized dims/duration/codecs + raw JSON. */
export async function probe(filePath: string): Promise<ProbeResult> {
  const { stdout } = await execa(FFPROBE_PATH, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  const json = JSON.parse(stdout) as FfprobeJson;
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  const durSec =
    parseFloat(json.format?.duration ?? '') ||
    parseFloat(video?.duration ?? '') ||
    0;

  return {
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    durationMs: Math.round(durSec * 1000),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    hasAudio: Boolean(audio),
    raw: json,
  };
}

/** Raw ffprobe text dump (human-readable) — used by the gate report. */
export async function probeRawText(filePath: string): Promise<string> {
  // ffprobe prints the human-readable format/stream summary to STDERR (and exits
  // 0). Capture both streams so the gate can echo the raw output verbatim.
  const res = await execa(FFPROBE_PATH, ['-hide_banner', '-i', filePath], {
    reject: false,
    all: true,
  });
  return res.all ?? `${res.stdout}${res.stderr}`;
}
