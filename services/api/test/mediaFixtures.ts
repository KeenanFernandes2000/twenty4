// Synthetic test-media generators (M4) — headless, no dependency on
// fixtures/sample-media being populated. We produce:
//   - a tiny JPEG WITH EXIF DateTimeOriginal (for the EXIF-tier hierarchy test)
//   - a plain JPEG/PNG WITHOUT EXIF (for the media-library / file-creation tiers)
//   - a tiny valid MP4 (for the video duration probe)
//
// JPEG-with-EXIF is built by hand: a baseline JPEG (synthesized via ffmpeg) with a
// minimal APP1/Exif segment carrying DateTimeOriginal injected after SOI. MP4 is
// synthesized via ffmpeg (static binary on this box). This keeps the headless
// suite self-contained.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FFMPEG = process.env.FFMPEG_PATH ?? "/home/keenan/bin/ffmpeg";

// ── MP4 ───────────────────────────────────────────────────────────────────────
// Synthesize a tiny valid MP4 of `seconds` duration (default ~2s).
export function makeMp4(seconds = 2): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "t4fix-"));
  const file = join(dir, "v.mp4");
  try {
    const r = spawnSync(
      FFMPEG,
      [
        "-f", "lavfi",
        "-i", `testsrc=duration=${seconds}:size=64x64:rate=10`,
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-y", file,
      ],
      { encoding: "buffer" },
    );
    if (r.status !== 0) throw new Error(`ffmpeg mp4 synth failed: ${r.stderr?.toString()}`);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Non-image bytes (magic-byte spoof) ────────────────────────────────────────
// A buffer that is NOT any allowed media container — an ELF header followed by
// random padding. Used by the CRITICAL-1 spoof test: PUT these bytes with a
// Content-Type of image/jpeg and the worker must sniff the real header → invalid.
export function makeNonImageBytes(len = 256): Buffer {
  const buf = Buffer.alloc(len);
  // ELF magic: 7F 45 4C 46.
  buf[0] = 0x7f;
  buf[1] = 0x45;
  buf[2] = 0x4c;
  buf[3] = 0x46;
  for (let i = 4; i < len; i++) buf[i] = (i * 37 + 11) & 0xff;
  return buf;
}

// ── Plain JPEG (no EXIF) ──────────────────────────────────────────────────────
export function makeJpegNoExif(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "t4fix-"));
  const file = join(dir, "p.jpg");
  try {
    const r = spawnSync(
      FFMPEG,
      ["-f", "lavfi", "-i", "color=c=blue:size=32x32:duration=1:rate=1", "-frames:v", "1", "-y", file],
      { encoding: "buffer" },
    );
    if (r.status !== 0) throw new Error(`ffmpeg jpeg synth failed: ${r.stderr?.toString()}`);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── PNG (no EXIF) ─────────────────────────────────────────────────────────────
export function makePngNoExif(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "t4fix-"));
  const file = join(dir, "p.png");
  try {
    const r = spawnSync(
      FFMPEG,
      ["-f", "lavfi", "-i", "color=c=red:size=32x32:duration=1:rate=1", "-frames:v", "1", "-y", file],
      { encoding: "buffer" },
    );
    if (r.status !== 0) throw new Error(`ffmpeg png synth failed: ${r.stderr?.toString()}`);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── JPEG WITH EXIF DateTimeOriginal ───────────────────────────────────────────
// Build a minimal little-endian TIFF/Exif structure with one IFD0 pointer to an
// Exif sub-IFD carrying DateTimeOriginal (tag 0x9003), wrap it in an APP1 segment,
// and splice it into a baseline JPEG right after the SOI marker.
//
// `when` is formatted as the EXIF "YYYY:MM:DD HH:MM:SS" string (LOCAL wall-clock —
// EXIF carries no tz; exifr parses it as a naive Date which we treat as the device
// local time). The caller passes a UTC instant; we render its components so the
// resolved bucket matches the device timezone the test uses.
export function makeJpegWithExif(exifDateString: string): Buffer {
  const base = makeJpegNoExif();
  const app1 = buildExifApp1(exifDateString);
  // Insert APP1 immediately after SOI (first 2 bytes 0xFFD8).
  return Buffer.concat([base.subarray(0, 2), app1, base.subarray(2)]);
}

// Format a Date's LOCAL-rendered components (in a given tz) as an EXIF date string.
export function exifDateStringFor(instant: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const p = fmt.formatToParts(instant);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}:${g("month")}:${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
}

function buildExifApp1(dateString: string): Buffer {
  // EXIF date strings are exactly 20 bytes (19 chars + NUL).
  const dateBytes = Buffer.alloc(20, 0);
  dateBytes.write(dateString.slice(0, 19), "ascii");

  // TIFF header (little-endian) starts after "Exif\0\0".
  // Layout:
  //   [0..1]   "II"
  //   [2..3]   0x002A
  //   [4..7]   offset to IFD0 = 8
  //   IFD0 @8: count=1; entry: ExifIFDPointer(0x8769) LONG ptr→exifIFD; next=0
  //   ExifIFD: count=1; entry: DateTimeOriginal(0x9003) ASCII[20] offset→dateBytes; next=0
  //   dateBytes
  const tiff = Buffer.alloc(2 + 2 + 4); // header
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(0x002a, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 at offset 8

  // An IFD is: count(2) + entries(12 each) + nextIFD(4). Within a 12-byte entry:
  //   tag@0, type@2, count@4, value/offset@8. So in the IFD buffer (count prefix),
  //   the first entry starts at byte 2: tag@2, type@4, count@6, value@10, next@14.

  // IFD0
  const ifd0 = Buffer.alloc(2 + 12 + 4); // 18 bytes
  ifd0.writeUInt16LE(1, 0); // 1 entry
  ifd0.writeUInt16LE(0x8769, 2); // ExifIFDPointer
  ifd0.writeUInt16LE(4, 4); // type LONG
  ifd0.writeUInt32LE(1, 6); // count
  // value (offset to ExifIFD) @10, filled below
  ifd0.writeUInt32LE(0, 14); // next IFD = 0

  // ExifIFD
  const exifIfd = Buffer.alloc(2 + 12 + 4); // 18 bytes
  exifIfd.writeUInt16LE(1, 0); // 1 entry
  exifIfd.writeUInt16LE(0x9003, 2); // DateTimeOriginal
  exifIfd.writeUInt16LE(2, 4); // type ASCII
  exifIfd.writeUInt32LE(20, 6); // count = 20 bytes
  // value offset @10, filled below
  exifIfd.writeUInt32LE(0, 14); // next IFD = 0

  // Compute offsets (all relative to TIFF start).
  const ifd0Offset = 8;
  const exifIfdOffset = ifd0Offset + ifd0.length; // right after IFD0
  const dateOffset = exifIfdOffset + exifIfd.length; // right after ExifIFD

  ifd0.writeUInt32LE(exifIfdOffset, 10); // ExifIFDPointer value
  exifIfd.writeUInt32LE(dateOffset, 10); // DateTimeOriginal value offset

  const tiffBlock = Buffer.concat([tiff, ifd0, exifIfd, dateBytes]);
  const exifBlock = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiffBlock]);

  // APP1 marker + length (length includes the 2 length bytes themselves).
  const app1Len = exifBlock.length + 2;
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0); // APP1
  header.writeUInt16BE(app1Len, 2);
  return Buffer.concat([header, exifBlock]);
}
