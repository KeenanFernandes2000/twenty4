/**
 * Groups DTOs (§8 Groups): create/list/get/patch group, invites, join, members.
 */
import { z } from 'zod';
import { groupMemberRoleSchema, groupStatusSchema } from '../enums.js';
import { userSummarySchema } from './_common.js';

/** POST /groups. */
export const createGroupRequestSchema = z
  .object({
    name: z.string().min(1).max(60),
    photoUrl: z.string().url().optional(),
  })
  .strict();
export type CreateGroupRequest = z.infer<typeof createGroupRequestSchema>;

/** PATCH /groups/{id}. */
export const updateGroupRequestSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    photoUrl: z.string().url().nullable().optional(),
    status: groupStatusSchema.optional(),
  })
  .strict();
export type UpdateGroupRequest = z.infer<typeof updateGroupRequestSchema>;

/** A group as returned to a member (GET /groups, GET /groups/{id}). */
export const groupResponseSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    photoUrl: z.string().url().nullable().optional(),
    ownerId: z.string().uuid(),
    status: groupStatusSchema,
    memberCount: z.number().int().min(0),
    /** Caller's role in this group. */
    myRole: groupMemberRoleSchema,
    createdAt: z.string(),
  })
  .strict();
export type GroupResponse = z.infer<typeof groupResponseSchema>;

/** GET /groups → mine. */
export const groupListResponseSchema = z
  .object({ items: z.array(groupResponseSchema) })
  .strict();
export type GroupListResponse = z.infer<typeof groupListResponseSchema>;

/** A member row (GET /groups/{id} members / member management 4.6). */
export const groupMemberResponseSchema = z
  .object({
    user: userSummarySchema,
    role: groupMemberRoleSchema,
    joinedAt: z.string(),
  })
  .strict();
export type GroupMemberResponse = z.infer<typeof groupMemberResponseSchema>;

/** POST /groups/{id}/invites. */
export const createInviteRequestSchema = z
  .object({
    /** Optional override of default expiry/use-cap (Q11). */
    maxUses: z.number().int().min(1).max(500).optional(),
    expiresInHours: z.number().int().min(1).max(720).optional(),
  })
  .strict();
export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>;

export const inviteResponseSchema = z
  .object({
    code: z.string(),
    groupId: z.string().uuid(),
    expiresAt: z.string(),
    maxUses: z.number().int(),
    useCount: z.number().int(),
    /** Deep link `twenty4://invite/{code}`. */
    deepLink: z.string(),
  })
  .strict();
export type InviteResponse = z.infer<typeof inviteResponseSchema>;

/** GET /invites/{code} — public-ish preview (group name/photo + validity). */
export const invitePreviewResponseSchema = z
  .object({
    groupName: z.string(),
    groupPhotoUrl: z.string().url().nullable().optional(),
    memberCount: z.number().int().min(0),
    valid: z.boolean(),
  })
  .strict();
export type InvitePreviewResponse = z.infer<typeof invitePreviewResponseSchema>;

/** POST /invites/{code}/join → returns the joined group. */
export const joinGroupResponseSchema = groupResponseSchema;
export type JoinGroupResponse = z.infer<typeof joinGroupResponseSchema>;
