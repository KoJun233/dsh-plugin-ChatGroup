import { mergeGroupTrajectory } from './group-trajectory.js'

// Keep the shipped ledger, inspector, search, timeline and virtualization.
// Only the inspection source and the assistant's presentation name change.
export function registerGroupTrajectory(ctx, require, nativeEntry, read) {
  const { createElement: h, cloneElement, isValidElement, useCallback, useMemo, useState } = require('react')
  const target = 'dsh-a2a-trajectory-members'
  ctx.uiConversation.events.register({ kind: target, target,
    match: event => { const message = read(event); return message?.kind === 'message' && message.role === 'member' ? { id: message.id, role: message.order === message.revision ? 'start' : 'update' } : null },
    start: (_context, match) => read(match.event),
    update: (context, match) => { const message = read(match.event); return message.revision > context.state.revision ? message : context.state },
    buildViewNode: context => ({ key: context.key, kind: target, id: context.state.id, target, anchorSeq: (context.start ?? context.matches[0]).event.seq,
      data: { anchorSeq: (context.start ?? context.matches[0]).event.seq, message: context.state } }),
  })
  ctx.uiConversation.views.register({ target, isActive: () => true, create() {
    const records = new Map()
    const snapshot = () => [...records.values()].sort((a, b) => a.anchorSeq - b.anchorSeq)
    return { empty: [], replace: ({ nodes }) => { records.clear(); for (const node of nodes) records.set(node.id, node.data); return snapshot() },
      apply: ({ upserts }) => { for (const node of upserts) records.set(node.id, node.data); return snapshot() } }
  } })

  function bridge(sessionId) {
    const main = ctx.uiConversation.binding(sessionId).target('trajectory')
    const transfers = ctx.uiConversation.binding(sessionId).target(target)
    const retained = new Map(), pending = new Set(), listeners = new Set()
    let active = false, updating = false, resync = false, subscriptions = []
    let snapshot = { ...mergeGroupTrajectory(sessionId, main.getSnapshot(), [], new Map()), error: '' }
    const publish = () => {
      if (!active) return
      if (updating) { resync = true; return }
      updating = true
      try {
        const records = transfers.getSnapshot() ?? []
        for (const { message } of records) {
          const id = message.peer?.sessionId
          if (!id || retained.has(id) || pending.has(id)) continue
          pending.add(id)
          let ref
          try { ref = ctx.sessions.retain(id, { source: 'dsh-a2a-trajectory' }) }
          catch { pending.delete(id); continue }
          const entry = { ref, source: ctx.uiConversation.binding(ref.binding).target('trajectory'), off: () => {}, loaded: false, through: Infinity }
          retained.set(id, entry); pending.delete(id)
          entry.off = entry.source.subscribe(publish)
          void ref.ready.then(() => { if (active && retained.get(id) === entry) { entry.loaded = true; publish() } }).catch(error => {
            if (active) { entry.error = error.message; publish() }
          })
        }
        for (const [id, entry] of retained) {
          const firstSeq = Math.min(...records.filter(record => record.message.peer?.sessionId === id).map(record => record.message.peer.seq ?? Infinity))
          if (entry.loaded && firstSeq < entry.through) {
            entry.through = firstSeq
            void entry.ref.binding.session.loadThrough(firstSeq).catch(error => {
              if (active) { entry.error = error.message; publish() }
            })
          }
        }
        const peers = new Map([...retained].filter(([, entry]) => entry.loaded).map(([id, entry]) => [id, entry.source.getSnapshot()]))
        snapshot = { ...mergeGroupTrajectory(sessionId, main.getSnapshot(), records, peers),
          error: [...retained.values()].find(entry => entry.error)?.error ?? '' }
      } finally { updating = false }
      for (const listener of listeners) listener()
      if (resync) { resync = false; queueMicrotask(publish) }
    }
    return {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener)
        if (!active) {
          active = true
          subscriptions = [main.subscribe(publish), transfers.subscribe(publish), ctx.sessions.list.subscribe(publish)]
          publish()
        }
        return () => {
          listeners.delete(listener)
          if (listeners.size) return
          active = false
          subscriptions.forEach(dispose => dispose()); subscriptions = []
          const entries = [...retained.values()]; retained.clear(); pending.clear()
          for (const entry of entries) { entry.off(); entry.ref.release() }
        }
      },
    }
  }

  function mapElements(tree, transform) {
    if (Array.isArray(tree)) return tree.map(child => mapElements(child, transform))
    if (!isValidElement(tree)) return tree
    return transform(tree, children => cloneElement(tree, {}, children))
  }
  function renameRecord(tree, name, t) {
    return mapElements(tree, (element, children) => {
      const props = element.props
      if (element.type === 'tr' && props['data-kind'] === 'message') return cloneElement(element, {
        'data-agent-name': name, 'aria-label': props['aria-label']?.replace(t('kind.assistant'), name),
      }, renameRecord(props.children, name, t))
      if (props['data-role-kind'] === 'message') return cloneElement(element, { 'data-agent-name': name, title: name }, renameRecord(props.children, name, t))
      if (props.label === t('kind.assistant')) return cloneElement(element, { label: name }, renameRecord(props.children, name, t))
      if (element.type === 'span' && props.children === t('kind.assistant')) return cloneElement(element, { title: name }, name)
      return props.children === undefined ? element : children(renameRecord(props.children, name, t))
    })
  }
  function NamedTable({ Native, projection, ...props }) {
    const [selected, setSelected] = useState(null)
    const onSelectedIndexChange = useCallback(index => { setSelected(index); props.onSelectedIndexChange?.(index) }, [props.onSelectedIndexChange])
    const nameOf = cell => projection.assistantAuthors.get(cell.recordId) ?? projection.authors.get(cell.sourceSeq)
    const selectedCell = [...props.turns.flatMap(turn => turn.groups.flatMap(group => group.cells)), ...props.streamingCells].find(cell => cell.index === selected)
    // The native ledger owns its hooks and interactions. Its record render
    // callbacks provide the row identity; decorate the resulting React nodes.
    const tree = Native({ ...props, onSelectedIndexChange })
    const decorate = value => mapElements(value, (element, children) => {
      if (element.type === 'table') return cloneElement(element, { 'data-a2a-trajectory': '' }, decorate(element.props.children))
      const cell = element.props.cell
      if (cell?.kind === 'message' && typeof element.props.children === 'function') {
        const name = nameOf(cell)
        if (name) return cloneElement(element, { children: values => renameRecord(element.props.children(values), name, props.t) })
      }
      if (selectedCell?.kind === 'message' && element.type === 'span' && element.props.children === props.t('kind.assistant')) {
        return cloneElement(element, { title: nameOf(selectedCell) }, nameOf(selectedCell) ?? element.props.children)
      }
      return element.props.children === undefined ? element : children(decorate(element.props.children))
    })
    return decorate(tree)
  }
  function NativeTrajectory({ Native, projection, ...props }) {
    const tree = Native(props)
    if (!projection.hasPeers) return tree
    const decorate = value => mapElements(value, (element, children) => {
      if (element.props.requestNumbers && element.props.streamingCells && element.props.onToggleAssistant) {
        return h(NamedTable, { ...element.props, key: element.key, Native: element.type, projection })
      }
      if (element.props.turns && element.props.onRangeChange && element.props.onRecordFocus) {
        return h(NamedTimeline, { ...element.props, key: element.key, Native: element.type, projection })
      }
      return element.props.children === undefined ? element : children(decorate(element.props.children))
    })
    return decorate(tree)
  }
  function NamedTimeline({ Native, projection, ...props }) {
    const cells = new Map(props.turns.flatMap(turn => turn.groups.flatMap(group => group.cells.map(cell => [cell.index, cell]))))
    const tree = (typeof Native === 'function' ? Native : Native.type)(props)
    const decorate = value => mapElements(value, (element, children) => {
      const span = element.props.children
      if (isValidElement(span) && span.props['data-timeline-span'] === 'message' && typeof element.props.label === 'function') {
        const cell = cells.get(span.props['data-timeline-record-index'])
        const name = cell && (projection.assistantAuthors.get(cell.recordId) ?? projection.authors.get(cell.sourceSeq))
        if (name) return cloneElement(element, {
          label: () => element.props.label().replace(props.t('kind.assistant'), name),
        }, cloneElement(span, { 'data-agent-name': name }))
      }
      return element.props.children === undefined ? element : children(decorate(element.props.children))
    })
    return decorate(tree)
  }
  function GroupTrajectory({ Native, ...props }) {
    const projection = props.useA2aTrajectory(value => value)
    const useTrajectory = selector => props.useA2aTrajectory(value => selector(value.inspection))
    const viewRequest = props.viewRequest?.view === 'trajectory' && props.viewRequest.focus
      ? { ...props.viewRequest, focus: `${props.sessionId}:${props.viewRequest.focus}` } : props.viewRequest
    return h(NativeTrajectory, { ...props, Native, projection, useTrajectory,
      viewRequest,
      watchToolResult: (seq, publish) => {
        const address = projection.addresses.get(seq)
        return address ? props.servicesFor(address.sessionId).watchToolResult?.(address.seq, publish) : undefined
      },
      loadImage: Object.assign(attachment => props.servicesFor(projection.images.get(attachment) ?? props.sessionId).loadImage(attachment), {
        peek: attachment => props.servicesFor(projection.images.get(attachment) ?? props.sessionId).loadImage.peek(attachment),
      }),
    })
  }
  function GroupHeader({ Native, ...props }) {
    const tabs = props.useConversationViews(value => value)
    // The native header enumerates registrations rather than slot winners.
    // Preserve the original tab order when shadowing the trajectory view.
    const unique = useMemo(() => tabs.filter((tab, index) => tabs.findLastIndex(other => other.id === tab.id) === index), [tabs])
    const useConversationViews = selector => selector(unique)
    return h(Native, { ...props, useConversationViews })
  }
  ctx.slots.inject('conversation.session.header', () => {
    const original = ctx.slots.entriesOfSlot('conversation.session.header')[0]
    if (!original) return
    return nativeEntry('conversation.session.header', original, { id: 'dsh-a2a-trajectory-header', priority: -10 },
      (Native, props) => h(GroupHeader, { Native, ...props }))
  })
  ctx.slots.inject('conversation.view', () => {
    const original = ctx.slots.entriesOfSlot('conversation.view').find(entry => entry.options.id === 'trajectory')
    if (!original) return
    return nativeEntry('conversation.view', original, { ...original.options, id: 'trajectory', priority: -10,
      inject: sessionId => {
        const services = new Map([[sessionId, original.inject(sessionId)]])
        return { ...services.get(sessionId), hooks: { ...services.get(sessionId).hooks, a2aTrajectory: bridge(sessionId) },
          servicesFor: id => { if (!services.has(id)) services.set(id, original.inject(id)); return services.get(id) },
        }
      },
    }, (Native, props) => h(GroupTrajectory, { Native, ...props }))
  })
}
