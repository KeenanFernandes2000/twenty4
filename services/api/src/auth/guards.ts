// Auth guards — requireSession + requireAdmin preHandlers, plus request typing.
// requireSession resolves a bearer/session token via BA's in-process getSession,
// loads our user row, and attaches it to request.user. requireAdmin additionally
// requires is_admin and writes an audit_log row per admin action.
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  AccountBannedError,
  AccountDeletedError,
  AccountSuspendedError,
  ForbiddenError,
  UnauthorizedError,
  sanitizeAuditMetadata,
} from "@twenty4/contracts";
import { auditLog, user as userTable } from "@twenty4/contracts/db";
import type { Auth } from "./betterAuth.ts";
import type { DbClient } from "../db.ts";

export type AccountStatus = "active" | "suspended" | "banned" | "deleted";

export interface AuthedUser {
  id: string;
  email: string | null;
  phone: string | null;
  isAdmin: boolean;
  accountStatus: AccountStatus;
  sessionToken: string;
}

// Account-status gate (the ONE shared place). Throws the matching 403 envelope
// code for a non-active user; returns for `active`. Used both here (every
// guarded request) and at /auth/verify (session-create). NOT a 401 — a valid
// bearer for a suspended/banned/deleted account is authenticated but forbidden.
export function assertActive(status: AccountStatus): void {
  switch (status) {
    case "active":
      return;
    case "suspended":
      throw new AccountSuspendedError();
    case "banned":
      throw new AccountBannedError();
    case "deleted":
      throw new AccountDeletedError();
  }
}

// Augment Fastify's request with our resolved user.
declare module "fastify" {
  interface FastifyRequest {
    user?: AuthedUser;
  }
}

// Build a Headers object BA's getSession understands from the incoming request
// (bearer header or cookie). BA accepts a standard web Headers.
function toHeaders(req: FastifyRequest): Headers {
  const h = new Headers();
  const auth = req.headers.authorization;
  if (typeof auth === "string") h.set("authorization", auth);
  const cookie = req.headers.cookie;
  if (typeof cookie === "string") h.set("cookie", cookie);
  return h;
}

// Extract the bearer token (for storing on request.user as sessionToken).
function bearerToken(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return undefined;
}

export interface GuardDeps {
  auth: Auth;
  db: DbClient;
}

// requireSession preHandler factory. 401 (envelope) on absent/invalid/expired/
// revoked token. On success attaches request.user.
export function makeRequireSession(deps: GuardDeps) {
  const { auth, db } = deps;
  return async function requireSession(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    let session: { user?: { id?: string } } | null = null;
    try {
      const raw = (await auth.api.getSession({ headers: toHeaders(req) })) as unknown;
      session = raw as { user?: { id?: string } } | null;
    } catch {
      session = null;
    }
    const userId = session?.user?.id;
    if (!userId) {
      throw new UnauthorizedError("Missing or invalid session");
    }

    // Load our user row (BA's getSession returns BA's user shape; we want ours).
    const rows = await db.db.select().from(userTable).where(eq(userTable.id, userId)).limit(1);
    const row = rows[0];
    if (!row) {
      throw new UnauthorizedError("Session user not found");
    }

    // Account-status gate on EVERY guarded request: a pre-existing valid bearer
    // for a suspended/banned/deleted account is immediately locked out (403, NOT
    // 401). Runs BEFORE we attach req.user, so no handler ever sees a blocked user.
    assertActive(row.accountStatus);

    req.user = {
      id: row.id,
      email: row.email,
      phone: row.phone,
      isAdmin: row.isAdmin,
      accountStatus: row.accountStatus,
      sessionToken: bearerToken(req) ?? "",
    };
  };
}

// requireAdmin preHandler factory. Runs requireSession semantics first (caller
// chains it), then asserts is_admin and writes an audit_log row.
// Usage: preHandler: [requireSession, makeRequireAdmin({...})(action)].
export function makeRequireAdmin(deps: GuardDeps) {
  const { db } = deps;
  return function requireAdmin(action: string) {
    return async function (req: FastifyRequest, _reply: FastifyReply): Promise<void> {
      const u = req.user;
      if (!u) {
        // Defensive: requireSession should have run and thrown already.
        throw new UnauthorizedError("Missing or invalid session");
      }
      if (!u.isAdmin) {
        throw new ForbiddenError("Admin privileges required");
      }
      // Audit every admin action — routed through the SAME sanitize chokepoint as
      // the deletion tombstones (no audit insert bypasses it), and the request ip is
      // HASHED (short sha256 hex), never stored raw at rest. targetId stays the route
      // (method + url), which carries no PII.
      const ipHash = req.ip ? createHash("sha256").update(req.ip).digest("hex").slice(0, 16) : null;
      await db.db.insert(auditLog).values({
        actorId: u.id,
        action,
        targetType: "request",
        targetId: `${req.method} ${req.url}`,
        metadata: sanitizeAuditMetadata(action, { ipHash }),
      });
    };
  };
}
