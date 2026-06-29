// Auth & user DTOs (Zod) — the request/response contracts the /auth façade and
// /users endpoints validate against. Single source of truth; the API imports
// these, never re-declares them.
import { z } from "zod";

// The two OTP channels.
export const channelSchema = z.enum(["phone", "email"]);
export type Channel = z.infer<typeof channelSchema>;

// Canonicalize an identifier so the SAME logical account keys ONE rate-limit /
// verify counter / dev-OTP store entry / Better Auth call — regardless of caller
// casing or punctuation. Deterministic + idempotent.
//   - email → trim + lowercase.
//   - phone → trim, then strip everything except digits and a SINGLE leading "+".
//     A leading "+" (if present) is preserved; all other "+"/spaces/dashes/parens
//     are removed. We do NOT guess or inject a country code.
export function normalizeIdentifier(identifier: string, channel: Channel): string {
  if (channel === "email") return identifier.trim().toLowerCase();
  // phone
  const trimmed = identifier.trim();
  const hasLeadingPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  return hasLeadingPlus ? `+${digits}` : digits;
}

// E.164-ish phone (loose): leading +, 7–15 digits. Kept permissive for dev.
const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[1-9]\d{6,14}$/, "must be a valid phone number");

const emailSchema = z.string().trim().email().toLowerCase();

// POST /auth/start — request an OTP for an identifier on a channel.
// The `.transform` canonicalizes `identifier` (after validation) so the SAME
// logical account keys ONE rate-limit counter / dev-OTP store / BA call.
export const authStartReqSchema = z
  .object({
    identifier: z.string().trim().min(1),
    channel: channelSchema,
  })
  .superRefine((val, ctx) => {
    if (val.channel === "email" && !emailSchema.safeParse(val.identifier).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["identifier"], message: "invalid email" });
    }
    if (val.channel === "phone" && !phoneSchema.safeParse(val.identifier).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["identifier"], message: "invalid phone number" });
    }
  })
  .transform((val) => ({ ...val, identifier: normalizeIdentifier(val.identifier, val.channel) }));
export type AuthStartReq = z.infer<typeof authStartReqSchema>;

// POST /auth/verify — verify an OTP and mint a session. Same identifier
// canonicalization so the verify-attempt counter / BA call key the start key.
export const authVerifyReqSchema = z
  .object({
    identifier: z.string().trim().min(1),
    channel: channelSchema,
    code: z.string().trim().min(4).max(12),
  })
  .transform((val) => ({ ...val, identifier: normalizeIdentifier(val.identifier, val.channel) }));
export type AuthVerifyReq = z.infer<typeof authVerifyReqSchema>;

// POST /auth/refresh — optional explicit token (else taken from the bearer/session).
export const authRefreshReqSchema = z.object({
  token: z.string().trim().min(1).optional(),
});
export type AuthRefreshReq = z.infer<typeof authRefreshReqSchema>;

// Session wire shape returned by verify/refresh.
export const sessionDtoSchema = z.object({
  token: z.string(),
  userId: z.string().uuid(),
  expiresAt: z.string(), // ISO timestamp
});
export type SessionDTO = z.infer<typeof sessionDtoSchema>;

// User wire shape (never leaks secrets).
export const userDtoSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().nullable(),
  username: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  profilePhotoUrl: z.string().nullable(),
  authProvider: z.enum(["phone", "email", "apple", "google"]),
  accountStatus: z.enum(["active", "suspended", "banned", "deleted"]),
  isAdmin: z.boolean(),
  createdAt: z.string(),
});
export type UserDTO = z.infer<typeof userDtoSchema>;

// POST /users — create/complete a profile post-verify. email-or-phone presence is
// enforced at the app layer (cannot be a PG CHECK; see schema notes).
export const createUserReqSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  username: z
    .string()
    .trim()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_.]+$/, "username may only contain letters, digits, _ and .")
    .optional(),
  profilePhotoUrl: z.string().url().optional(),
});
export type CreateUserReq = z.infer<typeof createUserReqSchema>;

// PATCH /users/me — update display_name / username / photo.
export const updateMeReqSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    username: z
      .string()
      .trim()
      .min(3)
      .max(30)
      .regex(/^[a-zA-Z0-9_.]+$/, "username may only contain letters, digits, _ and .")
      .optional(),
    profilePhotoUrl: z.string().url().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });
export type UpdateMeReq = z.infer<typeof updateMeReqSchema>;

// DELETE /users/me — triggers the M9 purge-account job (worker-async). Returns
// fast; matches the current DELETE /users/me return shape.
export const deleteAccountResSchema = z.object({
  status: z.literal("deleted"),
});
export type DeleteAccountRes = z.infer<typeof deleteAccountResSchema>;
