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
} as const;
