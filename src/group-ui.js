import { groupRemote } from './group-contract.js'
import { agentLabel, memberMentions } from './group-routing.js'
import { nativeUi } from './native-ui.js'
import { registerGroupTrajectory } from './group-trajectory-ui.js'

export function groupClient(require) {
  const { createElement: h, createContext, useContext, useState, useEffect, useLayoutEffect, useRef, useMemo } = require('react')
  const { Button, MenuItemButton } = require('@deepseek-ai/dsh-client-ui-primitives')
  const { Markdown } = nativeUi(require)
  const target = 'dsh-a2a-members'
  // A peer may have its own roster; embedded steps keep the outer member's identity.
  const MemberReplyContext = createContext(false)
  const definition = { id: 'dsh-a2a/session-settings', kind: 'dsh-a2a-session-settings', title: () => '会话设置' }
  const read = event => event.type === 'plugin:dsh-a2a/group' && event.data && typeof event.data.id === 'string' && Number.isSafeInteger(event.data.revision) ? event.data : null
  const memberEvents = {
    kind: 'dsh-a2a-member-answer', target: 'chat',
    match: event => { const m = read(event); return m?.kind === 'message' && m.role === 'member' ? { id: m.id, role: m.order === m.revision ? 'start' : 'update' } : null },
    start: (_ctx, match) => read(match.event),
    update: (ctx, match) => { const m = read(match.event); return m && m.revision > ctx.state.revision ? m : ctx.state },
    buildViewNode: ctx => {
      const first = ctx.start ?? ctx.matches[0]
      return { key: ctx.key, kind: 'dsh-a2a-member-answer', id: ctx.state.id, target: 'chat', anchorSeq: first.event.seq,
        location: first.location, visibility: 'visible', groupTree: 'turn', data: ctx.state }
    },
  }
  const rosterEvents = {
    kind: 'dsh-a2a-member-roster', target,
    match: event => { const m = read(event); return m?.kind === 'members' ? { id: String(event.seq), role: 'start' } : null },
    start: (_ctx, match) => read(match.event), update: ctx => ctx.state,
    buildViewNode: ctx => ({ key: ctx.key, kind: ctx.kind, id: ctx.state.id, target, data: ctx.state }),
  }
  const rosterView = { target, isActive: () => true, create() {
    let current = null
    const latest = (previous, nodes) => {
      let value = previous
      const known = new Map((previous?.knownMembers ?? []).map(m => [m.id, m]))
      for (const node of nodes) {
        for (const member of node.data.members) known.set(member.id, member)
        if (node.data.revision > (value?.revision ?? -1)) value = node.data
      }
      return value ? { ...value, knownMembers: [...known.values()] } : null
    }
    return { empty: null, replace: ({ nodes }) => current = latest(null, nodes), apply: ({ upserts }) => current = latest(current, upserts) }
  } }

  const adviserIcon = h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'currentColor' },
    h('path', { d: 'M6 2.5 7.7 6.8 12 8.5 7.7 10.2 6 14.5 4.3 10.2 0 8.5 4.3 6.8Z M12.5 0 13.4 2.6 16 3.5 13.4 4.4 12.5 7 11.6 4.4 9 3.5 11.6 2.6Z' }))
  const memberIcon = h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' },
    h('circle', { cx: 8, cy: 4, r: 2.5 }), h('path', { d: 'M3 14v-1.5a5 5 0 0 1 10 0V14' }))

  function SignedReply({ name, kind, children, ...attributes }) {
    const root = useRef(null)
    const [gutter, setGutter] = useState(false)
    useLayoutEffect(() => {
      const element = root.current
      const scroll = element?.closest('[data-conversation-scroll]')
      if (!scroll) return
      const measure = () => setGutter(element.getBoundingClientRect().left - scroll.getBoundingClientRect().left >= 144)
      measure()
      const observer = new ResizeObserver(measure)
      observer.observe(scroll)
      observer.observe(element)
      return () => observer.disconnect()
    }, [])
    return h('article', { ...attributes, ref: root, className: `a2am-signed ${attributes.className ?? ''}`, 'data-speaker': kind, 'data-gutter': gutter || undefined },
      h('div', { className: 'a2am-author', 'aria-label': `回复者：${name}` },
        h('span', { className: 'a2am-speaker-badge', title: name },
          h('span', { className: 'a2am-avatar', 'aria-hidden': true }, kind === 'main' ? adviserIcon : memberIcon),
          h('span', { className: 'a2am-speaker-name' }, name))),
      h('div', { className: 'a2am-reply-body' }, children))
  }

  const peerSlot = 'dsh-a2a.peer-answer'
  const peerFlow = 'dsh-a2a.peer-flow'
  function MemberAnswer({ node, SessionProvider, renderSlot, retainPeer, watchPeers }) {
    const message = node.data
    const name = message.authorName || agentLabel(message.author)
    const [ready, setReady] = useState(null)
    const [error, setError] = useState('')
    const peer = message.peer
    const legacyId = !peer && message.author.startsWith('local:') ? message.childSessionId ?? message.contextId : undefined
    const peerId = peer?.sessionId ?? legacyId
    useEffect(() => {
      setReady(null); setError('')
      if (!peerId) return
      let active = true
      let ref, acquiring = false, unlisten = () => {}
      const acquire = () => {
        if (!active || ref || acquiring) return
        acquiring = true
        try { ref = retainPeer(peerId) }
        catch (e) { if (peer) setError(e.message) }
        finally { acquiring = false }
        if (!ref) return
        unlisten(); unlisten = () => {}
        void ref.ready.then(async () => {
          if (!active) return
          if (peer?.seq !== undefined) await ref.binding.session.loadThrough(peer.seq)
          if (active) { setError(''); setReady(ref) }
        }).catch(e => { if (active && peer) setError(e.message) })
      }
      acquire()
      // Discovery may lag the reply record. Retry until retained, then keep
      // that reference through catalog updates, removal and host reconnects.
      if (!ref) unlisten = watchPeers(acquire)
      return () => { active = false; unlisten(); ref?.release() }
    }, [peerId])
    return h(SignedReply, { name, kind: 'member', className: 'a2am-answer', 'data-member-answer': message.id, 'data-state': message.state,
      'data-peer-session': peerId, 'data-peer-turn': peer?.turn },
      ready?.sessionId === peerId && peerId ? h(MemberReplyContext.Provider, { value: true }, h(SessionProvider, { session: ready },
        renderSlot(peerSlot, { requestedTurn: peer?.turn, legacyTime: message.createdAt, legacyText: message.text }))) : h('div', { 'data-native-markdown': true },
        message.text ? h(Markdown, { text: message.text, streaming: message.state === 'working' })
          : h('span', { className: 'a2am-muted', role: 'status' }, message.state === 'working' ? '正在连接…' : message.state === 'canceled' ? '任务已停止。' : '未收到文字回复。')),
      !peer && !ready && message.text && message.state !== 'working' ? h(Button, { size: 'sm', onClick: () => navigator.clipboard.writeText(message.text), 'aria-label': '复制历史回复' }, '复制') : null,
      error ? h('p', { className: 'a2am-error', role: 'status' }, '原生会话加载失败：', error) : null)
  }
  function PeerAnswer({ requestedTurn, legacyTime, legacyText, renderSlot, useChat, useSessions, sessionId, openFile, forkAt, loadImage, inspectCall }) {
    const order = useChat(s => s.order)
    const store = useChat(s => s.nodes)
    const cwd = useSessions(s => s.byId[sessionId]?.cwd)
    const effectiveTurn = useMemo(() => {
      if (requestedTurn !== undefined) return requestedTurn
      const time = Date.parse(legacyTime)
      const candidates = order.map(key => store.get(key)).filter(node => node?.kind === 'assistant-step')
        .map(node => ({ node, turn: node.location.turn, text: node.data.blocks.filter(b => b.kind === 'text').map(b => b.text).join('\n') }))
      const matches = candidates.filter(candidate => candidate.text.trim() === legacyText.trim())
      return (matches.length ? matches : candidates).sort((a, b) => Math.abs((a.turn?.start?.time ?? 0) - time) - Math.abs((b.turn?.start?.time ?? 0) - time))[0]?.turn?.turn
    }, [requestedTurn, legacyTime, legacyText, order, store])
    const entries = useMemo(() => order.flatMap(key => {
      const node = store.get(key)
      const location = node?.location
      const turn = location?.kind === 'turn' || location?.kind === 'step' ? location.turn.turn : undefined
      return turn === effectiveTurn && !['user', 'turn-trigger', 'system-prompt', 'context'].includes(node.kind) ? [{ kind: 'node', key }] : []
    }), [order, store, effectiveTurn])
    return h('div', { className: 'a2am-native-flow', 'data-native-peer-flow': sessionId }, renderSlot(peerFlow, {
      entries, pendingInputs: [], lastInputTurn: effectiveTurn, deferCollapse: false,
      cwd, openFile, forkAt, loadImage, inspectCall, requestedTurn: effectiveTurn,
    }, { hookContext: {} }))
  }
  function SettingsBody({ sessionId, api, useA2aMembers, useSession, useTabInfo, openThread }) {
    const { tab } = useTabInfo()
    const roster = useA2aMembers(value => value)
    const running = useSession(value => value.running)
    const [state, setState] = useState(null)
    const [error, setError] = useState('')
    const [pending, setPending] = useState(false)
    const [query, setQuery] = useState('')
    const [adding, setAdding] = useState(false)
    const active = useRef(true)
    const refresh = async signal => {
      try { const value = await api('state', sessionId, [], signal); if (active.current) { setState(value); setError('') } }
      catch (e) { if (active.current && !signal?.aborted) setError(e.message) }
    }
    useEffect(() => {
      active.current = true
      const controller = new AbortController()
      void refresh(AbortSignal.any([controller.signal, tab.signal]))
      return () => { active.current = false; controller.abort() }
    }, [sessionId, tab.signal])
    const members = roster?.members ?? state?.members ?? []
    const busy = pending || running
    const change = async (method, args) => {
      setPending(true); setError('')
      try {
        const result = await api(method, sessionId, args, tab.signal)
        if (active.current) setState(old => ({ ...old, members: result.members }))
      } catch (e) { if (active.current && !tab.signal.aborted) setError(e.message) }
      finally { if (active.current) setPending(false) }
    }
    const candidates = state?.agents?.filter(a => !members.some(m => m.id === a.id) && (!query || `${a.name} ${a.description}`.toLowerCase().includes(query.toLowerCase()))) ?? []
    return h('section', { className: 'a2am-settings', 'data-session-members': sessionId },
      h('div', { className: 'a2am-section-title' }, '顾问'),
      h('div', { className: 'a2am-main-agent' }, h('strong', null, '当前会话 Agent'), h('p', { className: 'a2am-muted' }, '未 @成员 的消息由它回答或协调。')),
      h('div', { className: 'a2am-section-heading' }, h('span', { className: 'a2am-section-title' }, `会话成员${members.length ? ` · ${members.length}` : ''}`),
        h(Button, { size: 'sm', disabled: !state || busy, onClick: () => setAdding(value => !value), 'aria-expanded': adding }, adding ? '完成' : '添加 Agent')),
      !state && !error ? h('p', { className: 'a2am-muted', role: 'status' }, '正在加载成员…') : null,
      !members.length && state ? h('p', { className: 'a2am-muted a2am-empty' }, '添加本地或远端 Agent，即可在当前会话中 @它。') : null,
      members.map(member => h('div', { className: 'a2am-member', key: member.id, 'data-member-id': member.id },
        h('div', { className: 'a2am-member-info' }, h('strong', null, member.name), h('span', { className: 'a2am-muted' }, member.kind === 'local' ? '本地 Agent' : '远端 A2A'),
          member.description ? h('p', { className: 'a2am-muted' }, member.description) : null,
          member.sessionId || (member.kind === 'local' && member.childSessionId) ? h(Button, { size: 'sm', onClick: () => openThread(member.sessionId ?? member.childSessionId) }, '查看对话') : null),
        h(Button, { size: 'sm', disabled: busy, 'aria-label': `移除${member.name}`, onClick: () => void change('removeMember', [member.id]) }, '移除'))),
      adding ? h('div', { className: 'a2am-add', 'aria-label': '添加会话成员' },
        h('div', { className: 'a2am-search-row' }, h('input', { className: 'a2am-search', type: 'search', value: query, placeholder: '搜索 Agent', 'aria-label': '搜索 Agent', onChange: event => setQuery(event.target.value) }),
          h(Button, { size: 'sm', disabled: pending, onClick: () => void refresh(tab.signal) }, '刷新')),
        ['local', 'remote'].map(kind => h('div', { key: kind }, h('div', { className: 'a2am-section-title a2am-kind' }, kind === 'local' ? '本地 Agent 预设' : '远端 A2A'),
          candidates.filter(a => a.kind === kind).map(a => h('div', { className: 'a2am-member', key: a.id },
            h('div', { className: 'a2am-member-info' }, h('strong', null, a.name), h('p', { className: 'a2am-muted' }, a.unavailable || a.description || (kind === 'local' ? '在本会话中独立运行' : 'A2A Agent'))),
            h(Button, { size: 'sm', disabled: busy || Boolean(a.unavailable), 'aria-label': `添加${a.name}`, onClick: () => void change('addMember', [{ kind: a.kind, id: a.id }]) }, '添加'))),
          !candidates.some(a => a.kind === kind) ? h('p', { className: 'a2am-muted' }, query ? '没有匹配的 Agent' : '暂无可添加的 Agent') : null))) : null,
      state?.discoveryError ? h('p', { className: 'a2am-muted', role: 'status' }, state.discoveryError) : null,
      error ? h('p', { className: 'a2am-error', role: 'alert' }, error, ' ', h(Button, { size: 'sm', onClick: () => void refresh(tab.signal) }, '重试')) : null)
  }
  function SettingsMenuItem({ onDismiss, openSettings }) {
    return h(MenuItemButton, { separatorBefore: true, onSelect: () => { onDismiss(); openSettings() } }, '会话设置')
  }
  return {
    inject: ['remote', 'sessions', 'sidebarRightTabs', 'sidebarRight', 'inputTriggers', 'uiWorkspace'],
    async apply(ctx) {
      await ctx.remote.$mount(groupRemote)
      await ctx.inject(['remote.a2aGroup'], ctx => {
        const api = async (method, sessionId, args = [], signal) => {
          const descriptor = groupRemote.methods[`a2aGroup/${method}`]
          const input = { [descriptor.parameters[0].wire]: sessionId, ...Object.fromEntries(descriptor.parameters.slice(1).map((p, i) => [p.wire, args[i]])) }
          const result = await descriptor.invoke(ctx.remote, input, signal)
          if (result.error) throw new Error(result.error.message || '操作未完成，请重试。')
          return result.value
        }
        function nativeEntry(slot, original, options, decorate) {
          const children = Object.fromEntries(Object.entries(original.children ?? {}).map(([name, spec]) => [`${slot}/${options.key ?? options.id ?? 'entry'}/${name}`, spec]))
          const aliases = new Map(Object.keys(original.children ?? {}).map(name => [name, `${slot}/${options.key ?? options.id ?? 'entry'}/${name}`]))
          function Native(props) {
            const forwarded = { ...props,
              ...(props.renderSlot ? { renderSlot: (name, owner, opts) => props.renderSlot(aliases.get(name) ?? name, owner, opts) } : {}),
              ...(props.renderSlotChain ? { renderSlotChain: (name, owner, opts) => props.renderSlotChain(aliases.get(name) ?? name, owner, opts) } : {}),
            }
            return decorate ? decorate(original.component, forwarded) : h(original.component, forwarded)
          }
          const disposeEntry = ctx.slots.register({ ...options, name: slot, locale: original.locale, store: original.store,
            select: original.select, ...(aliases.size ? { children } : {}), inject: options.inject ?? original.inject,
          }, Native)
          const childDisposers = []
          for (const [source, alias] of aliases) {
            let previous = [], copies = []
            const sync = () => {
              const entries = ctx.slots.entriesOfSlot(source).filter(entry => !(slot.startsWith(peerFlow) && source === 'conversation.chat.node' && entry.options.key === 'dsh-a2a-member-answer'))
              if (entries.length === previous.length && entries.every((entry, i) => entry === previous[i])) return
              copies.toReversed().forEach(dispose => dispose())
              previous = entries
              copies = entries.map(entry => nativeEntry(alias, entry, entry.options))
            }
            sync()
            const unlisten = ctx.on('slots/changed', name => { if (name === source) sync() })
            childDisposers.push(() => { unlisten(); copies.toReversed().forEach(dispose => dispose()) })
          }
          return () => { childDisposers.toReversed().forEach(dispose => dispose()); disposeEntry() }
        }
        registerGroupTrajectory(ctx, require, nativeEntry, read)
        ctx.uiConversation.events.register(memberEvents)
        ctx.uiConversation.events.register(rosterEvents)
        ctx.uiConversation.views.register(rosterView)
        ctx.uiConversation.userText.register({ id: 'dsh-a2a-member', order: 5,
          match(text, from, context) {
            const match = memberMentions(text, context.read('a2aMembers') ?? []).find(m => m.start >= from)
            return match ? { id: 'dsh-a2a-member', start: match.start, end: match.end, data: { name: match.member.name, text: text.slice(match.start, match.end) } } : undefined
          },
        })
        ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({ name: 'conversation.user.text.node', key: 'dsh-a2a-member' },
          ({ node }) => h('span', { className: 'a2am-mention', 'data-agent-mention': node.data.name }, node.data.text)))
        ctx.effect(() => ctx.sidebarRightTabs.register(definition))
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id,
          inject: sessionId => ({ sessionId, api, openThread: id => ctx.uiWorkspace.openSession(id), hooks: { a2aMembers: ctx.uiConversation.binding(sessionId).target(target), session: ctx.sessions.binding(sessionId).session } }),
        }, SettingsBody))
        ctx.slots.inject('conversation.session.header.views.actions', () => ctx.slots.register({ name: 'conversation.session.header.views.actions', id: definition.id,
          inject: () => ({ openSettings: () => ctx.sidebarRight.openTab(definition.kind) }),
        }, SettingsMenuItem))
        ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'dsh-a2a-member-answer',
          children: { [peerSlot]: { kind: 'single', scope: 'session' } },
          inject: () => ({ retainPeer: id => ctx.sessions.retain(id, { source: 'dsh-a2a-peer-reply' }), watchPeers: listener => ctx.sessions.list.subscribe(listener) }),
        }, MemberAnswer))
        const activityTarget = 'dsh-a2a-activity'
        ctx.uiConversation.events.register({ kind: activityTarget, target: activityTarget,
          match: event => read(event)?.kind === 'room' ? { id: String(event.seq), role: 'start' } : null,
          start: (_ctx, match) => read(match.event), update: context => context.state,
          buildViewNode: context => ({ key: context.key, kind: activityTarget, id: '@room', target: activityTarget, data: context.state }),
        })
        ctx.uiConversation.views.register({ target: activityTarget, isActive: value => value?.busy === true, create() {
          let value = null
          const latest = nodes => { for (const node of nodes) if (node.data.revision > (value?.revision ?? -1)) value = node.data; return value }
          return { empty: null, replace: ({ nodes }) => { value = null; return latest(nodes) }, apply: ({ upserts }) => latest(upserts) }
        } })
        // Reuse the shipped flow and all of its node renderers in the actual
        // peer SessionProvider: feedback and branch actions keep their identity.
        ctx.effect(() => {
          const disposers = []; let installed = false
          const install = () => {
            if (installed) return
            const view = ctx.slots.entriesOfSlot('conversation.view').find(e => e.options.id === 'chat')
            const flow = ctx.slots.entriesOfSlot('conversation.chat.flow')[0]
            if (!view || !flow) return
            installed = true
            disposers.push(ctx.slots.register({ name: peerSlot, locale: view.locale, inject: view.inject,
              children: { [peerFlow]: view.children['conversation.chat.flow'] },
            }, PeerAnswer))
            disposers.push(nativeEntry(peerFlow, flow, { id: 'native', inject: flow.inject }, (Original, props) => {
              const nativeSession = props.useSession
              const currentTurn = props.useChat(snapshot => snapshot.timeline.turnOrder.at(-1))
              const usePeerSession = selector => nativeSession(snapshot => selector({ ...snapshot, running: snapshot.running && currentTurn === props.requestedTurn }))
              return h(Original, { ...props, useSession: usePeerSession })
            }))
          }
          const unlisten = ctx.on('slots/changed', name => { if (name === 'conversation.view' || name === 'conversation.chat.flow') queueMicrotask(install) })
          install()
          return () => { unlisten(); disposers.toReversed().forEach(dispose => dispose()) }
        })
        ctx.slots.inject('conversation.composer.bar', () => {
          const original = ctx.slots.entriesOfSlot('conversation.composer.bar')[0]
          if (!original) return
          return nativeEntry('conversation.composer.bar', original, { id: 'dsh-a2a-native-composer', priority: -10,
            inject: sessionId => {
              const inherited = original.inject?.(sessionId) ?? {}
              return { ...inherited, ...(sessionId ? {
                cancelPeer: () => api('cancel', sessionId),
                hooks: { ...inherited.hooks, a2aActivity: ctx.uiConversation.binding(sessionId).target(activityTarget) },
              } : {}) }
            },
          }, (Original, props) => {
            if (!props.sessionId) return h(Original, props)
            const busy = props.useA2aActivity(value => value?.busy === true)
            const nativeSession = props.useSession
            const useGroupSession = selector => nativeSession(snapshot => selector({ ...snapshot, running: snapshot.running || busy }))
            return h(Original, { ...props, useSession: useGroupSession, stop: () => { void props.cancelPeer().catch(() => props.stop?.()) } })
          })
        })
        // Wrap the shipped renderers, retaining their actions, images, reasoning and process views.
        ctx.slots.inject('conversation.chat.node', () => {
          const disposers = [], installed = new Set()
          let closed = false, scheduled = false
          const install = () => {
            if (closed) return
            for (const key of ['assistant-step', 'user', 'steering', 'turn-process']) {
              if (installed.has(key)) continue
              const original = ctx.slots.entriesOfSlot('conversation.chat.node').find(entry => entry.options.key === key)
              if (!original) continue
              installed.add(key)
              const decorate = (Original, props) => {
                const insideMemberReply = useContext(MemberReplyContext)
                const roster = props.useA2aMembers(value => value)
                const members = roster?.knownMembers ?? roster?.members ?? []
                if (key === 'turn-process') {
                  // Direct @ routing makes no main-model reply. Its empty
                  // control turn has no answer duration to show in the chat.
                  const routingOnly = props.useChat(snapshot => {
                    const nodes = snapshot.locations.getTurn(props.node.data.turn).map(key => snapshot.nodes.get(key)).filter(Boolean)
                    if (insideMemberReply || !members.length || nodes.some(node => node.kind === 'assistant-step' && node.data.blocks.some(block => block.kind === 'text' ? block.text.trim() : true))) return false
                    const text = nodes.filter(node => node.kind === 'user').flatMap(node => node.data.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
                    return new Set(memberMentions(text, members).map(mention => mention.member.id)).size === 1
                  })
                  return routingOnly && props.node.location.turn?.end?.data.reason.kind === 'completed' ? null : h(Original, props)
                }
                if (key === 'assistant-step') {
                  const visible = props.groupPart !== 'reasoning' && props.node.data.blocks?.some(block =>
                    block.kind === 'text' ? block.text?.trim() : block.kind !== 'reasoning' && block.kind !== 'tool-call')
                  const content = h(Original, props)
                  return !insideMemberReply && members.length && visible ? h(SignedReply, { name: '顾问', kind: 'main' }, content) : content
                }
                return h(Original, { ...props, renderFactorySlot: (name, owner, options) => props.renderFactorySlot(name,
                  name === 'conversation.chat.user.content' ? { ...owner, facts: { ...owner.facts, a2aMembers: members } } : owner, options) })
              }
              disposers.push(nativeEntry('conversation.chat.node', original, { key, priority: -10,
                inject: sessionId => {
                  const inherited = original.inject?.(sessionId) ?? {}
                  return { ...inherited, hooks: { ...inherited.hooks, a2aMembers: ctx.uiConversation.binding(sessionId).target(target) } }
                },
              }, decorate))
            }
          }
          const unlisten = ctx.on('slots/changed', name => {
            if (name !== 'conversation.chat.node' || scheduled) return
            scheduled = true
            queueMicrotask(() => { scheduled = false; install() })
          })
          install()
          return () => { closed = true; unlisten(); disposers.toReversed().forEach(dispose => dispose()) }
        })
        const cached = new Map()
        ctx.effect(() => ctx.inputTriggers.registerSource({ trigger: '@', name: 'a2a-members', order: 10, showGroupTitle: false,
          async candidates({ sessionId }, { query, quoted, drilled, signal }) {
            if (quoted || drilled || /[/\\]/u.test(query)) return []
            const result = await api('members', sessionId, [], signal)
            cached.set(sessionId, result.members)
            const q = query.toLowerCase()
            return result.members.filter(m => !q || `${m.name} ${m.id}`.toLowerCase().includes(q)).map(m => ({ name: m.name, description: m.description, value: m.id, section: '会话成员' }))
          },
          onPick: ({ candidate }) => ({ text: `@${candidate.name} ` }),
          lexicon: ({ sessionId }) => (ctx.uiConversation.binding(sessionId).target(target).getSnapshot()?.members ?? cached.get(sessionId) ?? []).map(m => m.name),
          subscribeLexicon: ({ sessionId }, listener) => ctx.uiConversation.binding(sessionId).target(target).subscribe(listener),
        }))
      })
    },
  }
}
