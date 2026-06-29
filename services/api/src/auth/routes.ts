// The /auth façade + /users routes, plus the raw-BA-OTP deny-list hook.
// All OTP flows go through /auth/start|verify, which drive Better Auth via
// in-process auth.api.* — never HTTP proxying. The account-status gate runs at
// session-create; suspended/banned/deleted are 403'd with no session minted.
import { and, eq, ne } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  UnauthorizedError,
  ValidationError,
  authStartReqSchema,
  authVerifyReqSchema,
  authRefreshReqSchema,
  channelSchema,
  createUserReqSchema,
  normalizeIdentifier,
  updateMeReqSchema,
  type UserDTO,
} from "@twenty4/contracts";
import { session as sessionTable, user as userTable } from "@twenty4/contracts/db";
import type { Auth } from "./betterAuth.ts";
import { isAdminEmail } from "./adminSeed.ts";
import { buildDenyPathSet, normalizeDenyPath } from "./denyList.ts";
import { assertActive, makeRequireAdmin, makeRequireSession } from "./guards.ts";
import type { OtpRateLimiter } from "./otpRateLimit.ts";
import type { OtpTransport } from "./otpTransport.ts";
import { enqueuePurgeAccount, type CleanupQueues } from "../cleanup/queue.ts";
import type { DbClient } from "../db.ts";

export interface AuthRoutesDeps {
  auth: Auth;
  db: DbClient;
  otp: OtpTransport;
  rateLimiter: OtpRateLimiter;
  adminEmails: Set<string>;
  nodeEnv: string;
  enableDevOtpRoute?: boolean;
  // M9 cleanup queues — DELETE /users/me enqueues purge-account (worker-async).
  cleanupQueues?: CleanupQueues;
}

// Map our user row → the UserDTO wire shape.
function toUserDto(row: typeof userTable.$inferSelect): UserDTO {
  return {
    id: row.id,
    displayName: row.displayName,
    username: row.username,
    email: row.email,
    phone: row.phone,
    profilePhotoUrl: row.profilePhotoUrl,
    authProvider: row.authProvider,
    accountStatus: row.accountStatus,
    isAdmin: row.isAdmin,
    createdAt: row.createdAt.toISOString(),
  };
}

function headersFrom(req: FastifyRequest): Headers {
  const h = new Headers();
  if (typeof req.headers.authorization === "string") h.set("authorization", req.headers.authorization);
  if (typeof req.headers.cookie === "string") h.set("cookie", req.headers.cookie);
  return h;
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): Promise<void> {
  const { auth, db, otp, rateLimiter, adminEmails, nodeEnv } = deps;
  const devOtpEnabled = deps.enableDevOtpRoute ?? nodeEnv !== "production";

  const requireSession = makeRequireSession({ auth, db });
  const requireAdminFactory = makeRequireAdmin({ auth, db });

  // ── Raw BA OTP deny-list (403) ─────────────────────────────────────────────
  // Throws Forbidden for any direct hit on a raw BA OTP path so OTP can't bypass
  // the throttled façade. THROWING (not reply.send) cleanly aborts the lifecycle
  // — a reply.send() in an onRequest hook with a body present lets the content-
  // type parser / route still fire → ERR_HTTP_HEADERS_SENT. The global error
  // handler serializes ForbiddenError to the 403 envelope.
  const denySet = buildDenyPathSet();
  app.addHook("onRequest", async (req) => {
    // Normalize the same way the deny set is built (lowercase + strip trailing
    // slash) so case/trailing-slash variants of a raw BA OTP path also 403.
    const path = normalizeDenyPath(req.url.split("?")[0] ?? "");
    if (denySet.has(path)) {
      throw new ForbiddenError("Raw auth OTP routes are disabled; use /auth/start|verify");
    }
  });

  // Helper: seed is_admin on the freshly-created/located user if the email matches.
  async function seedAdminIfNeeded(userId: string, email: string | null): Promise<void> {
    if (isAdminEmail(adminEmails, email)) {
      await db.db.update(userTable).set({ isAdmin: true }).where(eq(userTable.id, userId));
    }
  }

  // ── POST /auth/start ───────────────────────────────────────────────────────
  app.post("/auth/start", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = authStartReqSchema.parse(req.body);
    // Per-IP rate-limit key derives from the RAW socket peer, NOT req.ip. With
    // trustProxy:true, req.ip is X-Forwarded-For-derived (client-controlled →
    // spoofable → unlimited per-IP sends). In this dev topology nothing adds XFF,
    // so the socket address is the real client. trustProxy stays on (fine for
    // logging; M15 hardens the proxy story).
    const rlIp = req.socket.remoteAddress ?? req.ip ?? "unknown";
    await rateLimiter.checkStart({ ip: rlIp, identifier: body.identifier });

    if (body.channel === "phone") {
      // Mirror the email branch: surface a transport/BA failure as a clean
      // INTERNAL envelope instead of fire-and-forgetting silently.
      try {
        await auth.api.sendPhoneNumberOTP({ body: { phoneNumber: body.identifier } });
      } catch (err) {
        req.log.error({ err }, "phone OTP send failed");
        throw new InternalError("Failed to send OTP");
      }
    } else {
      // emailOTP.sendVerificationOTP routes through our transport (awaited; a send
      // failure throws → surfaced as INTERNAL, never a silent success).
      try {
        await auth.api.sendVerificationOTP({ body: { email: body.identifier, type: "sign-in" } });
      } catch (err) {
        req.log.error({ err }, "email OTP send failed");
        throw new InternalError("Failed to send OTP email");
      }
    }
    reply.status(202).send({ status: "sent", channel: body.channel });
  });

  // ── POST /auth/verify ──────────────────────────────────────────────────────
  app.post("/auth/verify", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = authVerifyReqSchema.parse(req.body);
    await rateLimiter.checkVerify(body.identifier);

    // 1) Verify via BA (creates the user on first verify). returnHeaders so we can
    //    surface BA's session cookie too.
    let token: string | undefined;
    let userId: string | undefined;
    try {
      if (body.channel === "phone") {
        const res = await auth.api.verifyPhoneNumber({
          body: { phoneNumber: body.identifier, code: body.code },
          returnHeaders: true,
        });
        const r = res.response as { status?: boolean; token?: string; user?: { id?: string } } | null;
        if (!r || r.status === false || !r.token || !r.user?.id) {
          throw new UnauthorizedError("Invalid or expired code");
        }
        token = r.token;
        userId = r.user.id;
      } else {
        const res = await auth.api.signInEmailOTP({
          body: { email: body.identifier, otp: body.code },
          returnHeaders: true,
        });
        const r = res.response as { token?: string; user?: { id?: string } } | null;
        if (!r?.token || !r.user?.id) {
          throw new UnauthorizedError("Invalid or expired code");
        }
        token = r.token;
        userId = r.user.id;
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) throw err;
      // BA throws APIError (often 400/401) on a bad/expired code.
      req.log.warn({ err }, "OTP verify failed");
      throw new UnauthorizedError("Invalid or expired code");
    }

    // 2) Account-status gate. If non-active, revoke the just-minted BA session and
    //    reject — assert NO usable session survives.
    const rows = await db.db.select().from(userTable).where(eq(userTable.id, userId)).limit(1);
    const row = rows[0];
    if (!row) throw new InternalError("User row missing after verify");

    if (row.accountStatus !== "active") {
      // Tear down the session BA just created so a blocked account holds none.
      await db.db.delete(sessionTable).where(eq(sessionTable.token, token));
      assertActive(row.accountStatus); // throws the right 403 code
    }

    // 3) is_admin seed on (first) sign-in.
    await seedAdminIfNeeded(row.id, row.email);

    // 4) Record the provider that owns this account on first verify. A phone-only
    //    signup carries a temp @phone.twenty4.invalid email, so we key off the
    //    verifying channel rather than the email shape.
    if (body.channel === "phone" && row.authProvider !== "phone") {
      await db.db.update(userTable).set({ authProvider: "phone" }).where(eq(userTable.id, row.id));
    }

    reply.status(200).send({
      token,
      userId: row.id,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
    });
  });

  // ── POST /auth/refresh ─────────────────────────────────────────────────────
  // Rotate/extend the current session. BA's session model extends on use; we
  // re-read the session to confirm it's still valid and return its token.
  app.post("/auth/refresh", { preHandler: requireSession }, async (req: FastifyRequest, reply: FastifyReply) => {
    authRefreshReqSchema.parse(req.body ?? {});
    const u = req.user!;
    // Defense-in-depth account-status gate. requireSession already gated on the
    // freshly-loaded row, but re-read here so a status flip between preHandler and
    // handler still blocks refresh — a suspended/banned/deleted account gets 403
    // and NO token is returned.
    const urows = await db.db
      .select({ accountStatus: userTable.accountStatus })
      .from(userTable)
      .where(eq(userTable.id, u.id))
      .limit(1);
    assertActive(urows[0]?.accountStatus ?? "active");
    // Confirm an unexpired session still exists for this token.
    const rows = await db.db
      .select()
      .from(sessionTable)
      .where(eq(sessionTable.token, u.sessionToken))
      .limit(1);
    const s = rows[0];
    if (!s || s.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedError("Session expired");
    }
    reply.status(200).send({ token: s.token, userId: u.id, expiresAt: s.expiresAt.toISOString() });
  });

  // ── POST /auth/logout ──────────────────────────────────────────────────────
  app.post("/auth/logout", { preHandler: requireSession }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await auth.api.signOut({ headers: headersFrom(req) });
    } catch {
      /* even if BA signOut errors, fall through to a hard delete below */
    }
    // Hard-revoke the bearer session row (bearer tokens have no cookie for signOut).
    if (req.user?.sessionToken) {
      await db.db.delete(sessionTable).where(eq(sessionTable.token, req.user.sessionToken));
    }
    reply.status(200).send({ status: "logged_out" });
  });

  // ── GET /auth/dev/last-otp ─────────────────────────────────────────────────
  app.get("/auth/dev/last-otp", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!devOtpEnabled) {
      reply.status(403).send({ error: { code: "FORBIDDEN", status: 403, message: "dev OTP route disabled" } });
      return;
    }
    const q = req.query as { identifier?: string; channel?: string };
    if (!q.identifier) throw new ValidationError("identifier query param is required");
    // Normalize the SAME way as /auth/start so this dev lookup hits the stored
    // key. The dev store is phone-only (otpTransport), so default channel=phone.
    const channel = channelSchema.catch("phone").parse(q.channel ?? "phone");
    const identifier = normalizeIdentifier(q.identifier, channel);
    const code = await otp.readDevOtp(identifier);
    reply.status(200).send({ identifier, code: code ?? null });
  });

  // ── POST /users ────────────────────────────────────────────────────────────
  // Complete a profile post-verify. Enforces email-or-phone presence at the app
  // layer (no PG CHECK) and unique citext username.
  app.post("/users", { preHandler: requireSession }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = createUserReqSchema.parse(req.body);
    const u = req.user!;

    // App-layer email-or-phone invariant (the dropped PG CHECK).
    const hasContact = Boolean(u.email && !u.email.endsWith("@phone.twenty4.invalid")) || Boolean(u.phone);
    if (!hasContact) {
      throw new ValidationError("an email or phone is required");
    }

    if (body.username) {
      const clash = await db.db
        .select({ id: userTable.id })
        .from(userTable)
        .where(and(eq(userTable.username, body.username), ne(userTable.id, u.id)))
        .limit(1);
      if (clash[0]) throw new ConflictError("username already taken");
    }

    const updates: Partial<typeof userTable.$inferInsert> = { updatedAt: new Date() };
    if (body.displayName !== undefined) updates.displayName = body.displayName;
    if (body.username !== undefined) updates.username = body.username;
    if (body.profilePhotoUrl !== undefined) updates.profilePhotoUrl = body.profilePhotoUrl;

    const updated = await db.db.update(userTable).set(updates).where(eq(userTable.id, u.id)).returning();
    reply.status(201).send(toUserDto(updated[0]!));
  });

  // ── PATCH /users/me ────────────────────────────────────────────────────────
  app.patch("/users/me", { preHandler: requireSession }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = updateMeReqSchema.parse(req.body);
    const u = req.user!;

    if (body.username) {
      const clash = await db.db
        .select({ id: userTable.id })
        .from(userTable)
        .where(and(eq(userTable.username, body.username), ne(userTable.id, u.id)))
        .limit(1);
      if (clash[0]) throw new ConflictError("username already taken");
    }

    const updates: Partial<typeof userTable.$inferInsert> = { updatedAt: new Date() };
    if (body.displayName !== undefined) updates.displayName = body.displayName;
    if (body.username !== undefined) updates.username = body.username;
    if (body.profilePhotoUrl !== undefined) updates.profilePhotoUrl = body.profilePhotoUrl;

    const updated = await db.db.update(userTable).set(updates).where(eq(userTable.id, u.id)).returning();
    reply.status(200).send(toUserDto(updated[0]!));
  });

  // ── DELETE /users/me ───────────────────────────────────────────────────────
  // Mark account deleted + revoke ALL sessions, then enqueue the M9 purge-account
  // job (worker-async). The worker hard-deletes ALL the user's content (montages +
  // S3, raw media, their reactions/comments on others' recaps) + writes a tombstone;
  // the sweeps reclaim if the job drops. Returns fast.
  app.delete("/users/me", { preHandler: requireSession }, async (req: FastifyRequest, reply: FastifyReply) => {
    const u = req.user!;
    await db.db
      .update(userTable)
      .set({ accountStatus: "deleted", updatedAt: new Date() })
      .where(eq(userTable.id, u.id));
    await db.db.delete(sessionTable).where(eq(sessionTable.userId, u.id));
    await enqueuePurgeAccount(deps.cleanupQueues, u.id);
    reply.status(200).send({ status: "deleted" });
  });

  // ── Example guarded routes (used by tests; harmless in prod) ────────────────
  // A requireSession-guarded endpoint returning the caller's profile.
  app.get("/users/me", { preHandler: requireSession }, async (req: FastifyRequest, reply: FastifyReply) => {
    const u = req.user!;
    const rows = await db.db.select().from(userTable).where(eq(userTable.id, u.id)).limit(1);
    reply.status(200).send(toUserDto(rows[0]!));
  });

  // A requireAdmin-guarded endpoint that writes an audit_log row.
  app.get(
    "/admin/ping",
    { preHandler: [requireSession, requireAdminFactory("admin.ping")] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      reply.status(200).send({ status: "admin_ok" });
    },
  );
}
