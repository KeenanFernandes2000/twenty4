/**
 * Users DTOs (§8): POST /users · PATCH /users/me · DELETE /users/me ·
 * POST /users/me/contacts-discovery · GET/PATCH /users/me/notification-prefs.
 */
import { z } from 'zod';
import { userSummarySchema } from './_common.js';

/** A username: handle-safe, case-insensitive (stored citext). */
export const usernameSchema = z
  .string()
  .min(3)
  .max(24)
  .regex(/^[a-zA-Z0-9_]+$/, 'letters, numbers, underscore only');

/** POST /users — create profile after auth. */
export const createUserRequestSchema = z
  .object({
    displayName: z.string().min(1).max(60),
    username: usernameSchema,
    profilePhotoUrl: z.string().url().optional(),
  })
  .strict();
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

/** PATCH /users/me — partial profile update. */
export const updateUserRequestSchema = z
  .object({
    displayName: z.string().min(1).max(60).optional(),
    username: usernameSchema.optional(),
    profilePhotoUrl: z.string().url().nullable().optional(),
  })
  .strict();
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

/** The full "me" profile (self view). */
export const meResponseSchema = z
  .object({
    id: z.string().uuid(),
    displayName: z.string(),
    username: z.string(),
    profilePhotoUrl: z.string().url().nullable().optional(),
    email: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    accountStatus: z.enum(['active', 'suspended', 'banned', 'deleted']),
    createdAt: z.string(),
  })
  .strict();
export type MeResponse = z.infer<typeof meResponseSchema>;

/** Public profile of another user. */
export const publicUserResponseSchema = userSummarySchema;
export type PublicUserResponse = z.infer<typeof publicUserResponseSchema>;

/**
 * POST /users/me/contacts-discovery (opt-in). Hashes of contacts to match
 * existing users. // TODO(spec-gap): hashing scheme is a privacy decision; we
 * accept opaque hashes only (never raw phone numbers) to honor §11/§12 no-PII.
 */
export const contactsDiscoveryRequestSchema = z
  .object({
    /** Pre-hashed contact identifiers (client-side hash). */
    contactHashes: z.array(z.string()).max(5000),
  })
  .strict();
export type ContactsDiscoveryRequest = z.infer<typeof contactsDiscoveryRequestSchema>;

export const contactsDiscoveryResponseSchema = z
  .object({ matches: z.array(userSummarySchema) })
  .strict();
export type ContactsDiscoveryResponse = z.infer<typeof contactsDiscoveryResponseSchema>;

/** GET/PATCH /users/me/notification-prefs (jsonb-backed). */
export const notificationPrefsSchema = z
  .object({
    friendPosted: z.boolean().default(true),
    friendReacted: z.boolean().default(true),
    friendCommented: z.boolean().default(true),
    montageExpiring: z.boolean().default(true),
    inviteReceived: z.boolean().default(true),
    captureReminder: z.boolean().default(true),
    /** Per-group mutes (group ids). */
    mutedGroupIds: z.array(z.string().uuid()).default([]),
    /** Local capture-reminder time, "HH:mm" 24h. */
    reminderTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
  })
  .strict();
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;
