import { remotePeerFlag, visiblePeerSessions } from './peer-visibility.js'

/** Decorate the native browser slot, not the shared sessions service or history routes. */
export function registerPeerVisibility(ctx, require, nativeEntry) {
  const { createElement: h } = require('react')
  function VisibleWorkspace({ Native, useSessions, ...props }) {
    const useVisibleSessions = selector => useSessions(list => selector(visiblePeerSessions(list)))
    return h(Native, { ...props, useSessions: useVisibleSessions })
  }
  ctx.slots.inject('sidebar.workspaces', () => {
    let original, dispose, syncing = false
    const sync = () => {
      if (syncing) return
      const next = ctx.slots.entriesOfSlot('sidebar.workspaces').find(entry => entry.options.id !== 'dsh-a2a-peer-visibility')
      if (next === original) return
      syncing = true
      try {
        dispose?.(); dispose = undefined; original = next
        if (original) dispose = nativeEntry('sidebar.workspaces', original,
          { id: 'dsh-a2a-peer-visibility', priority: -10 },
          (Native, props) => h(VisibleWorkspace, { Native, ...props }))
      } finally { syncing = false }
    }
    const off = ctx.on('slots/changed', name => { if (name === 'sidebar.workspaces') sync() })
    sync()
    return () => { off(); dispose?.() }
  })
  // Old cold cache entries do not yet contain our new projection. Read only
  // missing metadata, at most two at a time; never retain/activate their Agents.
  ctx.effect(() => {
    let stopped = false, active = 0
    const seen = new Set()
    const pump = () => {
      if (stopped) return
      const list = ctx.sessions.list.getSnapshot()
      for (const id of list.ids) {
        if (active >= 2) break
        if (seen.has(id) || remotePeerFlag(list, id) !== undefined) continue
        seen.add(id); active++
        void Promise.resolve().then(() => ctx.sessions.refreshProjections(id)).catch(() => {}).finally(() => { active--; pump() })
      }
    }
    const off = ctx.sessions.list.subscribe(pump)
    const reset = ctx.on('connection/reset', () => { seen.clear(); pump() })
    pump()
    return () => { stopped = true; off(); reset() }
  })
}
