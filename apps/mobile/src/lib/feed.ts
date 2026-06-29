// feed — the M8 feed + social query layer (read + react/comment side).
//
// The state the feed screens consume:
//   • useFeed(group?)        — GET /feed, keyset-paginated via useInfiniteQuery
//                              (pages walk `nextCursor`). One infinite cache per
//                              group filter (keyed on `group ?? null`).
//   • useComments(montageId) — GET /montages/:id/comments, keyset-paginated.
//   • useFeedCard(montageId) — a reactive read of ONE card straight out of the feed
//                              cache (the player/comments screens are opened from a
//                              card, so the card already lives in cache).
//   • useReact()             — set / replace / clear the caller's reaction with an
//                              optimistic count + viewerReaction patch (rollback on
//                              error, reconcile from the server summary on success).
//   • useAddComment()        — optimistic add (temp id → reconciled), bumps the
//                              card's commentCount + 2-latest preview.
//   • useDeleteComment()     — soft-delete own comment, drops it from cache + count.
//
// Imports are top-level (api/queryKeys — neither imports this module → no cycle).
// No screen is imported here. Mirrors @/lib/media + @/lib/montage idioms.
import { useSyncExternalStore } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  AddCommentRes,
  CommentDTO,
  CommentsPage,
  FeedCard,
  FeedPage,
  ReactionSummary,
  ReactionType,
} from '@twenty4/contracts';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

type FeedInfinite = InfiniteData<FeedPage>;
type CommentsInfinite = InfiniteData<CommentsPage>;

// ── Queries ────────────────────────────────────────────────────────────────

/**
 * GET /feed — the block-filtered, keyset-paginated feed. `useInfiniteQuery` walks
 * `nextCursor`; `initialPageParam: undefined` requests the first page (no cursor),
 * and `getNextPageParam` stops once the server returns a null cursor (final page).
 */
export function useFeed(group?: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.feed.list(group),
    queryFn: ({ pageParam }) => api.getFeed({ group, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: FeedPage) => last.nextCursor ?? undefined,
  });
}

/**
 * GET /montages/:id/comments — keyset-paginated (created_at ASC). Enabled only on a
 * truthy id so the comments screen can mount before the param resolves.
 */
export function useComments(montageId: string | undefined) {
  return useInfiniteQuery({
    queryKey: queryKeys.feed.comments(montageId ?? ''),
    queryFn: ({ pageParam }) => api.getComments(montageId as string, pageParam),
    enabled: !!montageId,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: CommentsPage) => last.nextCursor ?? undefined,
  });
}

// ── Cache helpers (operate across every group variant of the feed) ───────────

/** Find a card in any cached feed page (the player/comments screens read it here). */
function findFeedCard(qc: QueryClient, montageId: string): FeedCard | undefined {
  const entries = qc.getQueriesData<FeedInfinite>({ queryKey: ['feed', 'list'] });
  for (const [, data] of entries) {
    if (!data) continue;
    for (const page of data.pages) {
      const found = page.items.find((it) => it.montageId === montageId);
      if (found) return found;
    }
  }
  return undefined;
}

/** Patch one card everywhere it appears (across all group feeds it's cached in). */
function patchFeedCard(qc: QueryClient, montageId: string, update: (c: FeedCard) => FeedCard): void {
  const entries = qc.getQueriesData<FeedInfinite>({ queryKey: ['feed', 'list'] });
  for (const [key, data] of entries) {
    if (!data) continue;
    let changed = false;
    const pages = data.pages.map((page) => {
      if (!page.items.some((it) => it.montageId === montageId)) return page;
      changed = true;
      return {
        ...page,
        items: page.items.map((it) => (it.montageId === montageId ? update(it) : it)),
      };
    });
    if (changed) qc.setQueryData<FeedInfinite>(key, { ...data, pages });
  }
}

/** Remove one card from every cached feed page (across all group variants). */
function removeFeedCard(qc: QueryClient, montageId: string): void {
  const entries = qc.getQueriesData<FeedInfinite>({ queryKey: ['feed', 'list'] });
  for (const [key, data] of entries) {
    if (!data) continue;
    let changed = false;
    const pages = data.pages.map((page) => {
      if (!page.items.some((it) => it.montageId === montageId)) return page;
      changed = true;
      return { ...page, items: page.items.filter((it) => it.montageId !== montageId) };
    });
    if (changed) qc.setQueryData<FeedInfinite>(key, { ...data, pages });
  }
}

/** Mutate the comments infinite cache for one montage (all pages). */
function patchComments(
  qc: QueryClient,
  montageId: string,
  update: (items: CommentDTO[], pageIndex: number, pageCount: number) => CommentDTO[],
): void {
  const key = queryKeys.feed.comments(montageId);
  const data = qc.getQueryData<CommentsInfinite>(key);
  if (!data) return;
  const pages = data.pages.map((page, i) => ({
    ...page,
    items: update(page.items, i, data.pages.length),
  }));
  qc.setQueryData<CommentsInfinite>(key, { ...data, pages });
}

// ── Reactive single-card read (useSyncExternalStore over the query cache) ────

/**
 * Subscribe to ONE card straight out of the feed cache. The player + comments
 * screens are always reached from a card, so the card is already cached; this keeps
 * them in lockstep with optimistic react/comment patches without a refetch.
 * `getSnapshot` returns the cached card object (stable identity until it's patched),
 * so it never loops.
 */
export function useFeedCard(montageId: string): FeedCard | undefined {
  const qc = useQueryClient();
  return useSyncExternalStore(
    (onStoreChange) => qc.getQueryCache().subscribe(() => onStoreChange()),
    () => findFeedCard(qc, montageId),
  );
}

// ── Reactions (set / replace / clear, optimistic) ────────────────────────────

interface ReactVars {
  montageId: string;
  type: ReactionType;
  /** The viewer's current reaction (so tapping the active one clears it). */
  current: ReactionType | null;
}
interface ReactCtx {
  prev: { reactionCount: number; viewerReaction: ReactionType | null } | null;
}

/**
 * One mutation for the whole reaction interaction: tapping the currently-active
 * reaction clears it (DELETE), any other tap sets/replaces it (POST). The count is
 * patched optimistically (+1 from none, 0 on a replace, −1 on a clear), rolled back
 * on error, then reconciled from the server's authoritative summary.
 */
export function useReact() {
  const qc = useQueryClient();
  return useMutation<ReactionSummary, unknown, ReactVars, ReactCtx>({
    mutationFn: ({ montageId, type, current }) =>
      current === type ? api.clearReaction(montageId) : api.setReaction(montageId, type),
    onMutate: async ({ montageId, type, current }) => {
      await qc.cancelQueries({ queryKey: ['feed', 'list'] });
      const card = findFeedCard(qc, montageId);
      const prev = card ? { reactionCount: card.reactionCount, viewerReaction: card.viewerReaction } : null;
      const clearing = current === type;
      const nextReaction: ReactionType | null = clearing ? null : type;
      const delta = clearing ? -1 : current === null ? 1 : 0;
      patchFeedCard(qc, montageId, (c) => ({
        ...c,
        viewerReaction: nextReaction,
        reactionCount: Math.max(0, c.reactionCount + delta),
      }));
      return { prev };
    },
    onError: (_err, { montageId }, ctx) => {
      if (ctx?.prev) patchFeedCard(qc, montageId, (c) => ({ ...c, ...ctx.prev! }));
    },
    onSuccess: (summary, { montageId }) => {
      patchFeedCard(qc, montageId, (c) => ({
        ...c,
        reactionCount: summary.count,
        viewerReaction: summary.viewerReaction,
      }));
    },
  });
}

// ── Comments (optimistic add + delete-own) ───────────────────────────────────

interface AddCommentVars {
  montageId: string;
  text: string;
  /** Identity for the optimistic temp comment (reconciled on success). */
  author: CommentDTO['author'];
}
interface AddCommentCtx {
  tempId: string;
}

// Keep the card's 2-latest preview in sync (M8 §11 locked at 2). Comments are ASC,
// so the latest live at the tail — preview = the last two.
function previewTail(items: CommentDTO[]): CommentDTO[] {
  return items.slice(-2);
}

/**
 * Optimistically appends the new comment (temp id) to the comments list + the card
 * preview/count, then reconciles with the server's real comment + count on success
 * (or removes the temp on error so the composer can resurface a retry).
 */
export function useAddComment() {
  const qc = useQueryClient();
  return useMutation<AddCommentRes, unknown, AddCommentVars, AddCommentCtx>({
    mutationFn: ({ montageId, text }) => api.addComment(montageId, text),
    onMutate: async ({ montageId, text, author }) => {
      const tempId = `temp-${Date.now()}`;
      const optimistic: CommentDTO = {
        id: tempId,
        montageId,
        author,
        text: text.trim(),
        createdAt: new Date().toISOString(),
        canDelete: true,
      };
      // Append to the LAST page (ASC keyset → newest at the tail).
      patchComments(qc, montageId, (items, i, count) =>
        i === count - 1 ? [...items, optimistic] : items,
      );
      patchFeedCard(qc, montageId, (c) => ({
        ...c,
        commentCount: c.commentCount + 1,
        commentPreview: previewTail([...c.commentPreview, optimistic]),
      }));
      return { tempId };
    },
    onError: (_err, { montageId }, ctx) => {
      if (!ctx) return;
      patchComments(qc, montageId, (items) => items.filter((it) => it.id !== ctx.tempId));
      patchFeedCard(qc, montageId, (c) => ({
        ...c,
        commentCount: Math.max(0, c.commentCount - 1),
        commentPreview: c.commentPreview.filter((p) => p.id !== ctx.tempId),
      }));
    },
    onSuccess: (res, { montageId }, ctx) => {
      // Swap the temp comment for the server row + reconcile the count.
      patchComments(qc, montageId, (items) =>
        items.map((it) => (it.id === ctx?.tempId ? res.comment : it)),
      );
      patchFeedCard(qc, montageId, (c) => ({
        ...c,
        commentCount: res.commentCount,
        commentPreview: previewTail(
          c.commentPreview.map((p) => (p.id === ctx?.tempId ? res.comment : p)),
        ),
      }));
    },
  });
}

interface DeleteCommentVars {
  commentId: string;
  montageId: string;
}

// ── Delete own montage (M9 manual hard-delete) ───────────────────────────────

/**
 * DELETE /montages/:id — the owner manually hard-deletes their own recap NOW (the
 * worker purges video/thumb/reactions/comments; the sweep is the backstop). On
 * success we drop the card from every cached feed page so it vanishes immediately.
 * The destructive-confirm copy lives at the call site (the FeedCard owner affordance).
 */
export function useDeleteMontage() {
  const qc = useQueryClient();
  return useMutation<{ status: string }, unknown, { montageId: string }>({
    mutationFn: ({ montageId }) => api.deleteMontage(montageId),
    onSuccess: (_res, { montageId }) => {
      removeFeedCard(qc, montageId);
    },
  });
}

/** Soft-delete the caller's own comment; drop it from the list + card count/preview. */
export function useDeleteComment() {
  const qc = useQueryClient();
  return useMutation<{ commentCount: number }, unknown, DeleteCommentVars>({
    mutationFn: ({ commentId }) => api.deleteComment(commentId),
    onSuccess: (res, { montageId, commentId }) => {
      patchComments(qc, montageId, (items) => items.filter((it) => it.id !== commentId));
      patchFeedCard(qc, montageId, (c) => ({
        ...c,
        commentCount: res.commentCount,
        commentPreview: c.commentPreview.filter((p) => p.id !== commentId),
      }));
    },
  });
}
