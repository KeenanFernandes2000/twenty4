// Thin admin read-only routes (M9 §2/§5). Just enough to *see* a dropped cleanup
// job + the live content footprint; the full moderation/admin console is M12. Both
// routes are admin-guarded ([requireSession, requireAdmin(action)] — non-admin 403,
// each call audited). Strictly READ-only: no deletion / mutation here.
import { count, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  cleanupJobsResSchema,
  storageUsageResSchema,
  type CleanupJobsRes,
  type StorageUsageRes,
} from "@twenty4/contracts";
import { comment, dailyMediaItem, montage, reaction } from "@twenty4/contracts/db";
import { makeRequireAdmin, makeRequireSession } from "../auth/guards.ts";
import type { Auth } from "../auth/betterAuth.ts";
import type { CleanupQueues } from "../cleanup/queue.ts";
import type { DbClient } from "../db.ts";

export interface AdminRoutesDeps {
  db: DbClient;
  auth: Auth;
  cleanupQueues?: CleanupQueues;
}

// Cap the per-queue failed-job sample (a thin view, not a full job browser).
const FAILED_SAMPLE = 25;

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminRoutesDeps): Promise<void> {
  const { db, auth, cleanupQueues } = deps;
  const requireSession = makeRequireSession({ auth, db });
  const requireAdmin = makeRequireAdmin({ auth, db });

  // ── GET /admin/cleanup-jobs ──────────────────────────────────────────────────
  // Read-only failed/lost cleanup-job list across the four one-shot queues. Content-
  // free: only job ids/names + the engine's failedReason (an error string, never
  // montage/comment/reaction content).
  app.get(
    "/admin/cleanup-jobs",
    { preHandler: [requireSession, requireAdmin("admin.cleanup_jobs")] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const queues = cleanupQueues
        ? [
            { queue: "expire-montage", q: cleanupQueues.expireMontage },
            { queue: "raw-purge", q: cleanupQueues.rawPurge },
            { queue: "purge-account", q: cleanupQueues.purgeAccount },
            { queue: "delete-montage", q: cleanupQueues.deleteMontage },
          ]
        : [];

      const out: CleanupJobsRes["queues"] = [];
      for (const { queue, q } of queues) {
        const counts = await q.getJobCounts("failed", "delayed");
        const failed = await q.getFailed(0, FAILED_SAMPLE - 1);
        out.push({
          queue,
          failed: counts.failed ?? 0,
          delayed: counts.delayed ?? 0,
          jobs: failed.map((j) => ({
            id: j.id ?? null,
            name: j.name,
            failedReason: j.failedReason ?? null,
            attemptsMade: j.attemptsMade ?? 0,
          })),
        });
      }

      const res: CleanupJobsRes = { queues: out };
      reply.status(200).send(cleanupJobsResSchema.parse(res));
    },
  );

  // ── GET /admin/storage-usage ─────────────────────────────────────────────────
  // Read-only live-content footprint (row counts). S3 object counts are out-of-scope
  // for the thin M9 view (M12 wires the full dashboard).
  app.get(
    "/admin/storage-usage",
    { preHandler: [requireSession, requireAdmin("admin.storage_usage")] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const [live] = await db.db
        .select({ c: count() })
        .from(montage)
        .where(sql`${montage.status} IN ('generating','draft_ready','published')`);
      const [published] = await db.db
        .select({ c: count() })
        .from(montage)
        .where(eq(montage.status, "published"));
      const [raw] = await db.db
        .select({ c: count() })
        .from(dailyMediaItem)
        .where(sql`${dailyMediaItem.processingStatus} <> 'deleted'`);
      const [reacts] = await db.db.select({ c: count() }).from(reaction);
      const [comments] = await db.db
        .select({ c: count() })
        .from(comment)
        .where(eq(comment.status, "active"));

      const res: StorageUsageRes = {
        liveMontages: live?.c ?? 0,
        publishedMontages: published?.c ?? 0,
        rawMediaItems: raw?.c ?? 0,
        reactions: reacts?.c ?? 0,
        comments: comments?.c ?? 0,
      };
      reply.status(200).send(storageUsageResSchema.parse(res));
    },
  );
}
