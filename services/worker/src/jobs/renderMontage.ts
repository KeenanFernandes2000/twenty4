/**
 * `render-montage` job (§7.3) — WIRES the Slice-1 render pipeline to real user
 * media. This is the worker half of Slice 5: the API creates a `generating`
 * montage row + enqueues this job; we turn the user's VALID daily media into the
 * 1080×1920 / 30s / beat-synced MP4 + thumbnail and flip the row → draft_ready.
 *
 * Flow:
 *   1. load the montage row; if it's not `generating` (e.g. user replaced it,
 *      regenerated again, a duplicate retry), no-op (idempotent).
 *   2. load the user's VALID daily_media_item rows for the montage's day_bucket.
 *   3. download each raw object from MinIO to a temp dir.
 *   4. startMediaServer(dir) → srcMap[mediaRef] = server.url(file) (Chrome blocks
 *      file://; the renderer loads media over HTTP).
 *   5. pick the track (montage.music_id or default) → its beat grid.
 *   6. scoreMedia the items → buildEdl({items, track, theme}) (Random resolved).
 *   7. getRenderer().render(edl, {srcMap, outDir}) → MP4 + thumbnail.
 *   8. upload MP4 → montages bucket, thumbnail → thumbnails bucket (server keys).
 *   9. update the row: video_path, thumbnail_path, duration_ms, edl, status=draft_ready.
 *
 * §7.4 FAILURE: this throws on a true render/infra fault so BullMQ retries (the
 * producer sets attempts:2 = one retry). On the FINAL attempt we mark the row
 * `failed` + clean up any partial S3 objects (no orphans). The renderer enforces
 * the 5-min hard timeout. The job NEVER leaves the row stuck in `generating`.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { dailyMediaItems, montages, type Montage } from '@twenty4/contracts/db';
import { getTrack, TRACK_IDS } from '@twenty4/remotion/tracks';

import { db } from '../db.js';
import { buckets, downloadObject, uploadObject, deleteObject } from '../storage.js';
import { startMediaServer } from '../media/index.js';
// Import the scoring + EDL builders DIRECTLY (not via the intelligence barrel) so
// this job's type graph does NOT transitively pull in `beat/analyze.ts` → the
// untyped `essentia.js` module. The render path uses the track's PRECOMPUTED beat
// grid (from the bundled registry), so no live beat analysis is needed here.
import { scoreMedia, type ScorableItem } from '../intelligence/scoring/score.js';
import { buildEdl, type BuildItem } from '../intelligence/edl/build.js';

/** Default track when the row has no music_id (mirrors the API default). */
const DEFAULT_MUSIC_ID = TRACK_IDS[0]!;

export interface RenderMontageResult {
  montageId: string;
  status: 'draft_ready' | 'failed' | 'skipped';
  videoKey?: string;
  thumbnailKey?: string;
  durationMs?: number;
  reason?: string;
}

/** A media item resolved + downloaded locally, ready for scoring + the srcMap. */
interface LocalItem {
  mediaRef: string; // stable id used in the EDL + srcMap (the local filename)
  mediaType: 'photo' | 'video';
  filePath: string;
  sourceDurationMs?: number;
}

/**
 * Render a montage from its row id. `isFinalAttempt` controls §7.4 behavior: on the
 * last BullMQ attempt a failure marks the row `failed` (+ cleans partial S3) before
 * rethrowing; on an earlier attempt we rethrow so BullMQ retries (row stays
 * `generating`). Returns the result on success.
 */
export async function renderMontage(
  montageId: string,
  isFinalAttempt = true,
): Promise<RenderMontageResult> {
  const [row] = await db
    .select()
    .from(montages)
    .where(eq(montages.id, montageId))
    .limit(1);

  if (!row) {
    return { montageId, status: 'skipped', reason: 'row_missing' };
  }
  // Only a row still `generating` should be rendered. A regenerate flips it back to
  // generating + enqueues a fresh job; a replaced/published row must not be touched.
  if (row.status !== 'generating') {
    return { montageId, status: 'skipped', reason: `status_${row.status}` };
  }

  // Server-minted output keys (namespaced to the owner, unguessable uuid). Declared
  // up-front so the failure path can clean up whatever we may have uploaded.
  const videoKey = `${row.userId}/${row.dayBucket}/${randomUUID()}.mp4`;
  const thumbnailKey = `${row.userId}/${row.dayBucket}/${randomUUID()}.jpg`;

  let tmpRoot: string | undefined;
  let mediaServer: { close: () => Promise<void> } | undefined;
  let uploadedVideo = false;
  let uploadedThumb = false;

  try {
    // ---- 2. load the montage's SELECTED media for its day_bucket -----------
    // Honor the user's curation: render EXACTLY the ids they selected at generate
    // time (montage.source_media_ids), NOT the whole day's valid pool. We still
    // re-filter by owner + valid + not-deleted in SQL (and day_bucket is implied by
    // the montage's own day) as a safety net — a since-invalidated/deleted/foreign
    // id is dropped here rather than ever being smuggled into a render.
    const selectedIds = row.sourceMediaIds ?? [];
    const mediaRows = selectedIds.length
      ? await db
          .select()
          .from(dailyMediaItems)
          .where(
            and(
              eq(dailyMediaItems.userId, row.userId),
              eq(dailyMediaItems.dayBucket, row.dayBucket),
              eq(dailyMediaItems.validationStatus, 'valid'),
              inArray(dailyMediaItems.id, selectedIds),
            ),
          )
          .orderBy(dailyMediaItems.createdAt)
      : [];

    const usable = mediaRows.filter((m) => m.processingStatus !== 'deleted');
    if (usable.length === 0) {
      // Either nothing was selected (legacy/empty row) or every selected id is no
      // longer valid/live — there's nothing legitimate to render.
      throw new Error('no valid selected media to render');
    }

    // ---- 3. download each raw object to a temp dir -------------------------
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'twenty4-montage-'));
    const mediaDir = path.join(tmpRoot, 'media');
    const outDir = path.join(tmpRoot, 'out');
    await mkdir(mediaDir, { recursive: true });
    await mkdir(outDir, { recursive: true });

    const localItems: LocalItem[] = [];
    for (const m of usable) {
      const ext = path.extname(m.storagePath) || (m.mediaType === 'video' ? '.mp4' : '.jpg');
      // Use the row id as the stable mediaRef + local filename (unique, no PII).
      const fileName = `${m.id}${ext}`;
      const local = path.join(mediaDir, fileName);
      await downloadObject(buckets.raw, m.storagePath, local);
      localItems.push({
        mediaRef: fileName,
        mediaType: m.mediaType,
        filePath: local,
        sourceDurationMs: m.durationMs ?? undefined,
      });
    }

    // ---- 4. serve the temp dir over HTTP → srcMap --------------------------
    const server = await startMediaServer(mediaDir);
    mediaServer = server;
    const srcMap: Record<string, string> = {};
    for (const it of localItems) srcMap[it.mediaRef] = server.url(it.mediaRef);

    // ---- 5. pick the track → beat grid -------------------------------------
    const musicId = row.musicId ?? DEFAULT_MUSIC_ID;
    const track = (() => {
      try {
        return getTrack(musicId);
      } catch {
        // Unknown music id on the row (shouldn't happen — the API validates) →
        // fall back to the default track so a render never hard-fails on music.
        return getTrack(DEFAULT_MUSIC_ID);
      }
    })();

    // ---- 6. score the items → build the EDL --------------------------------
    const scorables: ScorableItem[] = localItems.map((it) => ({
      mediaRef: it.mediaRef,
      mediaType: it.mediaType,
      filePath: it.filePath,
      sourceDurationMs: it.sourceDurationMs,
    }));
    const scores = await Promise.all(scorables.map((s) => scoreMedia(s)));

    const buildItems: BuildItem[] = localItems.map((it, i) => ({
      mediaRef: it.mediaRef,
      mediaType: it.mediaType,
      sourceDurationMs: it.sourceDurationMs,
      score: scores[i]!,
    }));

    const edl = buildEdl({
      items: buildItems,
      track: {
        musicId: track.id,
        bpm: track.bpm,
        beatGridMs: track.beatGridMs,
        dropsMs: track.dropsMs,
      },
      theme: (row.theme ?? 'Random') as Parameters<typeof buildEdl>[0]['theme'],
    });

    // ---- 7. render headlessly (lazily — Renderer factory caches the browser)  -
    const { getRenderer } = await import('../render/index.js');
    const renderResult = await getRenderer().render(edl, {
      srcMap,
      outDir,
      outBasename: `montage-${row.id}`,
    });

    // ---- 8. upload MP4 + thumbnail to their buckets ------------------------
    await uploadObject(buckets.montages, videoKey, renderResult.videoPath, 'video/mp4');
    uploadedVideo = true;
    await uploadObject(
      buckets.thumbnails,
      thumbnailKey,
      renderResult.thumbnailPath,
      'image/jpeg',
    );
    uploadedThumb = true;

    // ---- 9. flip the row → draft_ready (only if still generating) ----------
    // Conditional update: if the user regenerated/replaced mid-render, the row is no
    // longer `generating` and we must NOT clobber it — clean up our orphan outputs.
    const [updated] = await db
      .update(montages)
      .set({
        videoPath: videoKey,
        thumbnailPath: thumbnailKey,
        durationMs: renderResult.durationMs,
        edl: edl,
        status: 'draft_ready',
        renderError: null,
      })
      .where(and(eq(montages.id, row.id), eq(montages.status, 'generating')))
      .returning();

    if (!updated) {
      // The row moved on (regenerate/replace) — our just-uploaded outputs are orphans.
      await deleteObject(buckets.montages, videoKey);
      await deleteObject(buckets.thumbnails, thumbnailKey);
      return { montageId, status: 'skipped', reason: 'superseded_during_render' };
    }

    return {
      montageId,
      status: 'draft_ready',
      videoKey,
      thumbnailKey,
      durationMs: renderResult.durationMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Clean up any partial S3 we uploaded this attempt (no orphans, §7.4).
    if (uploadedVideo) await deleteObject(buckets.montages, videoKey);
    if (uploadedThumb) await deleteObject(buckets.thumbnails, thumbnailKey);

    if (isFinalAttempt) {
      // §7.4: final failure → surface `failed` so the client shows render-failed.
      // Only flip a row that's still `generating` (don't clobber a regenerate).
      await db
        .update(montages)
        .set({ status: 'failed', renderError: truncate(message, 500) })
        .where(and(eq(montages.id, montageId), eq(montages.status, 'generating')))
        .catch(() => undefined);
      // Still rethrow so BullMQ records the failure (removeOnFail keeps a trace).
    }
    throw err instanceof Error ? err : new Error(message);
  } finally {
    if (mediaServer) await mediaServer.close().catch(() => undefined);
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}
