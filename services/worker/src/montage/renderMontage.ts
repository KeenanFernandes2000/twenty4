// render-montage processor (M7 §3) — the heart of the montage pipeline. Exported as
// a plain async fn so live-stack tests can run it synchronously (mirrors the
// validate-media testability), AND the BullMQ worker calls it.
//
// Flow: load montage → load its valid source media (chronological) → download each to
// a temp file (srcMap) → score each clip → pick track + beat grid → buildEdl →
// persist edl + source_media_ids → RemotionRenderer.render → upload mp4 (montages) +
// thumb (thumbnails) → set video_path/thumbnail_path/duration_ms, status=draft_ready.
//
// finally: delete the temp working dir (downloads + render outputs).
// On ANY throw: delete any montage/thumb objects already uploaded for this montageId
// (NO orphaned S3 objects); then if this is the FINAL attempt set status=failed,
// else leave status=generating and RETHROW so BullMQ retries. Cleanup errors are
// swallowed so they never mask the original failure.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dailyMediaItem, montage } from "@twenty4/contracts/db";
import { sniffContainer, type Env, type Theme } from "@twenty4/contracts";
import type { WorkerDb } from "../db.ts";
import {
  deleteObject,
  getObjectBytes,
  montageKey,
  montageThumbnailKey,
  putObject,
  type WorkerS3,
} from "../s3.ts";
import { scoreClip, type ScoredClip } from "../intelligence/scoring/score.ts";
import { buildEdl } from "../intelligence/edl/build.ts";
import { selectTrack } from "./tracks.ts";
import { RemotionRenderer } from "../render/RemotionRenderer.ts";
import type { Renderer } from "../render/Renderer.ts";
import type { RenderMontageJobData } from "./queue.ts";

export interface RenderMontageDeps {
  db: WorkerDb;
  s3: WorkerS3;
  env: Env;
  // Optional renderer override (tests inject a throwing/fake renderer); defaults to
  // a real RemotionRenderer(env).
  renderer?: Renderer;
}

export interface RenderMontageResult {
  montageId: string;
  status: "draft_ready" | "failed" | "skipped";
  durationMs?: number;
  reason?: string;
}

// Minimal shape of the BullMQ job we read (attempt accounting). Kept structural so a
// direct test can pass `undefined`.
export interface RenderMontageJobLike {
  attemptsMade: number;
  opts?: { attempts?: number };
}

// States we will (re)render from. Anything terminal/post-draft is an idempotent skip.
const RENDERABLE = new Set(["not_generated", "generating", "failed"]);

// Map a sniffed container to a file extension so the render media server sets a
// usable content-type (OffthreadVideo/Img). Falls back by declared mediaType.
function extFor(container: string, mediaType: "photo" | "video"): string {
  switch (container) {
    case "jpeg":
      return ".jpg";
    case "png":
      return ".png";
    case "heic":
      return ".heic";
    case "mp4":
      return ".mp4";
    case "mov":
      return ".mov";
    default:
      return mediaType === "video" ? ".mp4" : ".jpg";
  }
}

export async function processRenderMontage(
  deps: RenderMontageDeps,
  data: RenderMontageJobData,
  job?: RenderMontageJobLike,
): Promise<RenderMontageResult> {
  const { db, s3, env } = deps;
  const { montageId } = data;

  const rows = await db.db.select().from(montage).where(eq(montage.id, montageId)).limit(1);
  const row = rows[0];
  if (!row) throw new Error(`montage ${montageId} not found`);

  // Idempotency: a montage already past the draft (or in a terminal non-failed state)
  // is left untouched.
  if (!RENDERABLE.has(row.status)) {
    return { montageId, status: "skipped", reason: `status ${row.status} not renderable` };
  }

  const userId = row.userId;
  const vKey = montageKey(userId, montageId);
  const tKey = montageThumbnailKey(userId, montageId);

  let workDir: string | null = null;
  let renderOutDir: string | null = null;
  let uploadedVideo = false;
  let uploadedThumb = false;

  try {
    // 1. Load the valid source media, chronological (originalTimestamp asc NULLS
    //    LAST, then uploadTimestamp). Must belong to the montage owner.
    const ids = (row.sourceMediaIds ?? []) as string[];
    if (ids.length === 0) throw new Error("montage has no source_media_ids");

    const items = await db.db
      .select()
      .from(dailyMediaItem)
      .where(
        and(
          inArray(dailyMediaItem.id, ids),
          eq(dailyMediaItem.userId, userId),
          eq(dailyMediaItem.validationStatus, "valid"),
          // Exclude soft-deleted items (mirrors the API's resolveChosenMedia) so a
          // deleted-but-still-valid row can't be pulled into a render.
          sql`${dailyMediaItem.processingStatus} <> 'deleted'`,
        ),
      )
      .orderBy(asc(dailyMediaItem.originalTimestamp), asc(dailyMediaItem.uploadTimestamp));

    if (items.length === 0) throw new Error("no valid source media for montage");

    // 2. Download each object to a temp file; build the srcMap (mediaRef = item.id).
    workDir = await mkdtemp(join(tmpdir(), "t4montage-"));
    const mediaDir = join(workDir, "media");
    await rm(mediaDir, { recursive: true, force: true }).catch(() => {});
    const srcMap: Record<string, string> = {};
    const scoreInputs: { mediaRef: string; mediaType: "photo" | "video"; path: string; durationMs: number | null }[] =
      [];

    for (const item of items) {
      const bytes = await getObjectBytes(s3, item.storagePath);
      const ext = extFor(sniffContainer(bytes), item.mediaType);
      const localPath = join(mediaDir, `${item.id}${ext}`);
      await writeFileEnsured(localPath, bytes);
      srcMap[item.id] = localPath;
      scoreInputs.push({
        mediaRef: item.id,
        mediaType: item.mediaType,
        path: localPath,
        durationMs: item.durationMs ?? null,
      });
    }

    // 3. Score every clip.
    const scoredClips: ScoredClip[] = [];
    for (const si of scoreInputs) scoredClips.push(await scoreClip(si));

    // 4. Pick the track + its precomputed beat grid.
    const track = selectTrack(env, { musicId: row.musicId, theme: row.theme as Theme });

    // 5. Build + validate the EDL; persist it + the actual source set.
    const edl = buildEdl({ scoredClips, track, theme: row.theme as Theme });
    await db.db
      .update(montage)
      .set({ edl, sourceMediaIds: items.map((i) => i.id), musicId: track.id })
      .where(eq(montage.id, montageId));

    // 6. Render (Remotion via spawned node child; hard watchdog inside).
    const renderer = deps.renderer ?? new RemotionRenderer(env);
    const result = await renderer.render(edl, srcMap);
    renderOutDir = dirname(result.videoPath);

    // 7. Upload mp4 → montages, thumb → thumbnails.
    const [videoBuf, thumbBuf] = await Promise.all([
      readFile(result.videoPath),
      readFile(result.thumbnailPath),
    ]);
    await putObject(s3, s3.montagesBucket, vKey, videoBuf, "video/mp4");
    uploadedVideo = true;
    await putObject(s3, s3.thumbnailsBucket, tKey, thumbBuf, "image/jpeg");
    uploadedThumb = true;

    // 8. Mark draft_ready.
    await db.db
      .update(montage)
      .set({
        videoPath: vKey,
        thumbnailPath: tKey,
        durationMs: result.durationMs,
        status: "draft_ready",
      })
      .where(eq(montage.id, montageId));

    return { montageId, status: "draft_ready", durationMs: result.durationMs };
  } catch (err) {
    // Cleanup any objects already uploaded for THIS montage (no orphans). Swallow
    // cleanup errors so they never mask the original failure.
    if (uploadedVideo) await deleteObject(s3, s3.montagesBucket, vKey).catch(() => {});
    if (uploadedThumb) await deleteObject(s3, s3.thumbnailsBucket, tKey).catch(() => {});

    // Final attempt? (no job in a direct test ⇒ treat as final). On the final
    // attempt the montage is terminal-failed; otherwise leave it generating and
    // rethrow so BullMQ retries.
    const attempts = job?.opts?.attempts ?? 1;
    const isFinal = !job || job.attemptsMade >= attempts - 1;
    if (isFinal) {
      await db.db
        .update(montage)
        .set({ status: "failed" })
        .where(eq(montage.id, montageId))
        .catch(() => {});
    }
    throw err;
  } finally {
    if (renderOutDir) await rm(renderOutDir, { recursive: true, force: true }).catch(() => {});
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// writeFile that creates the parent dir first.
async function writeFileEnsured(path: string, bytes: Buffer): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}
