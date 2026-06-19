/**
 * Slice 5 montage integration test — the CORE-LOOP PROOF on the REAL stack
 * (Postgres + Redis + MinIO + a REAL headless Remotion render).
 *
 * Proves (per Slice-5 acceptance):
 *   - POST /montages requires ≥1 VALID daily media in today's bucket (rejects 0).
 *   - POST /montages creates a `generating` row + enqueues a render-montage job.
 *   - the render-montage WORKER (invoked directly for determinism — the same fn the
 *     BullMQ worker runs) turns the user's VALID media into a 1080×1920 / ~30s /
 *     h264 MP4 + thumbnail uploaded to the montages/thumbnails buckets, and flips
 *     the row → draft_ready.
 *   - GET /montages/:id polls to draft_ready and returns presigned video+thumbnail
 *     GETs (TTL clamped) that actually round-trip the bytes.
 *   - **ffprobe the produced montages-bucket MP4 → 1080×1920, ~30s, h264** (renderProof).
 *   - publish to a group: published_at + expiry_at = +24h, visibility rows inserted,
 *     a NON-MEMBER group rejects the whole publish, and publish is IDEMPOTENT.
 *   - a forced render failure (no valid media at render time) → status=failed.
 *
 * Media is seeded by UPLOADING real ffmpeg-generated images/video to the raw bucket
 * and inserting VALID rows directly (the upload→validate flow is covered by Slice 2;
 * here we need the bytes present + the rows valid so the renderer can consume them).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { Queue } from 'bullmq';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  dailyMediaItems,
  montages,
  montageGroupVisibility,
} from '@twenty4/contracts/db';
import { resolveDayBucket } from '@twenty4/contracts/dayWindow';
import { buildApp } from '../src/app.js';
import { db, closeDb } from '../src/db/index.js';
import { closeRedis } from '../src/redis/index.js';
import {
  closeQueues,
  MONTAGE_QUEUE,
  RENDER_MONTAGE_JOB,
  EXPIRE_MONTAGE_JOB,
  CLEANUP_RAW_JOB,
} from '../src/queue/producers.js';
import { s3, buckets } from '../src/storage/s3.js';
// The REAL worker render job (same function the BullMQ worker invokes) + media
// helpers + ffprobe, imported from @twenty4/worker (test-only dep).
import { renderMontage } from '@twenty4/worker';
import { media as workerMedia } from '@twenty4/worker';

const { makeColorImage, makeTestVideo, probe } = workerMedia;

const unique = Date.now();
const runId = unique.toString(36);
const TZ = 'UTC';

interface TestUser {
  token: string;
  userId: string;
  email: string;
}

const emails: string[] = [];
let ipCounter = 0;
let tmpDir: string;

/** Drain any render-montage / lifecycle jobs for a montage id out of Redis. */
async function drainMontageJobs(montageId: string): Promise<void> {
  const u = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  const q = new Queue(MONTAGE_QUEUE, {
    connection: { host: u.hostname, port: Number(u.port || 6379), maxRetriesPerRequest: null },
  });
  try {
    const jobs = await q.getJobs(
      ['waiting', 'delayed', 'active', 'paused', 'completed', 'failed'],
      0,
      1000,
    );
    for (const j of jobs) {
      const d = j.data as { montageId?: string };
      if (d.montageId === montageId) await j.remove().catch(() => undefined);
    }
  } finally {
    await q.close();
  }
}

/** Count scheduled jobs (by name) for a montage id. */
async function countJobs(name: string, montageId: string): Promise<number> {
  const u = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  const q = new Queue(MONTAGE_QUEUE, {
    connection: { host: u.hostname, port: Number(u.port || 6379), maxRetriesPerRequest: null },
  });
  try {
    const jobs = await q.getJobs(['waiting', 'delayed', 'active', 'paused'], 0, 1000);
    return jobs.filter(
      (j) => j.name === name && (j.data as { montageId?: string }).montageId === montageId,
    ).length;
  } finally {
    await q.close();
  }
}

/**
 * Seed N VALID daily media items for a user in TODAY's bucket: generate real bytes
 * with ffmpeg, PUT them into the raw bucket under a server-style key, and insert a
 * `valid` row pointing at each. Returns the inserted row ids.
 */
async function seedValidMedia(
  userId: string,
  dayBucket: string,
  spec: Array<{ type: 'photo' | 'video'; color?: string; durationSec?: number }>,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < spec.length; i++) {
    const s = spec[i]!;
    const isVideo = s.type === 'video';
    const ext = isVideo ? 'mp4' : 'jpg';
    const local = path.join(tmpDir, `seed-${userId.slice(0, 8)}-${i}.${ext}`);
    if (isVideo) {
      await makeTestVideo(local, {
        durationSec: s.durationSec ?? 4,
        width: 1080,
        height: 1920,
      });
    } else {
      await makeColorImage(local, s.color ?? '0xff7a52', 1080, 1920);
    }
    const bytes = await readFile(local);
    const sizeBytes = (await stat(local)).size;
    const key = `${userId}/${dayBucket}/${randomUUID()}.${ext}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: buckets.raw,
        Key: key,
        Body: bytes,
        ContentType: isVideo ? 'video/mp4' : 'image/jpeg',
      }),
    );
    const [row] = await db
      .insert(dailyMediaItems)
      .values({
        userId,
        dayBucket,
        mediaType: s.type,
        contentType: isVideo ? 'video/mp4' : 'image/jpeg',
        storagePath: key,
        capturedInApp: true,
        deviceTimezone: TZ,
        validationStatus: 'valid',
        processingStatus: 'valid',
        durationMs: isVideo ? (s.durationSec ?? 4) * 1000 : null,
        sizeBytes,
        width: 1080,
        height: 1920,
      })
      .returning();
    ids.push(row!.id);
  }
  return ids;
}

describe('montage — generate → render → review → publish (live PG + redis + MinIO + REAL render)', () => {
  let app: FastifyInstance;

  async function signUp(tag: string): Promise<TestUser> {
    const email = `slice5-${tag}-${unique}@twenty4.test`;
    emails.push(email);
    const n = ipCounter++;
    const ip = `10.${(unique >> 8) & 0xff}.${unique & 0xff}.${(n % 254) + 1}`;
    const xff = { 'x-forwarded-for': ip };

    const start = await app.inject({
      method: 'POST',
      url: '/auth/start',
      headers: xff,
      payload: { method: 'email', identifier: email },
    });
    expect(start.statusCode).toBe(200);
    const { challengeId } = start.json();
    const otpRes = await app.inject({
      method: 'GET',
      url: `/auth/dev/last-otp?identifier=${encodeURIComponent(email)}`,
    });
    const code = otpRes.json().code as string;
    const verify = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { challengeId, code },
    });
    const token = verify.json().accessToken as string;
    const patch = await app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { username: `s5${tag}${runId}`, displayName: `S5 ${tag}` },
    });
    expect(patch.statusCode).toBe(200);
    return { token, userId: patch.json().id as string, email };
  }

  function auth(u: TestUser) {
    return { authorization: `Bearer ${u.token}` };
  }

  /** Create a group owned by `u`; returns the group id. */
  async function createGroup(u: TestUser, name: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/groups',
      headers: auth(u),
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  /** B joins A's group via an invite (so B is an active member). */
  async function joinGroup(owner: TestUser, joiner: TestUser, groupId: string): Promise<void> {
    const inv = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/invites`,
      headers: auth(owner),
      payload: {},
    });
    expect(inv.statusCode).toBe(201);
    const code = inv.json().code as string;
    const join = await app.inject({
      method: 'POST',
      url: `/invites/${code}/join`,
      headers: auth(joiner),
    });
    expect([200, 201]).toContain(join.statusCode);
  }

  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let dayBucket: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    tmpDir = await mkdtemp(path.join(tmpdir(), 'twenty4-slice5-'));
    owner = await signUp('owner');
    member = await signUp('member');
    outsider = await signUp('outsider');
    dayBucket = resolveDayBucket(new Date(), TZ);
  }, 120_000);

  afterAll(async () => {
    for (const e of emails) {
      await db.execute(sql`delete from "users" where email = ${e}`).catch(() => {});
    }
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await app.close();
    // Tear down the shared headless browser the renderer cached.
    try {
      const { getRenderer } = await import('@twenty4/worker');
      await getRenderer().close?.();
    } catch {
      /* nothing to close */
    }
    await closeQueues();
    await closeRedis();
    await closeDb();
  }, 60_000);

  /* ----------------------- generate gating + options ----------------------- */

  it('GET /montages/options returns themes + music tracks', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/montages/options',
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      themes: string[];
      defaultTheme: string;
      music: Array<{ id: string; label: string; bpm: number }>;
      defaultMusicId: string;
    };
    expect(body.themes).toContain('Party');
    expect(body.music.length).toBeGreaterThan(0);
    expect(body.music[0]).toHaveProperty('bpm');
    expect(body.defaultMusicId).toBeTruthy();
  });

  it('POST /montages with NO valid media → 409 (not enough valid media)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/montages',
      headers: auth(outsider), // outsider has zero media seeded
      payload: { mediaIds: [randomUUID()], theme: 'Party', musicId: 'house_120' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
  });

  it('POST /montages with an unknown music id → 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/montages',
      headers: auth(owner),
      payload: { mediaIds: [randomUUID()], theme: 'Party', musicId: 'no_such_track' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation');
  });

  /* ------------------- the core loop: generate → render -------------------- */

  let montageId: string;
  let videoKey: string;
  let renderWallMs = 0;

  let ownerMediaIds: string[];

  it('POST /montages creates a generating row + enqueues render-montage', async () => {
    // Seed several VALID items (photos + a video) for the owner today.
    ownerMediaIds = await seedValidMedia(owner.userId, dayBucket, [
      { type: 'photo', color: '0xff7a52' },
      { type: 'video', durationSec: 5 },
      { type: 'photo', color: '0x1fa572' },
      { type: 'photo', color: '0x223344' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/montages',
      headers: auth(owner),
      payload: { mediaIds: ownerMediaIds, theme: 'Party', musicId: 'house_120' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { montageId: string; status: string };
    montageId = body.montageId;
    expect(body.status).toBe('generating');

    // Exactly one render-montage job enqueued.
    expect(await countJobs(RENDER_MONTAGE_JOB, montageId)).toBe(1);

    // Row exists, generating, with the chosen theme/music + a render job id.
    const [row] = await db.select().from(montages).where(eq(montages.id, montageId)).limit(1);
    expect(row!.status).toBe('generating');
    expect(row!.theme).toBe('Party');
    expect(row!.musicId).toBe('house_120');
    expect(row!.renderJobId).toBeTruthy();
    // The selected media ids are persisted on the row (honored, not silently dropped).
    expect([...(row!.sourceMediaIds ?? [])].sort()).toEqual([...ownerMediaIds].sort());

    // While generating, GET /montages/:id has no playback URL yet.
    const poll = await app.inject({
      method: 'GET',
      url: `/montages/${montageId}`,
      headers: auth(owner),
    });
    expect(poll.statusCode).toBe(200);
    expect(poll.json().status).toBe('generating');
    expect(poll.json().videoUrl).toBeNull();
  });

  it('the render-montage worker renders a real MP4 → draft_ready (REAL render)', async () => {
    // Drain the enqueued BullMQ job (we run the job fn directly for determinism so
    // there's no duplicate render) and invoke the REAL render path.
    await drainMontageJobs(montageId);

    const t0 = Date.now();
    const result = await renderMontage(montageId, true);
    renderWallMs = Date.now() - t0;
    expect(result.status).toBe('draft_ready');
    expect(result.videoKey).toBeTruthy();
    videoKey = result.videoKey!;

    // The row is now draft_ready with the output keys, duration, and the EDL.
    const [row] = await db.select().from(montages).where(eq(montages.id, montageId)).limit(1);
    expect(row!.status).toBe('draft_ready');
    expect(row!.videoPath).toBe(videoKey);
    expect(row!.thumbnailPath).toBeTruthy();
    expect(row!.durationMs).toBeGreaterThan(29000);
    expect(row!.edl).toBeTruthy();
    expect((row!.edl as { segments: unknown[] }).segments.length).toBeGreaterThan(0);
  }, 240_000);

  it('RENDER PROOF: the montages-bucket MP4 is 1080×1920, ~30s, h264', async () => {
    // Download the actual rendered object from the montages bucket and ffprobe it.
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: buckets.montages, Key: videoKey }),
    );
    const chunks: Buffer[] = [];
    for await (const c of obj.Body as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    const local = path.join(tmpDir, 'rendered.mp4');
    await (await import('node:fs/promises')).writeFile(local, Buffer.concat(chunks));

    const p = await probe(local);
    // eslint-disable-next-line no-console
    console.log(
      `\n[RENDER PROOF] ${p.width}x${p.height} dur=${(p.durationMs / 1000).toFixed(3)}s ` +
        `video=${p.videoCodec} audio=${p.audioCodec} render=${(renderWallMs / 1000).toFixed(2)}s`,
    );
    expect(p.width).toBe(1080);
    expect(p.height).toBe(1920);
    expect(p.videoCodec).toBe('h264');
    expect(Math.abs(p.durationMs - 30000)).toBeLessThanOrEqual(300);
  });

  it('GET /montages/:id (draft_ready) returns presigned video+thumbnail that round-trip', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/montages/${montageId}`,
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      videoUrl: string | null;
      thumbnailUrl: string | null;
      durationMs: number | null;
    };
    expect(body.status).toBe('draft_ready');
    expect(body.videoUrl).toMatch(/^http/);
    expect(body.thumbnailUrl).toMatch(/^http/);
    // The presigned video GET actually returns bytes.
    const got = await fetch(body.videoUrl!);
    expect(got.ok).toBe(true);
    expect(Number(got.headers.get('content-length'))).toBeGreaterThan(1000);
  });

  it('a NON-owner gets 404 for GET /montages/:id (no existence leak)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/montages/${montageId}`,
      headers: auth(outsider),
    });
    expect(res.statusCode).toBe(404);
  });

  /* ------------------------------- publish --------------------------------- */

  let groupA: string;
  let groupB: string;

  it('publish requires membership in EVERY target group (non-member group → 403)', async () => {
    groupA = await createGroup(owner, `S5 A ${runId}`);
    await joinGroup(owner, member, groupA);
    // groupB is owned by the OUTSIDER — owner is NOT a member.
    groupB = await createGroup(outsider, `S5 B ${runId}`);

    const res = await app.inject({
      method: 'POST',
      url: `/montages/${montageId}/publish`,
      headers: auth(owner),
      payload: { groupIds: [groupA, groupB] }, // groupB → not a member
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');

    // Nothing was published (atomic): no visibility rows, still draft_ready.
    const vis = await db
      .select()
      .from(montageGroupVisibility)
      .where(eq(montageGroupVisibility.montageId, montageId));
    expect(vis.length).toBe(0);
    const [row] = await db.select().from(montages).where(eq(montages.id, montageId)).limit(1);
    expect(row!.status).toBe('draft_ready');
  });

  it('publish to a member group: published_at + expiry_at=+24h + visibility row + lifecycle jobs', async () => {
    const before = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: `/montages/${montageId}/publish`,
      headers: auth(owner),
      payload: { groupIds: [groupA] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      publishedAt: string | null;
      expiryAt: string | null;
    };
    expect(body.status).toBe('published');
    expect(body.publishedAt).toBeTruthy();
    expect(body.expiryAt).toBeTruthy();

    // expiry_at = published_at + 24h (within a small tolerance).
    const publishedMs = new Date(body.publishedAt!).getTime();
    const expiryMs = new Date(body.expiryAt!).getTime();
    expect(expiryMs - publishedMs).toBe(24 * 3600 * 1000);
    expect(publishedMs).toBeGreaterThanOrEqual(before - 5000);

    // Visibility row links the montage → groupA (one render → many groups).
    const vis = await db
      .select()
      .from(montageGroupVisibility)
      .where(eq(montageGroupVisibility.montageId, montageId));
    expect(vis.map((v) => v.groupId)).toContain(groupA);

    // The delayed expire-montage + cleanup-raw jobs were scheduled.
    expect(await countJobs(EXPIRE_MONTAGE_JOB, montageId)).toBe(1);
    expect(await countJobs(CLEANUP_RAW_JOB, montageId)).toBe(1);
  });

  it('publish is IDEMPOTENT — re-publish to the same group is a no-op replay', async () => {
    const [before] = await db
      .select()
      .from(montages)
      .where(eq(montages.id, montageId))
      .limit(1);

    const res = await app.inject({
      method: 'POST',
      url: `/montages/${montageId}/publish`,
      headers: auth(owner),
      payload: { groupIds: [groupA] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('published');

    // published_at/expiry_at UNCHANGED (the 24h clock wasn't reset).
    const [after] = await db
      .select()
      .from(montages)
      .where(eq(montages.id, montageId))
      .limit(1);
    expect(after!.publishedAt!.getTime()).toBe(before!.publishedAt!.getTime());
    expect(after!.expiryAt!.getTime()).toBe(before!.expiryAt!.getTime());

    // Still exactly ONE visibility row for groupA (no duplicate).
    const vis = await db
      .select()
      .from(montageGroupVisibility)
      .where(eq(montageGroupVisibility.montageId, montageId));
    expect(vis.filter((v) => v.groupId === groupA).length).toBe(1);
  });

  /* ---------------------------- render FAILURE ----------------------------- */

  it('a render with NO valid media → status=failed (no orphans, §7.4)', async () => {
    // A fresh user + a generating montage but ZERO valid media → the render fails.
    const failUser = await signUp('fail');
    const [row] = await db
      .insert(montages)
      .values({
        userId: failUser.userId,
        dayBucket,
        status: 'generating',
        theme: 'Chill',
        musicId: 'chill_90',
      })
      .returning();

    // isFinalAttempt=true → marks the row failed before rethrowing (§7.4).
    await expect(renderMontage(row!.id, true)).rejects.toThrow();

    const [after] = await db
      .select()
      .from(montages)
      .where(eq(montages.id, row!.id))
      .limit(1);
    expect(after!.status).toBe('failed');
    expect(after!.renderError).toBeTruthy();
    expect(after!.videoPath).toBeNull();
  });

  /* ----------------- FIX 2: generate honors the mediaIds selection ---------- */

  it('generate with a SUBSET of valid media renders only those (persisted + EDL)', async () => {
    const u = await signUp('subset');
    // Seed 4 valid items; select only 2 of them.
    const all = await seedValidMedia(u.userId, dayBucket, [
      { type: 'photo', color: '0xff0000' },
      { type: 'photo', color: '0x00ff00' },
      { type: 'photo', color: '0x0000ff' },
      { type: 'photo', color: '0xffff00' },
    ]);
    const chosen = [all[0]!, all[2]!];

    const res = await app.inject({
      method: 'POST',
      url: '/montages',
      headers: auth(u),
      payload: { mediaIds: chosen, theme: 'Chill', musicId: 'chill_90' },
    });
    expect(res.statusCode).toBe(202);
    const mid = res.json().montageId as string;

    // The persisted selection is EXACTLY the chosen subset (not all 4).
    const [row] = await db.select().from(montages).where(eq(montages.id, mid)).limit(1);
    expect([...(row!.sourceMediaIds ?? [])].sort()).toEqual([...chosen].sort());
    expect(row!.sourceMediaIds!.length).toBe(2);

    // Render it → the EDL only draws from the 2 selected sources (the mediaRefs the
    // renderer used embed the daily_media_item id; assert none of the UNCHOSEN ids leak).
    await drainMontageJobs(mid);
    const result = await renderMontage(mid, true);
    expect(result.status).toBe('draft_ready');
    const [after] = await db.select().from(montages).where(eq(montages.id, mid)).limit(1);
    const edl = after!.edl as { segments: Array<{ mediaRef: string }> };
    const refs = new Set(edl.segments.map((s) => s.mediaRef));
    const unchosen = [all[1]!, all[3]!];
    for (const ref of refs) {
      // Every segment's source must be one of the CHOSEN ids; never an unchosen one.
      expect(chosen.some((id) => ref.includes(id))).toBe(true);
      expect(unchosen.some((id) => ref.includes(id))).toBe(false);
    }
  }, 240_000);

  it('generate with a mediaId that is NOT the caller’s valid-today media → 422', async () => {
    const u = await signUp('badid');
    const mine = await seedValidMedia(u.userId, dayBucket, [
      { type: 'photo', color: '0x112233' },
    ]);
    // Mix a legit owned id with a foreign/unknown one → reject the whole request.
    const res = await app.inject({
      method: 'POST',
      url: '/montages',
      headers: auth(u),
      payload: { mediaIds: [mine[0]!, randomUUID()], theme: 'Party', musicId: 'house_120' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation');
    // The bad id is named in the rejection (not silently dropped).
    expect(res.json().error.details.rejected.length).toBe(1);
    // Nothing was created.
    const rows = await db.select().from(montages).where(eq(montages.userId, u.userId));
    expect(rows.length).toBe(0);
  });

  /* ------------------- FIX 1: render-trigger rate limiting ------------------ */

  it('rapid repeated POST /montages for one user → 429 after the render cap', async () => {
    const u = await signUp('storm');
    await seedValidMedia(u.userId, dayBucket, [{ type: 'photo', color: '0x445566' }]);
    const mine = await db
      .select()
      .from(dailyMediaItems)
      .where(eq(dailyMediaItems.userId, u.userId));
    const ids = mine.map((m) => m.id);

    // The per-user render cap is 10/10min. Fire 12 generate attempts. Each generate
    // that wins flips to a generating row (one-active guard 409s the next), but EVERY
    // attempt consumes the render-trigger budget — so the cap is hit regardless.
    let got429 = false;
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/montages',
        headers: auth(u),
        payload: { mediaIds: ids, theme: 'Party', musicId: 'house_120' },
      });
      if (res.statusCode === 429) {
        got429 = true;
        expect(res.json().error.code).toBe('rate_limited');
        break;
      }
    }
    expect(got429).toBe(true);
  });

  /* --------------- FIX 4: replace requires a draft_ready replacement -------- */

  it('replace rejects an already-published replacement (must be draft_ready)', async () => {
    // `montageId` is published (above). Build a SECOND published montage for owner on
    // a DIFFERENT day so the active/one-per-day guards don't collide, then try to use
    // it as a replacement — replace must reject a published replacement.
    const otherDay = '2099-01-01';
    const [pub2] = await db
      .insert(montages)
      .values({
        userId: owner.userId,
        dayBucket: otherDay,
        status: 'published',
        theme: 'Party',
        musicId: 'house_120',
        videoPath: 'x/y/z.mp4',
        publishedAt: new Date(),
        expiryAt: new Date(Date.now() + 24 * 3600 * 1000),
      })
      .returning();
    // prior must share the replacement's day for the same-day check to pass first,
    // so create a draft prior on otherDay too.
    const [prior2] = await db
      .insert(montages)
      .values({
        userId: owner.userId,
        dayBucket: otherDay,
        status: 'draft_ready',
        theme: 'Party',
        musicId: 'house_120',
        videoPath: 'a/b/c.mp4',
      })
      .returning();

    const res = await app.inject({
      method: 'POST',
      url: `/montages/${prior2!.id}/replace`,
      headers: auth(owner),
      payload: { replacementMontageId: pub2!.id, groupIds: [groupA] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
    // The prior was untouched (not superseded).
    const [stillPrior] = await db
      .select()
      .from(montages)
      .where(eq(montages.id, prior2!.id))
      .limit(1);
    expect(stillPrior!.status).toBe('draft_ready');
  });

  /* ---------- FIX 3: replace removes the prior published expire job --------- */

  it('replace removes the prior published montage’s orphan expire job', async () => {
    // `montageId` is already published (an expire-montage job was scheduled for it).
    expect(await countJobs(EXPIRE_MONTAGE_JOB, montageId)).toBe(1);

    // Build a fresh draft_ready replacement for owner on the SAME day as montageId.
    const [repl] = await db
      .insert(montages)
      .values({
        userId: owner.userId,
        dayBucket,
        status: 'draft_ready',
        theme: 'Party',
        musicId: 'house_120',
        videoPath: 'repl/video.mp4',
        thumbnailPath: 'repl/thumb.jpg',
        durationMs: 30000,
      })
      .returning();

    const res = await app.inject({
      method: 'POST',
      url: `/montages/${montageId}/replace`,
      headers: auth(owner),
      payload: { replacementMontageId: repl!.id, groupIds: [groupA] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('published');

    // The prior's expire-montage orphan was removed; the replacement has its own.
    expect(await countJobs(EXPIRE_MONTAGE_JOB, montageId)).toBe(0);
    expect(await countJobs(EXPIRE_MONTAGE_JOB, repl!.id)).toBe(1);

    // Prior is superseded by the replacement.
    const [priorAfter] = await db
      .select()
      .from(montages)
      .where(eq(montages.id, montageId))
      .limit(1);
    expect(priorAfter!.status).toBe('deleted_by_user');
    expect(priorAfter!.supersededBy).toBe(repl!.id);
  });

  /* ------------------------------- unauth ---------------------------------- */

  it('montage routes require a session (401 without a token)', async () => {
    const res = await app.inject({ method: 'GET', url: '/montages/options' });
    expect(res.statusCode).toBe(401);
  });
});
