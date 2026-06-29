// M9 §6 DELETION SUITE — the hard correctness gate (live PG + Redis + MinIO).
//
// Happy paths + the 6 lost-job regressions + the jobId guard. Drives the cleanup
// PROCESSORS / sweeps directly (synchronous, no spawned worker) and asserts BOTH
// rows AND S3 objects are provably gone, with only content-free tombstones left.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Queue } from "bullmq";
import {
  deleteMontageJobId,
  expireMontageJobId,
  purgeAccountJobId,
  rawPurgeJobId,
  resolveDayBucket,
  type Env,
} from "@twenty4/contracts";
import { montage, user } from "@twenty4/contracts/db";
import { eq } from "drizzle-orm";
import { createWorkerDb, createWorkerS3 } from "../src/index.ts";
import type { WorkerDb } from "../src/db.ts";
import type { WorkerS3 } from "../src/s3.ts";
import type { CleanupDeps } from "../src/cleanup/primitives.ts";
import { deleteMontageHard } from "../src/cleanup/primitives.ts";
import {
  processExpireMontage,
  processPurgeAccount,
  processRawPurge,
} from "../src/cleanup/processors.ts";
import {
  sweepDayClose,
  sweepExpiries,
  sweepRawPurge,
  sweepSnapshotPurge,
} from "../src/cleanup/sweeps.ts";
import { loadWorkerEnv, objectExists } from "./helpers.ts";
import {
  countBlocks,
  countComments,
  countGroupMembers,
  countInvitesBy,
  countRaw,
  countReactions,
  countVisibility,
  dropUser,
  montageExists,
  seedBlock,
  seedComment,
  seedGroup,
  seedGroupInvite,
  seedGroupMember,
  seedMontage,
  seedRawItem,
  seedReaction,
  seedReport,
  seedUser,
  seedVisibility,
  tombstonesFor,
  uploadObject,
  userPii,
  type Tracked,
} from "./cleanupHelpers.ts";

const env: Env = loadWorkerEnv();
let db: WorkerDb;
let s3: WorkerS3;
let deps: CleanupDeps;

const userIds: string[] = [];
const tracked: Tracked[] = [];

// Relative day buckets so the suite is clock-independent.
const TODAY = resolveDayBucket(new Date(), "UTC");
const CLOSED = resolveDayBucket(new Date(Date.now() - 3 * 86_400_000), "UTC"); // window long closed
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const hoursAhead = (h: number) => new Date(Date.now() + h * 3_600_000);

// metadata allow-list the tombstones must NOT exceed (content-free guarantee).
const MONTAGE_TOMBSTONE_KEYS = new Set([
  "action",
  "montageId",
  "reason",
  "reactionCount",
  "commentCount",
  "visibilityCount",
]);

beforeAll(async () => {
  db = createWorkerDb(env.DATABASE_URL);
  s3 = createWorkerS3(env);
  deps = { db, s3, env };
});

afterAll(async () => {
  const { deleteObjectIdempotent } = await import("../src/cleanup/s3.ts");
  for (const t of tracked) await deleteObjectIdempotent(s3, t.bucket, t.key).catch(() => {});
  for (const uid of userIds) await dropUser(db, uid);
  await db.sql.end({ timeout: 5 });
});

async function newUser(tz = "UTC"): Promise<string> {
  const id = await seedUser(db, tz);
  userIds.push(id);
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
describe("§6 happy paths", () => {
  test("expiry purges EVERYTHING: row + S3 video/thumb + reactions/comments/visibility; one content-free tombstone", async () => {
    const owner = await newUser();
    const reactor = await newUser();
    const groupId = await seedGroup(db, owner);
    const { id, videoKey, thumbKey } = await seedMontage(db, {
      userId: owner,
      s3,
      tracked,
      status: "published",
      dayBucket: TODAY,
      publishedAt: hoursAgo(24),
      expiryAt: hoursAgo(0.1),
    });
    await seedReaction(db, id, reactor);
    await seedReaction(db, id, owner);
    await seedComment(db, id, reactor);
    await seedVisibility(db, id, groupId);

    // sanity: objects + children exist pre-delete.
    expect(await objectExists(s3.client, s3.montagesBucket, videoKey)).toBe(true);
    expect(await objectExists(s3.client, s3.thumbnailsBucket, thumbKey)).toBe(true);
    expect(await countReactions(db, id)).toBe(2);
    expect(await countComments(db, id)).toBe(1);
    expect(await countVisibility(db, id)).toBe(1);

    const res = await processExpireMontage(deps, { montageId: id });
    expect(res.deleted).toBe(true);

    // Row + ALL children gone.
    expect(await montageExists(db, id)).toBe(false);
    expect(await countReactions(db, id)).toBe(0);
    expect(await countComments(db, id)).toBe(0);
    expect(await countVisibility(db, id)).toBe(0);
    // S3 video + thumb gone.
    expect(await objectExists(s3.client, s3.montagesBucket, videoKey)).toBe(false);
    expect(await objectExists(s3.client, s3.thumbnailsBucket, thumbKey)).toBe(false);

    // Exactly ONE sanitized tombstone, no content.
    const tombs = await tombstonesFor(db, id);
    expect(tombs.length).toBe(1);
    expect(tombs[0]!.action).toBe("montage.deleted");
    const meta = tombs[0]!.metadata;
    expect(meta.reason).toBe("expired");
    expect(meta.montageId).toBe(id);
    expect(meta.reactionCount).toBe(2);
    expect(meta.commentCount).toBe(1);
    for (const k of Object.keys(meta)) expect(MONTAGE_TOMBSTONE_KEYS.has(k)).toBe(true);
    // No path / text anywhere in the serialized metadata.
    const blob = JSON.stringify(meta);
    expect(blob).not.toContain("media/");
    expect(blob).not.toContain("montages/");
    expect(blob).not.toContain("PII");
  });

  test("raw purged after publish+grace: all daily_media_item (used+unused) + S3 objects gone", async () => {
    const owner = await newUser();
    await seedRawItem(db, { userId: owner, s3, tracked, dayBucket: TODAY }); // unused
    const used = await seedRawItem(db, { userId: owner, s3, tracked, dayBucket: TODAY, withThumb: true });

    expect(await countRaw(db, owner, TODAY)).toBe(2);
    expect(await objectExists(s3.client, s3.rawBucket, used.storageKey)).toBe(true);

    const res = await processRawPurge(deps, { userId: owner, dayBucket: TODAY });
    expect(res.rows).toBe(2);

    expect(await countRaw(db, owner, TODAY)).toBe(0);
    expect(await objectExists(s3.client, s3.rawBucket, used.storageKey)).toBe(false);
  });

  test("day-close purges unpublished raw for a CLOSED window", async () => {
    const owner = await newUser();
    const item = await seedRawItem(db, { userId: owner, s3, tracked, dayBucket: CLOSED });
    expect(await countRaw(db, owner, CLOSED)).toBe(1);

    const res = await sweepDayClose(deps);
    expect(res.bucketsReclaimed).toBeGreaterThanOrEqual(1);

    expect(await countRaw(db, owner, CLOSED)).toBe(0);
    expect(await objectExists(s3.client, s3.rawBucket, item.storageKey)).toBe(false);
  });

  test("account purge: recap content gone + PII scrubbed + social-graph footprint gone; row persists as deleted shell", async () => {
    const owner = await newUser();
    const other = await newUser();
    // Populate the owner's PII so the post-purge anonymization is observable.
    await db.db
      .update(user)
      .set({
        displayName: "Real Name",
        username: `u${Date.now().toString().slice(-9)}`,
        email: `del-${Date.now()}@example.com`,
        profilePhotoUrl: "https://cdn.example.com/me.jpg",
      })
      .where(eq(user.id, owner));
    // owner owns a published montage + raw.
    const own = await seedMontage(db, {
      userId: owner,
      s3,
      tracked,
      status: "published",
      dayBucket: TODAY,
      publishedAt: hoursAgo(1),
      expiryAt: hoursAhead(23),
    });
    await seedReaction(db, own.id, owner);
    const ownRaw = await seedRawItem(db, { userId: owner, s3, tracked, dayBucket: TODAY });
    // owner also reacts + comments on OTHER's montage.
    const others = await seedMontage(db, {
      userId: other,
      s3,
      tracked,
      status: "published",
      dayBucket: TODAY,
      publishedAt: hoursAgo(1),
      expiryAt: hoursAhead(23),
    });
    await seedReaction(db, others.id, owner);
    await seedComment(db, others.id, owner);
    // social-graph footprint: a shared group (owned by OTHER → survives), owner a
    // member, blocks in BOTH directions, an invite owner created.
    const sharedGroup = await seedGroup(db, other);
    await seedGroupMember(db, sharedGroup, owner);
    await seedGroupMember(db, sharedGroup, other);
    await seedBlock(db, owner, other); // owner blocks other
    await seedBlock(db, other, owner); // other blocks owner
    await seedGroupInvite(db, sharedGroup, owner);
    expect(await countGroupMembers(db, owner)).toBe(1);
    expect(await countBlocks(db, owner)).toBe(2);
    expect(await countInvitesBy(db, owner)).toBe(1);

    const res = await processPurgeAccount(deps, { userId: owner });
    expect(res.montages).toBe(1);
    expect(res.reactionsOnOthers).toBe(1);
    expect(res.commentsOnOthers).toBe(1);

    // owner's montage + raw + its objects gone.
    expect(await montageExists(db, own.id)).toBe(false);
    expect(await objectExists(s3.client, s3.montagesBucket, own.videoKey)).toBe(false);
    expect(await objectExists(s3.client, s3.rawBucket, ownRaw.storageKey)).toBe(false);
    // owner's footprint on OTHER's (still-live) montage gone; the other montage survives.
    expect(await montageExists(db, others.id)).toBe(true);
    expect(await countReactions(db, others.id)).toBe(0);
    expect(await countComments(db, others.id)).toBe(0);

    // PII scrubbed to a content-free shell; row persists; account_status=deleted.
    const pii = await userPii(db, owner);
    expect(pii).not.toBeNull();
    expect(pii!.accountStatus).toBe("deleted");
    expect(pii!.displayName).toBeNull();
    expect(pii!.username).toBeNull();
    expect(pii!.email).toBeNull();
    expect(pii!.phone).toBeNull();
    expect(pii!.profilePhotoUrl).toBeNull();
    expect(pii!.timezone).toBeNull();

    // social-graph footprint gone (both block directions + roster + created invites);
    // the SHARED group row is intentionally KEPT (other members rely on it).
    expect(await countGroupMembers(db, owner)).toBe(0);
    expect(await countBlocks(db, owner)).toBe(0);
    expect(await countInvitesBy(db, owner)).toBe(0);
    const grp = await db.sql<{ id: string }[]>`SELECT id FROM "group" WHERE id = ${sharedGroup}`;
    expect(grp.length).toBe(1);

    // account-level summary tombstone present (and survives the row-scrub).
    const tombs = await tombstonesFor(db, owner);
    expect(tombs.some((t) => t.action === "account.purged")).toBe(true);
  });

  test("account purge is idempotent: a re-run (BullMQ retry/re-drain) converges to EXACTLY ONE account.purged tombstone", async () => {
    const owner = await newUser();
    await seedMontage(db, {
      userId: owner,
      s3,
      tracked,
      status: "published",
      dayBucket: TODAY,
      publishedAt: hoursAgo(1),
      expiryAt: hoursAhead(23),
    });

    await processPurgeAccount(deps, { userId: owner });
    const after1 = (await tombstonesFor(db, owner)).filter((t) => t.action === "account.purged");
    expect(after1.length).toBe(1);

    // Re-drain the SAME purge: the account is already 'deleted' → guarded no-op, NO
    // second summary tombstone.
    const res2 = await processPurgeAccount(deps, { userId: owner });
    expect(res2.montages).toBe(0); // nothing left to own
    const after2 = (await tombstonesFor(db, owner)).filter((t) => t.action === "account.purged");
    expect(after2.length).toBe(1);
    // still a deleted shell.
    expect((await userPii(db, owner))!.accountStatus).toBe("deleted");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§6 lost-job regressions", () => {
  test("#1 replace hides prior — sweep-expiries reclaims the superseded prior (not past its own expiry); successor survives", async () => {
    const owner = await newUser();
    // successor: published, future expiry.
    const successor = await seedMontage(db, {
      userId: owner,
      s3,
      tracked,
      status: "published",
      dayBucket: TODAY,
      publishedAt: hoursAgo(0.5),
      expiryAt: hoursAhead(23),
    });
    // prior: published, future expiry (NOT past), superseded_by=successor — its
    // delayed expire job is DROPPED (never run).
    const prior = await seedMontage(db, {
      userId: owner,
      s3,
      tracked,
      status: "published",
      dayBucket: TODAY,
      publishedAt: hoursAgo(2),
      expiryAt: hoursAhead(22), // explicitly NOT past its own expiry
      supersededBy: successor.id,
    });

    const res = await sweepExpiries(deps);
    expect(res.expiredReclaimed).toBeGreaterThanOrEqual(1);

    // prior reclaimed despite not being past its own expiry; successor untouched.
    expect(await montageExists(db, prior.id)).toBe(false);
    expect(await objectExists(s3.client, s3.montagesBucket, prior.videoKey)).toBe(false);
    expect(await montageExists(db, successor.id)).toBe(true);
    expect(await objectExists(s3.client, s3.montagesBucket, successor.videoKey)).toBe(true);
    const tombs = await tombstonesFor(db, prior.id);
    expect(tombs.length).toBe(1);
    expect(tombs[0]!.metadata.reason).toBe("swept_expired");
  });

  test("#2 no raw-purge backstop — raw-purge-sweep reclaims raw of a published recap past +grace", async () => {
    const owner = await newUser();
    // published, published_at well past grace (default 60m): published 2h ago.
    await seedMontage(db, {
      userId: owner,
      s3,
      tracked,
      status: "published",
      dayBucket: TODAY,
      publishedAt: hoursAgo(2),
      expiryAt: hoursAhead(22),
    });
    const item = await seedRawItem(db, { userId: owner, s3, tracked, dayBucket: TODAY });
    expect(await countRaw(db, owner, TODAY)).toBe(1);

    // The +grace raw-purge job is DROPPED — only the sweep runs.
    const res = await sweepRawPurge(deps);
    expect(res.bucketsReclaimed).toBeGreaterThanOrEqual(1);

    expect(await countRaw(db, owner, TODAY)).toBe(0);
    expect(await objectExists(s3.client, s3.rawBucket, item.storageKey)).toBe(false);
  });

  test("#3 orphan draft — sweep reclaims a never-published draft (window closed) + its S3 objects", async () => {
    const owner = await newUser();
    // draft_ready, never published, day-window CLOSED, real rendered S3 objects.
    const draft = await seedMontage(db, {
      userId: owner,
      s3,
      tracked,
      status: "draft_ready",
      dayBucket: CLOSED,
      publishedAt: null,
      expiryAt: null,
    });
    expect(await objectExists(s3.client, s3.montagesBucket, draft.videoKey)).toBe(true);

    const res = await sweepExpiries(deps);
    expect(res.orphanDraftsReclaimed).toBeGreaterThanOrEqual(1);

    expect(await montageExists(db, draft.id)).toBe(false);
    expect(await objectExists(s3.client, s3.montagesBucket, draft.videoKey)).toBe(false);
    expect(await objectExists(s3.client, s3.thumbnailsBucket, draft.thumbKey)).toBe(false);
    const tombs = await tombstonesFor(db, draft.id);
    expect(tombs.length).toBe(1);
    expect(tombs[0]!.metadata.reason).toBe("swept_orphan_draft");
  });

  test("#4 NULL-expiry published montage is UNCONSTRUCTIBLE — the DB CHECK rejects insert AND update", async () => {
    const owner = await newUser();
    // INSERT a published row with NULL expiry → CHECK montage_published_expiry_check rejects.
    await expect(
      (async () => {
        await db.db.insert(montage).values({
          userId: owner,
          dayBucket: TODAY,
          status: "published",
          theme: "clean",
          musicId: "clean",
          publishedAt: hoursAgo(1),
          expiryAt: null,
        });
      })(),
    ).rejects.toThrow();

    // A valid published row, then UPDATE expiry_at = NULL → also rejected.
    const ok = await seedMontage(db, {
      userId: owner,
      s3,
      tracked,
      status: "published",
      dayBucket: TODAY,
      publishedAt: hoursAgo(1),
      expiryAt: hoursAhead(23),
    });
    await expect(
      (async () => {
        await db.db.update(montage).set({ expiryAt: null }).where(eq(montage.id, ok.id));
      })(),
    ).rejects.toThrow();
    // (so the sweep's `expiry_at IS NULL` branch is a pure belt-and-suspenders;
    //  the predicate would catch one if the CHECK ever regressed.)
  });

  test("#5 non-atomic tombstone — crash-safe + idempotent: re-running converges to EXACTLY ONE tombstone, never a deleted-row-with-live-S3", async () => {
    // ── crash A: between S3 delete and the tx ────────────────────────────────
    const ownerA = await newUser();
    const a = await seedMontage(db, {
      userId: ownerA,
      s3,
      tracked,
      status: "published",
      dayBucket: TODAY,
      publishedAt: hoursAgo(24),
      expiryAt: hoursAgo(0.1),
    });
    await seedReaction(db, a.id, ownerA);
    await expect(
      deleteMontageHard(deps, a.id, "expired", {
        afterS3: () => {
          throw new Error("CRASH after S3, before tx");
        },
      }),
    ).rejects.toThrow("CRASH after S3");
    // S3 gone (S3-FIRST), row STILL alive, children STILL alive, NO tombstone.
    // The SAFE transient: a live row whose media is gone — NEVER a deleted/tombstoned
    // row with surviving S3 (the content leak).
    expect(await objectExists(s3.client, s3.montagesBucket, a.videoKey)).toBe(false);
    expect(await montageExists(db, a.id)).toBe(true);
    expect(await countReactions(db, a.id)).toBe(1);
    expect((await tombstonesFor(db, a.id)).length).toBe(0);

    // ── crash B: inside the tx, right before the tombstone insert ─────────────
    const ownerB = await newUser();
    const b = await seedMontage(db, {
      userId: ownerB,
      s3,
      tracked,
      status: "published",
      dayBucket: TODAY,
      publishedAt: hoursAgo(24),
      expiryAt: hoursAgo(0.1),
    });
    await seedReaction(db, b.id, ownerB);
    await expect(
      deleteMontageHard(deps, b.id, "expired", {
        beforeTombstone: () => {
          throw new Error("CRASH mid-tx, before tombstone");
        },
      }),
    ).rejects.toThrow("CRASH mid-tx");
    // Whole tx rolled back: row + children intact, NO tombstone; S3 already gone.
    expect(await montageExists(db, b.id)).toBe(true);
    expect(await countReactions(db, b.id)).toBe(1);
    expect((await tombstonesFor(db, b.id)).length).toBe(0);
    expect(await objectExists(s3.client, s3.montagesBucket, b.videoKey)).toBe(false);

    // ── re-run both to convergence; exactly ONE tombstone each, then no-op ─────
    for (const m of [a, b]) {
      const r1 = await deleteMontageHard(deps, m.id, "expired");
      expect(r1.deleted).toBe(true);
      expect(await montageExists(db, m.id)).toBe(false);
      expect((await tombstonesFor(db, m.id)).length).toBe(1);
      // idempotent re-run on the gone row: no second tombstone.
      const r2 = await deleteMontageHard(deps, m.id, "expired");
      expect(r2.deleted).toBe(false);
      expect((await tombstonesFor(db, m.id)).length).toBe(1);
    }
  });

  test("#6 snapshot PII retention — snapshot-purge-sweep strips a past-retention report snapshot", async () => {
    const reporter = await newUser();
    const snapshotKey = `thumbnails/${reporter}/report-snap-${Date.now()}`;
    await uploadObject(s3, tracked, s3.thumbnailsBucket, snapshotKey); // snapshotBucket defaults to thumbnails
    const reportId = await seedReport(db, {
      reporterUserId: reporter,
      targetId: reporter, // arbitrary target (no FK)
      snapshotPath: snapshotKey,
      retainUntil: hoursAgo(1), // past retention
    });
    expect(await objectExists(s3.client, s3.thumbnailsBucket, snapshotKey)).toBe(true);

    const res = await sweepSnapshotPurge(deps);
    expect(res.snapshotsPurged).toBeGreaterThanOrEqual(1);

    // S3 snapshot gone; PII columns nulled.
    expect(await objectExists(s3.client, s3.thumbnailsBucket, snapshotKey)).toBe(false);
    const row = await db.sql<{ snapshot_path: string | null; snapshot_metadata: unknown }[]>`
      SELECT snapshot_path, snapshot_metadata FROM report WHERE id = ${reportId}`;
    expect(row[0]!.snapshot_path).toBeNull();
    expect(row[0]!.snapshot_metadata).toBeNull();
    // content-free tombstone written.
    const tombs = await tombstonesFor(db, reportId);
    expect(tombs.length).toBe(1);
    expect(tombs[0]!.action).toBe("report.snapshot_purged");
    expect(JSON.stringify(tombs[0]!.metadata)).not.toContain("PII");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§6 jobId guard (runtime)", () => {
  test("every cleanup jobId enqueues with NO ':' (delayed scheduling intact)", async () => {
    const ids = [
      expireMontageJobId("11111111-1111-1111-1111-111111111111"),
      rawPurgeJobId("22222222-2222-2222-2222-222222222222", TODAY),
      purgeAccountJobId("33333333-3333-3333-3333-333333333333"),
      deleteMontageJobId("44444444-4444-4444-4444-444444444444"),
    ];
    for (const id of ids) expect(id.includes(":")).toBe(false);

    // Round-trip through a REAL BullMQ queue (unique name → no prod worker drains
    // it): BullMQ must preserve the colon-free jobId verbatim.
    const conn = (() => {
      const u = new URL(env.REDIS_URL);
      return { host: u.hostname, port: Number(u.port || 6379), maxRetriesPerRequest: null };
    })();
    const q = new Queue(`cleanup-jobid-guard-test-${process.pid}`, { connection: conn });
    try {
      for (const id of ids) {
        const job = await q.add("guard", {}, { jobId: id, delay: 60_000 });
        expect(job.id).toBe(id);
        expect(job.id!.includes(":")).toBe(false);
      }
    } finally {
      await q.obliterate({ force: true });
      await q.close();
    }
  });
});
