// Thin admin subsystem assembly (M9 §5) — registers the read-only /admin/cleanup-
// jobs + /admin/storage-usage routes. Called by buildApp() alongside the other
// subsystems, reusing the shared BA auth instance + cleanup queues.
import type { FastifyInstance } from "fastify";
import type { Auth } from "../auth/betterAuth.ts";
import type { CleanupQueues } from "../cleanup/queue.ts";
import type { DbClient } from "../db.ts";
import { registerAdminRoutes } from "./routes.ts";

export interface RegisterAdminDeps {
  db: DbClient;
  auth: Auth;
  cleanupQueues?: CleanupQueues;
}

export async function registerAdmin(app: FastifyInstance, deps: RegisterAdminDeps): Promise<void> {
  await registerAdminRoutes(app, deps);
}
