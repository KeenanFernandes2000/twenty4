/**
 * Feed + social data layer (Slice 6) — React Query over the api-client `feed`
 * and `social` methods. This is the wiring behind the 3.1 feed, 3.2 player, and
 * 3.3 comments screens:
 *
 *   - useFeed()              GET /feed — INFINITE, 10/page (§10), cursor-paged,
 *     member-group-scoped + block-filtered server-side. Pull-to-refresh resets
 *     to page 0; `fetchNextPage` appends on scroll-end.
 *   - useFeedCard(id)        reads a single card out of the paged feed cache (the
 *     3.2 player + 3.3 comments header hydrate instantly from the feed, no extra
 *     fetch) with an optional networked fallback.
 *   - useReact(id) / useUnreact(id)   POST/DELETE /montages/:id/reactions —
 *     OPTIMISTIC: flip the card's reaction summary in the feed cache immediately
 *     (one reaction per user; changing type replaces), ROLL BACK on error, then
 *     reconcile with the server's authoritative summary on success.
 *   - useComments(id)        GET /montages/:id/comments — INFINITE (cursor,
 *     oldest-first).
 *   - useAddComment(id)      POST /montages/:id/comments — OPTIMISTIC append +
 *     bump the card's commentCount; reconciled / rolled back.
 *   - useDeleteComment(id)   DELETE /comments/:commentId — OPTIMISTIC remove +
 *     decrement count.
 *
 * Web-safe: pure React Query + the api-client; no native-only imports. The feed
 * screens also accept mock data (lib/feedMocks) for web-export screenshots.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { ApiError } from '@twenty4/api-client';
import type {
  FeedCard,
  FeedResponse,
  ReactionSummary,
  CommentResponse,
  CommentsResponse,
} from '@twenty4/contracts/dto';
import type { ReactionType } from '@twenty4/contracts/enums';

import { apiClient } from './apiClient';
import { useMe } from './groups';

/* ------------------------------- error helpers ----------------------------- */

export function feedErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

export function feedErrorStatus(error: unknown): number | undefined {
  return error instanceof ApiError ? error.status : undefined;
}

/* -------------------------------- query keys ------------------------------- */

export const feedKeys = {
  all: ['feed'] as const,
  list: (group?: string) => [...feedKeys.all, 'list', group ?? 'all'] as const,
  comments: (montageId: string) => [...feedKeys.all, 'comments', montageId] as const,
};

const PAGE_SIZE = 10;

/* --------------------------------- feed ------------------------------------ */

/**
 * GET /feed — infinite, 10/page (§10). `group` optionally narrows to one member
 * group. Each page carries `nextCursor`; an absent/null cursor ends the list.
 */
export function useFeed(options?: { group?: string; enabled?: boolean }) {
  return useInfiniteQuery<FeedResponse>({
    queryKey: feedKeys.list(options?.group),
    queryFn: ({ pageParam }) =>
      apiClient.feed.list({
        group: options?.group,
        cursor: (pageParam as string | undefined) ?? undefined,
        limit: PAGE_SIZE,
      }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: options?.enabled ?? true,
  });
}

/** Flatten the paged feed into a single card array. */
export function flattenFeed(data: InfiniteData<FeedResponse> | undefined): FeedCard[] {
  return data?.pages.flatMap((p) => p.items) ?? [];
}

/**
 * Read a single feed card out of the cache (any group list). The 3.2 player and
 * 3.3 comments header hydrate from this without a dedicated card endpoint.
 */
export function useFeedCard(montageId: string | undefined): FeedCard | undefined {
  const qc = useQueryClient();
  if (!montageId) return undefined;
  const caches = qc.getQueriesData<InfiniteData<FeedResponse>>({ queryKey: feedKeys.all }) as Array<
    [readonly unknown[], InfiniteData<FeedResponse> | undefined]
  >;
  for (const [, data] of caches) {
    const found = data?.pages.flatMap((p) => p.items).find((c) => c.montageId === montageId);
    if (found) return found;
  }
  return undefined;
}

/* ------------------------------- reactions --------------------------------- */

/** Apply a new reaction `type` (or remove with `null`) to a summary, mirroring
 *  the server's one-per-user upsert semantics so the optimistic UI matches. */
function applyReaction(summary: ReactionSummary, next: ReactionType | null): ReactionSummary {
  const counts: Record<string, number> = { ...summary.counts };
  const prev = summary.mine ?? null;
  if (prev) counts[prev] = Math.max(0, (counts[prev] ?? 0) - 1);
  if (next) counts[next] = (counts[next] ?? 0) + 1;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { counts: counts as ReactionSummary['counts'], total, mine: next };
}

/** Mutate every cached feed page in place, replacing the card's reaction summary. */
function patchCardReactions(
  qc: ReturnType<typeof useQueryClient>,
  montageId: string,
  update: (summary: ReactionSummary) => ReactionSummary,
): Array<[readonly unknown[], InfiniteData<FeedResponse> | undefined]> {
  const caches = qc.getQueriesData<InfiniteData<FeedResponse>>({ queryKey: feedKeys.all });
  for (const [key, data] of caches) {
    if (!data) continue;
    qc.setQueryData<InfiniteData<FeedResponse>>(key, {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: page.items.map((card) =>
          card.montageId === montageId ? { ...card, reactions: update(card.reactions) } : card,
        ),
      })),
    });
  }
  return caches;
}

/** POST /montages/:id/reactions — optimistic upsert + rollback + reconcile. */
export function useReact(montageId: string) {
  const qc = useQueryClient();
  return useMutation<
    Awaited<ReturnType<typeof apiClient.social.react>>,
    unknown,
    ReactionType,
    { prev: Array<[readonly unknown[], InfiniteData<FeedResponse> | undefined]> }
  >({
    mutationFn: (type) => apiClient.social.react(montageId, { type }),
    onMutate: async (type) => {
      await qc.cancelQueries({ queryKey: feedKeys.all });
      const prev = patchCardReactions(qc, montageId, (s) => applyReaction(s, type));
      return { prev };
    },
    onError: (_err, _type, ctx) => {
      ctx?.prev.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSuccess: (res) => {
      patchCardReactions(qc, montageId, () => res.summary);
    },
  });
}

/** DELETE /montages/:id/reactions — optimistic removal + rollback + reconcile. */
export function useUnreact(montageId: string) {
  const qc = useQueryClient();
  return useMutation<
    Awaited<ReturnType<typeof apiClient.social.unreact>>,
    unknown,
    void,
    { prev: Array<[readonly unknown[], InfiniteData<FeedResponse> | undefined]> }
  >({
    mutationFn: () => apiClient.social.unreact(montageId),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: feedKeys.all });
      const prev = patchCardReactions(qc, montageId, (s) => applyReaction(s, null));
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      ctx?.prev.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSuccess: (res) => {
      patchCardReactions(qc, montageId, () => res.summary);
    },
  });
}

/**
 * Toggle helper for the reaction bar: tapping the active reaction removes it,
 * tapping a different one upserts (replaces). Returns the firing function.
 */
export function useToggleReaction(montageId: string) {
  const react = useReact(montageId);
  const unreact = useUnreact(montageId);
  return {
    toggle: (next: ReactionType, current: ReactionType | null) => {
      if (current === next) unreact.mutate();
      else react.mutate(next);
    },
    isPending: react.isPending || unreact.isPending,
  };
}

/* -------------------------------- comments --------------------------------- */

/** GET /montages/:id/comments — infinite, cursor-paged (oldest-first). */
export function useComments(montageId: string | undefined, options?: { enabled?: boolean }) {
  return useInfiniteQuery<CommentsResponse>({
    queryKey: feedKeys.comments(montageId ?? '∅'),
    queryFn: ({ pageParam }) =>
      apiClient.social.listComments(montageId as string, (pageParam as string | undefined) ?? undefined),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: (options?.enabled ?? true) && !!montageId,
  });
}

export function flattenComments(data: InfiniteData<CommentsResponse> | undefined): CommentResponse[] {
  return data?.pages.flatMap((p) => p.items) ?? [];
}

/** Bump a feed card's commentCount by `delta` across every cached page. */
function bumpCommentCount(
  qc: ReturnType<typeof useQueryClient>,
  montageId: string,
  delta: number,
): void {
  const caches = qc.getQueriesData<InfiniteData<FeedResponse>>({ queryKey: feedKeys.all });
  for (const [key, data] of caches) {
    if (!data) continue;
    qc.setQueryData<InfiniteData<FeedResponse>>(key, {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: page.items.map((card) =>
          card.montageId === montageId
            ? { ...card, commentCount: Math.max(0, card.commentCount + delta) }
            : card,
        ),
      })),
    });
  }
}

/**
 * POST /montages/:id/comments — optimistic append. We insert a temporary comment
 * (negative-zero id) at the tail of the LAST page so it shows immediately, bump
 * the card's count, and reconcile with the server row on success.
 */
export function useAddComment(montageId: string) {
  const qc = useQueryClient();
  const me = useMe().data;
  return useMutation<
    CommentResponse,
    unknown,
    string,
    { prev: InfiniteData<CommentsResponse> | undefined; tempId: string }
  >({
    mutationFn: (text) => apiClient.social.addComment(montageId, { text }),
    onMutate: async (text) => {
      await qc.cancelQueries({ queryKey: feedKeys.comments(montageId) });
      const key = feedKeys.comments(montageId);
      const prev = qc.getQueryData<InfiniteData<CommentsResponse>>(key);
      const tempId = `temp-${Date.now()}`;
      const optimistic: CommentResponse = {
        id: tempId,
        montageId,
        author: {
          id: me?.id ?? '00000000-0000-0000-0000-000000000000',
          displayName: me?.displayName ?? 'You',
          username: me?.username ?? 'you',
          profilePhotoUrl: me?.profilePhotoUrl ?? null,
        },
        text,
        createdAt: new Date().toISOString(),
      };
      if (prev && prev.pages.length > 0) {
        const pages = prev.pages.map((p, i) =>
          i === prev.pages.length - 1 ? { ...p, items: [...p.items, optimistic] } : p,
        );
        qc.setQueryData<InfiniteData<CommentsResponse>>(key, { ...prev, pages });
      } else {
        qc.setQueryData<InfiniteData<CommentsResponse>>(key, {
          pageParams: [undefined],
          pages: [{ items: [optimistic], nextCursor: null }],
        });
      }
      bumpCommentCount(qc, montageId, +1);
      return { prev, tempId };
    },
    onError: (_err, _text, ctx) => {
      if (ctx) qc.setQueryData(feedKeys.comments(montageId), ctx.prev);
      bumpCommentCount(qc, montageId, -1);
    },
    onSuccess: (created, _text, ctx) => {
      // Swap the temp row for the server row.
      const key = feedKeys.comments(montageId);
      const data = qc.getQueryData<InfiniteData<CommentsResponse>>(key);
      if (data && ctx) {
        qc.setQueryData<InfiniteData<CommentsResponse>>(key, {
          ...data,
          pages: data.pages.map((p) => ({
            ...p,
            items: p.items.map((cm) => (cm.id === ctx.tempId ? created : cm)),
          })),
        });
      }
    },
  });
}

/** DELETE /comments/:commentId — optimistic removal + count decrement. */
export function useDeleteComment(montageId: string) {
  const qc = useQueryClient();
  return useMutation<
    void,
    unknown,
    string,
    { prev: InfiniteData<CommentsResponse> | undefined }
  >({
    mutationFn: (commentId) => apiClient.social.deleteComment(commentId),
    onMutate: async (commentId) => {
      await qc.cancelQueries({ queryKey: feedKeys.comments(montageId) });
      const key = feedKeys.comments(montageId);
      const prev = qc.getQueryData<InfiniteData<CommentsResponse>>(key);
      if (prev) {
        qc.setQueryData<InfiniteData<CommentsResponse>>(key, {
          ...prev,
          pages: prev.pages.map((p) => ({ ...p, items: p.items.filter((c) => c.id !== commentId) })),
        });
      }
      bumpCommentCount(qc, montageId, -1);
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx) qc.setQueryData(feedKeys.comments(montageId), ctx.prev);
      bumpCommentCount(qc, montageId, +1);
    },
  });
}

/** Owner-only hard-delete of a published montage (cascades reactions+comments). */
export function useDeleteMontage() {
  const qc = useQueryClient();
  return useMutation<void, unknown, string, { prev: Array<[readonly unknown[], InfiniteData<FeedResponse> | undefined]> }>({
    mutationFn: (montageId) => apiClient.montage.remove(montageId),
    onMutate: async (montageId) => {
      await qc.cancelQueries({ queryKey: feedKeys.all });
      const caches = qc.getQueriesData<InfiniteData<FeedResponse>>({ queryKey: feedKeys.all });
      for (const [key, data] of caches) {
        if (!data) continue;
        qc.setQueryData<InfiniteData<FeedResponse>>(key, {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.filter((c) => c.montageId !== montageId),
          })),
        });
      }
      return { prev: caches };
    },
    onError: (_err, _id, ctx) => {
      ctx?.prev.forEach(([key, data]) => qc.setQueryData(key, data));
    },
  });
}
