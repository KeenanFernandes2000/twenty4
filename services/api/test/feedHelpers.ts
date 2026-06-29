// M8 feed + social test helpers — extend the M7 montage helpers (buildMontageApp
// wires the FULL app, incl. registerFeed, since it calls buildApp). Adds direct
// seeders for the social fixtures: a published+visible montage, a direct group
// membership (bypassing the invite flow), a block row (write-API is M12 — tests
// seed directly), and a comment row. Plus a Redis flush of the social rate-limit
// counters so the 429 cases don't bleed between runs.
import { eq } from "drizzle-orm";
import { block, comment, groupMember, montageGroupVisibility, user } from "@twenty4/contracts/db";
import type { DbClient } from "../src/db.ts";
import type { RedisClient } from "../src/redis.ts";
import { SOCIAL_REDIS_KEY_GLOBS } from "../src/feed/socialRateLimit.ts";
import { seedMontage, todayBucket } from "./montageHelpers.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

// Seed a PUBLISHED, unexpired montage with a video + thumbnail path and a
// montage_group_visibility row into `groupId`. Defaults: published now, expires
// +24h, 30s. Returns the montage id.
export async function seedPublishedMontage(
  db: DbClient,
  args: {
    userId: string;
    groupId?: string;
    dayBucket?: string;
    videoPath?: string | null;
    thumbnailPath?: string | null;
    durationMs?: number | null;
    publishedAt?: Date;
    expiryAt?: Date;
  },
): Promise<string> {
  const publishedAt = args.publishedAt ?? new Date();
  const expiryAt = args.expiryAt ?? new Date(publishedAt.getTime() + DAY_MS);
  const id = await seedMontage(db, {
    userId: args.userId,
    status: "published",
    dayBucket: args.dayBucket ?? todayBucket(),
    videoPath: args.videoPath === undefined ? `montages/${args.userId}/v` : args.videoPath,
    thumbnailPath: args.thumbnailPath === undefined ? `thumbnails/${args.userId}/poster` : args.thumbnailPath,
    durationMs: args.durationMs === undefined ? 30000 : args.durationMs,
    publishedAt,
    expiryAt,
  });
  if (args.groupId) {
    await db.db
      .insert(montageGroupVisibility)
      .values({ montageId: id, groupId: args.groupId })
      .onConflictDoNothing();
  }
  return id;
}

// Directly insert/activate a group membership (simpler than the invite/join flow).
export async function addMemberDirect(
  db: DbClient,
  groupId: string,
  userId: string,
  role: "owner" | "admin" | "member" = "member",
): Promise<void> {
  await db.db
    .insert(groupMember)
    .values({ groupId, userId, role, status: "active" })
    .onConflictDoUpdate({
      target: [groupMember.groupId, groupMember.userId],
      set: { status: "active", role },
    });
}

// Seed a directed block row (blocker → blocked). The write-API is M12; M8 only reads.
export async function seedBlock(db: DbClient, blockerId: string, blockedId: string): Promise<void> {
  await db.db
    .insert(block)
    .values({ blockerUserId: blockerId, blockedUserId: blockedId })
    .onConflictDoNothing();
}

// Seed a comment row directly (status defaults to active).
export async function seedComment(
  db: DbClient,
  args: { montageId: string; userId: string; text: string; status?: "active" | "deleted"; createdAt?: Date },
): Promise<string> {
  const rows = await db.db
    .insert(comment)
    .values({
      montageId: args.montageId,
      userId: args.userId,
      text: args.text,
      status: args.status ?? "active",
      ...(args.createdAt ? { createdAt: args.createdAt } : {}),
    })
    .returning({ id: comment.id });
  return rows[0]!.id;
}

// Give a seeded (phone-only) user a display name + avatar so the feed author block
// is non-null and assertable.
export async function setUserProfile(
  db: DbClient,
  userId: string,
  displayName: string,
  profilePhotoUrl: string,
): Promise<void> {
  await db.db.update(user).set({ displayName, profilePhotoUrl }).where(eq(user.id, userId));
}

// Flush ONLY the social rate-limit keys (comment:* / reaction:*) so rate-limit
// cases are deterministic without nuking unrelated Redis state.
export async function flushSocialKeys(redis: RedisClient): Promise<void> {
  for (const glob of SOCIAL_REDIS_KEY_GLOBS) {
    const keys = await redis.keys(glob);
    if (keys.length > 0) await redis.del(...keys);
  }
}
