// M9 §6 deletion-suite seed helpers. Seeds montages / raw / reactions / comments /
// visibility / reports + real S3 objects DIRECTLY (no API), so the suite can assert
// rows AND S3 objects are provably gone after the cleanup processors run.
import { randomUUID } from "node:crypto";
import {
  auditLog,
  block,
  comment,
  dailyMediaItem,
  group,
  groupInvite,
  groupMember,
  montage,
  montageGroupVisibility,
  reaction,
  report,
  user,
} from "@twenty4/contracts/db";
import { and, eq, or } from "drizzle-orm";
import type { WorkerDb } from "../src/db.ts";
import type { WorkerS3 } from "../src/s3.ts";
import { montageKey, montageThumbnailKey, putObject } from "../src/s3.ts";

// Track every uploaded object so afterAll can sweep S3 clean regardless of outcome.
export interface Tracked {
  bucket: string;
  key: string;
}

export async function seedUser(db: WorkerDb, tz = "UTC"): Promise<string> {
  const phone = `+1788${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 900 + 100)}`;
  const ins = await db.db.insert(user).values({ phone, timezone: tz }).returning({ id: user.id });
  return ins[0]!.id;
}

export async function seedGroup(db: WorkerDb, ownerId: string): Promise<string> {
  const ins = await db.db
    .insert(group)
    .values({ name: `g-${randomUUID().slice(0, 8)}`, ownerId })
    .returning({ id: group.id });
  return ins[0]!.id;
}

export async function uploadObject(
  s3: WorkerS3,
  tracked: Tracked[],
  bucket: string,
  key: string,
): Promise<void> {
  await putObject(s3, bucket, key, Buffer.from(`obj-${key}`), "application/octet-stream");
  tracked.push({ bucket, key });
}

export interface SeedMontageArgs {
  userId: string;
  s3: WorkerS3;
  tracked: Tracked[];
  status?: "published" | "draft_ready" | "generating" | "failed";
  dayBucket?: string;
  publishedAt?: Date | null;
  expiryAt?: Date | null;
  supersededBy?: string | null;
  withObjects?: boolean; // upload real video+thumb S3 objects (default true)
}

// Seed a montage row + (optionally) its real S3 video/thumbnail objects. Returns
// the montage id + the two S3 keys.
export async function seedMontage(
  db: WorkerDb,
  args: SeedMontageArgs,
): Promise<{ id: string; videoKey: string; thumbKey: string }> {
  const id = randomUUID();
  const videoKey = montageKey(args.userId, id);
  const thumbKey = montageThumbnailKey(args.userId, id);
  const withObjects = args.withObjects ?? true;
  if (withObjects) {
    await uploadObject(args.s3, args.tracked, args.s3.montagesBucket, videoKey);
    await uploadObject(args.s3, args.tracked, args.s3.thumbnailsBucket, thumbKey);
  }
  await db.db.insert(montage).values({
    id,
    userId: args.userId,
    dayBucket: args.dayBucket ?? "2026-06-29",
    status: args.status ?? "published",
    theme: "clean",
    musicId: "clean",
    videoPath: withObjects ? videoKey : null,
    thumbnailPath: withObjects ? thumbKey : null,
    publishedAt: args.publishedAt ?? null,
    expiryAt: args.expiryAt ?? null,
    supersededBy: args.supersededBy ?? null,
  });
  return { id, videoKey, thumbKey };
}

// ── social-graph footprint seeds (account-purge §6) ─────────────────────────────
export async function seedGroupMember(db: WorkerDb, groupId: string, userId: string): Promise<void> {
  await db.db.insert(groupMember).values({ groupId, userId }).onConflictDoNothing();
}

export async function seedBlock(db: WorkerDb, blockerUserId: string, blockedUserId: string): Promise<void> {
  await db.db.insert(block).values({ blockerUserId, blockedUserId }).onConflictDoNothing();
}

export async function seedGroupInvite(db: WorkerDb, groupId: string, createdBy: string): Promise<string> {
  const ins = await db.db
    .insert(groupInvite)
    .values({ groupId, createdBy, code: randomUUID().slice(0, 10), expiresAt: new Date(Date.now() + 86_400_000) })
    .returning({ id: groupInvite.id });
  return ins[0]!.id;
}

export async function countGroupMembers(db: WorkerDb, userId: string): Promise<number> {
  return (await db.db.select({ userId: groupMember.userId }).from(groupMember).where(eq(groupMember.userId, userId)))
    .length;
}

export async function countBlocks(db: WorkerDb, userId: string): Promise<number> {
  return (
    await db.db
      .select({ id: block.id })
      .from(block)
      .where(or(eq(block.blockerUserId, userId), eq(block.blockedUserId, userId)))
  ).length;
}

export async function countInvitesBy(db: WorkerDb, createdBy: string): Promise<number> {
  return (await db.db.select({ id: groupInvite.id }).from(groupInvite).where(eq(groupInvite.createdBy, createdBy))).length;
}

// Read the user row's PII columns + status (post-purge anonymization assertions).
export async function userPii(
  db: WorkerDb,
  userId: string,
): Promise<{
  displayName: string | null;
  username: string | null;
  email: string | null;
  phone: string | null;
  profilePhotoUrl: string | null;
  timezone: string | null;
  accountStatus: string;
} | null> {
  const rows = await db.db
    .select({
      displayName: user.displayName,
      username: user.username,
      email: user.email,
      phone: user.phone,
      profilePhotoUrl: user.profilePhotoUrl,
      timezone: user.timezone,
      accountStatus: user.accountStatus,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function seedReaction(db: WorkerDb, montageId: string, userId: string): Promise<string> {
  const ins = await db.db
    .insert(reaction)
    .values({ montageId, userId, type: "like" })
    .returning({ id: reaction.id });
  return ins[0]!.id;
}

export async function seedComment(db: WorkerDb, montageId: string, userId: string): Promise<string> {
  const ins = await db.db
    .insert(comment)
    .values({ montageId, userId, text: "secret comment text PII" })
    .returning({ id: comment.id });
  return ins[0]!.id;
}

export async function seedVisibility(db: WorkerDb, montageId: string, groupId: string): Promise<void> {
  await db.db.insert(montageGroupVisibility).values({ montageId, groupId });
}

export interface SeedRawArgs {
  userId: string;
  s3: WorkerS3;
  tracked: Tracked[];
  dayBucket: string;
  withThumb?: boolean;
}

export async function seedRawItem(db: WorkerDb, args: SeedRawArgs): Promise<{ id: string; storageKey: string }> {
  const id = randomUUID();
  const storageKey = `media/${args.userId}/${id}`;
  await uploadObject(args.s3, args.tracked, args.s3.rawBucket, storageKey);
  let thumbnailPath: string | null = null;
  if (args.withThumb) {
    thumbnailPath = `thumbnails/${args.userId}/${id}`;
    await uploadObject(args.s3, args.tracked, args.s3.thumbnailsBucket, thumbnailPath);
  }
  await db.db.insert(dailyMediaItem).values({
    id,
    userId: args.userId,
    dayBucket: args.dayBucket,
    mediaType: "photo",
    storagePath: storageKey,
    thumbnailPath,
    validationStatus: "valid",
    processingStatus: "valid",
  });
  return { id, storageKey };
}

export async function seedReport(
  db: WorkerDb,
  args: { reporterUserId: string; targetId: string; snapshotPath: string; retainUntil: Date },
): Promise<string> {
  const ins = await db.db
    .insert(report)
    .values({
      reporterUserId: args.reporterUserId,
      targetType: "montage",
      targetId: args.targetId,
      reason: "abuse",
      snapshotPath: args.snapshotPath,
      snapshotMetadata: { text: "reported content PII blob" },
      retainUntil: args.retainUntil,
    })
    .returning({ id: report.id });
  return ins[0]!.id;
}

// ── assertion helpers ──────────────────────────────────────────────────────────
export async function montageExists(db: WorkerDb, id: string): Promise<boolean> {
  const r = await db.db.select({ id: montage.id }).from(montage).where(eq(montage.id, id)).limit(1);
  return r.length > 0;
}

export async function countReactions(db: WorkerDb, montageId: string): Promise<number> {
  return (await db.db.select({ id: reaction.id }).from(reaction).where(eq(reaction.montageId, montageId))).length;
}

export async function countComments(db: WorkerDb, montageId: string): Promise<number> {
  return (await db.db.select({ id: comment.id }).from(comment).where(eq(comment.montageId, montageId))).length;
}

export async function countVisibility(db: WorkerDb, montageId: string): Promise<number> {
  return (
    await db.db
      .select({ groupId: montageGroupVisibility.groupId })
      .from(montageGroupVisibility)
      .where(eq(montageGroupVisibility.montageId, montageId))
  ).length;
}

export async function countRaw(db: WorkerDb, userId: string, dayBucket: string): Promise<number> {
  return (
    await db.db
      .select({ id: dailyMediaItem.id })
      .from(dailyMediaItem)
      .where(and(eq(dailyMediaItem.userId, userId), eq(dailyMediaItem.dayBucket, dayBucket)))
  ).length;
}

// All audit_log rows for a target (the tombstones), for the count-exactly-one + no-
// content assertions.
export async function tombstonesFor(
  db: WorkerDb,
  targetId: string,
): Promise<{ action: string; metadata: Record<string, unknown> }[]> {
  const rows = await db.db
    .select({ action: auditLog.action, metadata: auditLog.metadata })
    .from(auditLog)
    .where(eq(auditLog.targetId, targetId));
  return rows as { action: string; metadata: Record<string, unknown> }[];
}

// Drop a user + everything that cascades from it (montage/media/reaction/comment/
// audit/report/group), for afterAll cleanup.
export async function dropUser(db: WorkerDb, userId: string): Promise<void> {
  await db.sql`DELETE FROM "group" WHERE owner_id = ${userId}`.catch(() => {});
  await db.sql`DELETE FROM "user" WHERE id = ${userId}`.catch(() => {});
}
