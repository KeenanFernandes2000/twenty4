// inviteErrors — central, typed mapping from an invite/group `ApiError.code` to
// friendly user-facing copy. We ALWAYS branch on `err.code` (the typed ErrorCode
// union), never on `err.message`. Unknown errors fall through to a generic line.
//
// Used by the join flow (join.tsx + the deep-link invite route via the shared
// <InvitePreviewJoin/> component) so preview/join error copy stays consistent.
import { ApiError } from '@twenty4/api-client';
import type { ErrorCode } from '@twenty4/contracts';

/** Friendly copy for the invite PREVIEW step (getInvitePreview). */
export function invitePreviewErrorCopy(err: unknown): string {
  if (err instanceof ApiError) {
    const code = err.code as ErrorCode;
    switch (code) {
      case 'INVITE_NOT_FOUND':
      case 'GROUP_NOT_FOUND':
      case 'NOT_FOUND':
        return 'Invite not found. Check the code and try again.';
      case 'INVITE_REVOKED':
      case 'INVITE_USED_UP':
        return 'This invite is no longer valid.';
      case 'INVITE_EXPIRED':
        return 'This invite has expired.';
      case 'ACCOUNT_SUSPENDED':
      case 'ACCOUNT_BANNED':
      case 'ACCOUNT_DELETED':
        return 'Your account is restricted.';
      default:
        return 'Something went wrong. Please try again.';
    }
  }
  return 'Something went wrong. Please try again.';
}

/**
 * Friendly copy for the JOIN step (joinInvite). NOTE: ALREADY_MEMBER is treated by
 * the caller as success (navigate to the group), so it is intentionally not given
 * an "error" message here — callers check for it explicitly.
 */
export function joinErrorCopy(err: unknown): string {
  if (err instanceof ApiError) {
    const code = err.code as ErrorCode;
    switch (code) {
      case 'INVITE_NOT_FOUND':
      case 'GROUP_NOT_FOUND':
      case 'NOT_FOUND':
        return 'Invite not found. Check the code and try again.';
      case 'INVITE_REVOKED':
      case 'INVITE_USED_UP':
        return 'This invite is no longer valid.';
      case 'INVITE_EXPIRED':
        return 'This invite has expired.';
      case 'ACCOUNT_SUSPENDED':
      case 'ACCOUNT_BANNED':
      case 'ACCOUNT_DELETED':
        return 'Your account is restricted.';
      default:
        return 'Could not join. Please try again.';
    }
  }
  return 'Could not join. Please try again.';
}

/** True when the error means "you're already in this group" → treat as success. */
export function isAlreadyMember(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'ALREADY_MEMBER';
}
