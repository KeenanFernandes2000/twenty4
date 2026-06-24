// Group & invite DTOs (Zod) — request/response contracts for the M3 group routes.
// Single source of truth; the API imports these, never re-declares them.
import { z } from "zod";

export const groupRoleSchema = z.enum(["owner", "admin", "member"]);
export type GroupRole = z.infer<typeof groupRoleSchema>;

export const groupStatusSchema = z.enum(["active", "archived"]);
export type GroupStatus = z.infer<typeof groupStatusSchema>;

// POST /groups — create a group.
export const createGroupReqSchema = z.object({
  name: z.string().trim().min(1).max(80),
  photoUrl: z.string().url().optional(),
});
export type CreateGroupReq = z.infer<typeof createGroupReqSchema>;

// PATCH /groups/{id} — rename and/or set the group photo. At least one field.
// `photoUrl: null` clears the photo; omitted leaves it unchanged.
export const patchGroupReqSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    photoUrl: z.string().url().nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.photoUrl !== undefined, {
    message: "at least one field is required",
  });
export type PatchGroupReq = z.infer<typeof patchGroupReqSchema>;

// Group wire shape (list + detail). `role` is the caller's role; `memberCount` is
// the live count of active members.
export const groupDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  photoUrl: z.string().nullable(),
  ownerId: z.string().uuid(),
  status: groupStatusSchema,
  role: groupRoleSchema,
  memberCount: z.number().int(),
  createdAt: z.string(),
});
export type GroupDTO = z.infer<typeof groupDtoSchema>;

// POST /groups/{id}/invites response. `code` is the shareable URL-safe code.
export const inviteDtoSchema = z.object({
  id: z.string().uuid(),
  groupId: z.string().uuid(),
  code: z.string(),
  expiresAt: z.string(),
  maxUses: z.number().int(),
  useCount: z.number().int(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type InviteDTO = z.infer<typeof inviteDtoSchema>;

// GET /invites/{code} preview — group summary, NEVER joins, no use consumed.
export const invitePreviewDtoSchema = z.object({
  groupId: z.string().uuid(),
  name: z.string(),
  photoUrl: z.string().nullable(),
  memberCount: z.number().int(),
  alreadyMember: z.boolean(),
});
export type InvitePreviewDTO = z.infer<typeof invitePreviewDtoSchema>;

// POST /invites/{code}/join response.
export const joinResultDtoSchema = z.object({
  groupId: z.string().uuid(),
  role: groupRoleSchema,
  status: z.enum(["active", "left", "removed"]),
});
export type JoinResultDTO = z.infer<typeof joinResultDtoSchema>;

// Member wire shape for GET /groups/{id}/members.
export const memberDtoSchema = z.object({
  userId: z.string().uuid(),
  role: groupRoleSchema,
  displayName: z.string().nullable(),
  username: z.string().nullable(),
  profilePhotoUrl: z.string().nullable(),
  joinedAt: z.string(),
});
export type MemberDTO = z.infer<typeof memberDtoSchema>;
