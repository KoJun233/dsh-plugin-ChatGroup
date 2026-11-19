/** Shared, presentation-only Session-list facts. Never change the underlying catalog. */
export const remotePeerProjectionKey = 'dshA2aRemotePeer'

interface SidebarRow { title?: string; projectionValues?: Readonly<Record<string, unknown>> }
export interface SidebarSessions {
  ids: string[]
  byId: Record<string, SidebarRow>
  projectionsBySession?: Readonly<Record<string, { values: Readonly<Record<string, unknown>> }>>
}

export function remotePeerFlag(list: SidebarSessions, id: string): boolean | undefined {
  const value = list.projectionsBySession?.[id]?.values[remotePeerProjectionKey]
    ?? list.byId[id]?.projectionValues?.[remotePeerProjectionKey]
  return typeof value === 'boolean' ? value : undefined
}

/** Stable derived snapshots for React; only the workspace browser receives them. */
const visibleSnapshots = new WeakMap<SidebarSessions, SidebarSessions>()
export function visiblePeerSessions<T extends SidebarSessions>(list: T): T {
  const cached = visibleSnapshots.get(list)
  if (cached) return cached as T
  const hidden = new Set(Object.keys(list.byId).filter(id => remotePeerFlag(list, id) === true))
  const result = hidden.size ? { ...list,
    ids: list.ids.filter(id => !hidden.has(id)),
    byId: Object.fromEntries(Object.entries(list.byId).filter(([id]) => !hidden.has(id))),
  } : list
  visibleSnapshots.set(list, result)
  return result
}
