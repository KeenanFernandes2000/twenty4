// queryKeys — the single source of truth for react-query cache keys.
//
// Every useQuery/useMutation/invalidate in the app references these factories so
// keys stay consistent and refactor-safe. `as const` makes each key a readonly
// tuple literal — typos and key drift become compile errors. Screen agents:
// import { queryKeys } from '@/lib/queryKeys' and use e.g.
//   useQuery({ queryKey: queryKeys.groups.list, queryFn: () => api.listGroups() })
//   useQuery({ queryKey: queryKeys.groups.detail(id), queryFn: () => api.getGroup(id) })
// Invalidate with queryClient.invalidateQueries({ queryKey: queryKeys.groups.list }).

export const queryKeys = {
  auth: {
    me: ['auth', 'me'] as const,
  },
  groups: {
    list: ['groups', 'list'] as const,
    detail: (id: string) => ['groups', 'detail', id] as const,
    members: (id: string) => ['groups', 'members', id] as const,
  },
  invites: {
    preview: (code: string) => ['invites', 'preview', code] as const,
  },
  media: {
    today: ['media', 'today'] as const,
    item: (id: string) => ['media', 'item', id] as const,
  },
  montage: {
    detail: (id: string) => ['montage', id] as const,
    options: ['montage', 'options'] as const,
  },
  feed: {
    // The block-filtered feed (M8). The optional group scopes to one group; we key
    // on `group ?? null` so the "All" feed and each per-group feed are distinct
    // infinite caches. The shared `['feed','list']` prefix lets the social
    // mutations patch every group variant a card appears in at once.
    list: (group?: string) => ['feed', 'list', group ?? null] as const,
    comments: (montageId: string) => ['feed', 'comments', montageId] as const,
  },
} as const;
