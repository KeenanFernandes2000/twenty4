/**
 * __smoke.ts — the §7.5 render de-risk PROOF.
 *
 * 1. mint tiny test media with ffmpeg (2 gradient JPGs + 1 short testsrc MP4),
 * 2. build a VALID, beat-aligned ~30s EDL (contracts-validated) referencing them
 *    + one bundled track,
 * 3. serve the media over HTTP (Chrome blocks file://) and render headlessly via
 *    RemotionRenderer (srcMap → the temp media http URLs),
 * 4. ffprobe the result and ASSERT 1080×1920 / ~30.0s / h264 / has-audio,
 * 5. print the raw ffprobe + wall-clock render time.
 *
 * Run: `pnpm --filter @twenty4/worker smoke` (after `source ~/.twenty4-dev-env.sh`).
 */
import { mkdtemp, mkdir, copyFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildBeatAlignedEdl } from '@twenty4/remotion/sampleEdl';
import { RemotionRenderer } from './RemotionRenderer.js';
import {
  makeColorImage,
  makeTestVideo,
  probe,
  probeRawText,
  startMediaServer,
} from '../media/index.js';

const OUT_DIR = process.env.SMOKE_OUT_DIR ?? path.join(process.cwd(), '.smoke-out');

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main(): Promise<void> {
  console.log('=== twenty4 render smoke (§7.5 gate) ===');
  console.log(`FFMPEG_PATH=${process.env.FFMPEG_PATH ?? '(default)'}`);
  console.log(
    `REMOTION_BROWSER_EXECUTABLE=${process.env.REMOTION_BROWSER_EXECUTABLE ?? '(remotion-managed)'}`,
  );

  await mkdir(OUT_DIR, { recursive: true });
  const mediaDir = await mkdtemp(path.join(tmpdir(), 'twenty4-smoke-media-'));

  // 1. mint test media -------------------------------------------------------
  console.log('\n[1/5] minting test media with ffmpeg…');
  const img1 = path.join(mediaDir, 'photo-1.jpg');
  const img2 = path.join(mediaDir, 'photo-2.jpg');
  const vid1 = path.join(mediaDir, 'clip-1.mp4');
  await makeColorImage(img1, 'gradients=c0=0x223344:c1=0xff7a52', 1080, 1920).catch(
    // `gradients` may not exist on all builds; fall back to a solid color.
    () => makeColorImage(img1, '0xff7a52', 1080, 1920),
  );
  await makeColorImage(img2, '0x1fa572', 1080, 1920);
  await makeTestVideo(vid1, { durationSec: 5, width: 1080, height: 1920 });
  console.log(`  media dir: ${mediaDir}`);

  // 2. build a valid, beat-aligned EDL ---------------------------------------
  console.log('\n[2/5] building beat-aligned EDL (contracts-validated)…');
  const edl = buildBeatAlignedEdl({
    musicId: 'house_120', // 120 BPM synth track
    theme: 'Party',
    beatsPerSegment: 4, // a cut every 2s on the beat
    media: [
      { mediaRef: 'photo-1.jpg', mediaType: 'photo' },
      { mediaRef: 'clip-1.mp4', mediaType: 'video', sourceDurationMs: 5000 },
      { mediaRef: 'photo-2.jpg', mediaType: 'photo' },
    ],
  });
  console.log(
    `  EDL: ${edl.segments.length} segments, theme=${edl.themeStyle.theme}, ` +
      `music=${edl.audio.musicId}, durationMs=${edl.durationMs}`,
  );
  const lastSeg = edl.segments[edl.segments.length - 1]!;
  assert(
    lastSeg.startMs + lastSeg.durationMs === edl.durationMs,
    `EDL segments are gapless and fill ${edl.durationMs}ms`,
  );

  // Serve the temp media over HTTP (Chrome refuses file:// local resources).
  const server = await startMediaServer(mediaDir);
  console.log(`  media server: ${server.baseUrl}`);
  // srcMap: mediaRef → http URL of the temp media.
  const srcMap: Record<string, string> = {
    'photo-1.jpg': server.url('photo-1.jpg'),
    'clip-1.mp4': server.url('clip-1.mp4'),
    'photo-2.jpg': server.url('photo-2.jpg'),
  };

  // 3. render headlessly -----------------------------------------------------
  console.log('\n[3/5] rendering headlessly via RemotionRenderer…');
  const renderer = new RemotionRenderer();
  const t0 = Date.now();
  let result;
  try {
    result = await renderer.render(edl, {
      srcMap,
      outDir: OUT_DIR,
      outBasename: 'smoke-montage',
      onProgress: (p) => {
        if (Math.round(p * 100) % 20 === 0) {
          process.stdout.write(`\r  render progress: ${Math.round(p * 100)}%   `);
        }
      },
    });
  } finally {
    await server.close();
  }
  const wallMs = Date.now() - t0;
  process.stdout.write('\n');
  console.log(`  status=${result.status}`);
  console.log(`  video=${result.videoPath}`);
  console.log(`  thumb=${result.thumbnailPath}`);
  console.log(`  probed durationMs=${result.durationMs}`);
  console.log(`  ⏱  WALL-CLOCK RENDER TIME: ${(wallMs / 1000).toFixed(2)}s`);

  // 4. probe + assert --------------------------------------------------------
  console.log('\n[4/5] ffprobe assertions…');
  const p = await probe(result.videoPath);
  const sizeBytes = (await stat(result.videoPath)).size;

  assert(p.width === 1080, `width === 1080 (got ${p.width})`);
  assert(p.height === 1920, `height === 1920 (got ${p.height})`);
  assert(p.videoCodec === 'h264', `video codec === h264 (got ${p.videoCodec})`);
  assert(p.hasAudio, `has audio track (codec=${p.audioCodec})`);
  assert(
    Math.abs(p.durationMs - 30000) <= 200,
    `duration ≈ 30.0s ±0.2 (got ${(p.durationMs / 1000).toFixed(3)}s)`,
  );
  console.log(`  file size: ${(sizeBytes / 1024 / 1024).toFixed(2)} MiB`);

  // 5. raw ffprobe dump ------------------------------------------------------
  console.log('\n[5/5] RAW ffprobe output:');
  console.log('────────────────────────────────────────────────────────');
  console.log(await probeRawText(result.videoPath));
  console.log('────────────────────────────────────────────────────────');

  // Copy outputs to a stable location for inspection.
  const finalVideo = path.join(OUT_DIR, 'smoke-montage.mp4');
  if (result.videoPath !== finalVideo) await copyFile(result.videoPath, finalVideo);

  console.log('\n=== §10 timing budget ===');
  console.log(`  p50 target < 60s, p95 < 120s, hard timeout 5min`);
  console.log(
    `  this render: ${(wallMs / 1000).toFixed(2)}s — ` +
      `${wallMs < 60000 ? 'WITHIN p50 ✓' : wallMs < 120000 ? 'within p95' : 'OVER p95 ✗'}`,
  );
  console.log('\n✅ SMOKE PASSED — real 1080×1920 ~30s H.264 MP4 rendered headlessly.');
  console.log(`   Output: ${finalVideo}`);
}

main().catch((err) => {
  console.error('\n❌ SMOKE FAILED');
  console.error(err);
  process.exit(1);
});
