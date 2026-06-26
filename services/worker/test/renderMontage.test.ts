// Live-stack render-gate test (M7 §7.5) — real Postgres + MinIO + a real Remotion
// render. Seeds a user + fixture media (raw bucket + daily_media_item rows) + a
// montage row, then drives processRenderMontage DIRECTLY (synchronous, like the
// validate-media tests) and asserts the produced mp4 is 1080×1920 / 30fps / 30s±0.3
// / h264, beat-aligned, with the EDL persisted + valid. Also asserts the forced-
// failure path: final attempt ⇒ status=failed + ZERO stray objects (cleanup).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { dailyMediaItem, montage, user } from "@twenty4/contracts/db";
import {
  edlSchema,
  edlDurationsSumTo30s,
  edlCutsOnBeats,
  resolveDayBucket,
  type Edl,
} from "@twenty4/contracts";
import { createWorkerDb, createWorkerS3, processRenderMontage } from "../src/index.ts";
import type { WorkerDb } from "../src/db.ts";
import { montageKey, montageThumbnailKey, putObject, type WorkerS3 } from "../src/s3.ts";
import type { Renderer } from "../src/render/Renderer.ts";
import {
  countObjects,
  downloadObject,
  ffprobeStreams,
  fixture,
  loadWorkerEnv,
  objectExists,
} from "./helpers.ts";

const env = loadWorkerEnv();
let db: WorkerDb;
let s3: WorkerS3;

let userId: string;
const bucketDay = resolveDayBucket(new Date(), "UTC");

// itemId → { mediaType, fixtureName }
const GATE_MEDIA: { ref: string; mediaType: "photo" | "video"; name: string }[] = [
  { ref: "", mediaType: "photo", name: "IMG20260522212401.jpg" },
  { ref: "", mediaType: "photo", name: "IMG20260523154438.jpg" },
  { ref: "", mediaType: "photo", name: "IMG20260524180440.jpg" },
  { ref: "", mediaType: "video", name: "VID20260524170711.mp4" },
];

const allKeys: { bucket: string; key: string }[] = [];

function rawKey(uid: string, itemId: string): string {
  return `media/${uid}/${itemId}`;
}

// Seed a user + upload the given fixtures to the raw bucket + insert valid
// daily_media_item rows (chronological). Returns the inserted item ids in order.
async function seedMedia(
  uid: string,
  media: { mediaType: "photo" | "video"; name: string }[],
): Promise<string[]> {
  const ids: string[] = [];
  const base = Date.now() - media.length * 1000;
  for (let i = 0; i < media.length; i++) {
    const m = media[i]!;
    const id = randomUUID();
    const key = rawKey(uid, id);
    const bytes = fixture(m.name);
    await putObject(s3, s3.rawBucket, key, bytes, m.mediaType === "video" ? "video/mp4" : "image/jpeg");
    allKeys.push({ bucket: s3.rawBucket, key });
    await db.db.insert(dailyMediaItem).values({
      id,
      userId: uid,
      dayBucket: bucketDay,
      mediaType: m.mediaType,
      storagePath: key,
      validationStatus: "valid",
      processingStatus: "valid",
      originalTimestamp: new Date(base + i * 1000),
    });
    ids.push(id);
  }
  return ids;
}

beforeAll(async () => {
  db = createWorkerDb(env.DATABASE_URL);
  s3 = createWorkerS3(env);
  const ins = await db.db
    .insert(user)
    .values({ phone: `+1799${Date.now().toString().slice(-7)}`, timezone: "UTC" })
    .returning({ id: user.id });
  userId = ins[0]!.id;
});

afterAll(async () => {
  // Best-effort S3 cleanup, then drop the user (cascades media + montage rows).
  const { deleteObject } = await import("../src/s3.ts");
  for (const { bucket, key } of allKeys) await deleteObject(s3, bucket, key).catch(() => {});
  if (userId) await db.sql`DELETE FROM "user" WHERE id = ${userId}`.catch(() => {});
  await db.sql.end({ timeout: 5 });
});

describe("§7.5 render gate — real Remotion render", () => {
  test(
    "generating montage → draft_ready: 1080×1920/30fps/30s±0.3/h264, beat-aligned EDL, objects in buckets",
    async () => {
      const itemIds = await seedMedia(userId, GATE_MEDIA);
      const montageId = randomUUID();
      await db.db.insert(montage).values({
        id: montageId,
        userId,
        dayBucket: bucketDay,
        theme: "clean",
        musicId: "clean",
        status: "generating",
        sourceMediaIds: itemIds,
      });
      const vKey = montageKey(userId, montageId);
      const tKey = montageThumbnailKey(userId, montageId);
      allKeys.push({ bucket: s3.montagesBucket, key: vKey });
      allKeys.push({ bucket: s3.thumbnailsBucket, key: tKey });

      const t0 = Date.now();
      const res = await processRenderMontage({ db, s3, env }, { montageId });
      const wallMs = Date.now() - t0;
      console.log(`[gate] render wall-time: ${(wallMs / 1000).toFixed(1)}s`);

      expect(res.status).toBe("draft_ready");

      // Row reached draft_ready with paths + duration set.
      const row = (await db.db.select().from(montage).where(eq(montage.id, montageId)).limit(1))[0]!;
      expect(row.status).toBe("draft_ready");
      expect(row.videoPath).toBe(vKey);
      expect(row.thumbnailPath).toBe(tKey);
      expect(row.durationMs).toBeGreaterThanOrEqual(29700);
      expect(row.durationMs).toBeLessThanOrEqual(30300);

      // Objects exist in montages + thumbnails buckets.
      expect(await objectExists(s3.client, s3.montagesBucket, vKey)).toBe(true);
      expect(await objectExists(s3.client, s3.thumbnailsBucket, tKey)).toBe(true);

      // Download the mp4 and ffprobe it.
      const mp4 = await downloadObject(s3.client, s3.montagesBucket, vKey);
      const probeDir = mkdtempSync(join(tmpdir(), "t4gate-"));
      const mp4Path = join(probeDir, "montage.mp4");
      writeFileSync(mp4Path, mp4);
      const pr = await ffprobeStreams(mp4Path);
      console.log(`[gate] ffprobe: ${JSON.stringify(pr)}`);
      expect(pr.width).toBe(1080);
      expect(pr.height).toBe(1920);
      expect(pr.fps).toBe(30);
      expect(pr.codec).toBe("h264");
      expect(pr.durationSec).toBeGreaterThan(29.7);
      expect(pr.durationSec).toBeLessThan(30.3);

      // Persisted EDL validates + is beat-aligned + uses exactly the seeded media.
      const edl = edlSchema.parse(row.edl) as Edl;
      expect(edlDurationsSumTo30s(edl)).toBe(true);
      expect(edlCutsOnBeats(edl)).toBe(true);
      const usedRefs = new Set(edl.segments.map((s) => s.mediaRef));
      expect(usedRefs).toEqual(new Set(itemIds));
      // source_media_ids persisted as the actual used set.
      expect(new Set(row.sourceMediaIds as string[])).toEqual(new Set(itemIds));
    },
    240_000,
  );
});

describe("forced render failure — status=failed + zero orphans (cleanup)", () => {
  test(
    "final attempt: mid-upload failure deletes the already-uploaded mp4; no stray objects",
    async () => {
      // Photos only ⇒ fast scoring; a FAKE renderer returns real local files so the
      // mp4 upload SUCCEEDS, then we inject a failure on the thumbnail PUT to force
      // the cleanup path (delete the already-uploaded mp4).
      const itemIds = await seedMedia(
        userId,
        GATE_MEDIA.filter((m) => m.mediaType === "photo"),
      );
      const montageId = randomUUID();
      await db.db.insert(montage).values({
        id: montageId,
        userId,
        dayBucket: bucketDay,
        theme: "clean",
        musicId: "clean",
        status: "generating",
        sourceMediaIds: itemIds,
      });
      const vKey = montageKey(userId, montageId);
      const tKey = montageThumbnailKey(userId, montageId);

      // Fake renderer: stage a real mp4 + jpg so readFile + the mp4 PUT succeed.
      const stage = mkdtempSync(join(tmpdir(), "t4fakerender-"));
      const vp = join(stage, "montage.mp4");
      const tp = join(stage, "thumb.jpg");
      writeFileSync(vp, fixture("VID20260524170711.mp4"));
      writeFileSync(tp, fixture("IMG20260522212401.jpg"));
      const fakeRenderer: Renderer = {
        render: async () => ({ videoPath: vp, thumbnailPath: tp, durationMs: 30000 }),
      };

      // Intercept the thumbnail PutObject to throw (video PUT to montages succeeds).
      const origSend = s3.client.send.bind(s3.client);
      (s3.client as unknown as { send: typeof origSend }).send = ((cmd: { constructor: { name: string }; input?: { Bucket?: string } }) => {
        if (cmd.constructor.name === "PutObjectCommand" && cmd.input?.Bucket === s3.thumbnailsBucket) {
          return Promise.reject(new Error("injected thumbnail PUT failure"));
        }
        return origSend(cmd as Parameters<typeof origSend>[0]);
      }) as typeof origSend;

      try {
        await expect(
          processRenderMontage({ db, s3, env, renderer: fakeRenderer }, { montageId }),
          // no job passed ⇒ treated as the FINAL attempt
        ).rejects.toThrow("injected thumbnail PUT failure");
      } finally {
        (s3.client as unknown as { send: typeof origSend }).send = origSend;
      }

      // Status terminal-failed.
      const row = (await db.db.select().from(montage).where(eq(montage.id, montageId)).limit(1))[0]!;
      expect(row.status).toBe("failed");

      // ZERO stray objects for this montage in BOTH buckets (the uploaded mp4 was
      // cleaned up; the thumb never landed).
      expect(await objectExists(s3.client, s3.montagesBucket, vKey)).toBe(false);
      expect(await objectExists(s3.client, s3.thumbnailsBucket, tKey)).toBe(false);
      expect(await countObjects(s3.client, s3.montagesBucket, `montages/${userId}/${montageId}`)).toBe(0);
      expect(
        await countObjects(s3.client, s3.thumbnailsBucket, `thumbnails/${userId}/montage-${montageId}`),
      ).toBe(0);
    },
    120_000,
  );
});
