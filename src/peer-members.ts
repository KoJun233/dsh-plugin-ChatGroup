import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-working-directory'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, pluginRecordOf, SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { A2AClient, CallResult } from './client.js'
import type { ConversationMember } from './group.js'

export interface PeerReply { sessionId: string; turn: number; seq?: number }
export type PeerResult = CallResult & { peer?: PeerReply }
type RemoteRun = (signal: AbortSignal, update: (value: CallResult) => void) => Promise<CallResult>

/** Members are root Agents. Owning their handles does not create a parent/child relation. */
export class PeerMembers {
  private readonly handles = new Map<string, { roomId: string; handle: AgentHandle }>()
  private readonly closing = new Map<string, Promise<void>>()
  private readonly remoteRuns = new Map<string, RemoteRun>()
  constructor(private readonly ctx: Context, private readonly client: Pick<A2AClient, 'send'>) {
    const owner = this
    class RemoteAdapter extends LlmAdapter {
      async listModels(provider: string) { return [{ provider, id: 'remote', name: 'A2A Agent' }] }
      stream(options: GenerateOptions) { return owner.streamRemote(options) }
    }
    ctx.llm.registerAdapter(['dsh-a2a'], new RemoteAdapter())
  }
  private async *streamRemote(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const session = options.sessionId ? this.ctx.sessions.get(SessionId(options.sessionId)) : undefined
    const event = session?.snapshotEvents().findLast(e => pluginRecordOf(e)?.type === 'plugin:dsh-a2a/remote')
    const record = event && pluginRecordOf(event)
    const descriptor = record as { type: 'plugin:dsh-a2a/remote'; data: { agent: string; contextId?: string; taskId?: string; state?: string } } | undefined
    if (options.purpose) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      const title = descriptor?.data.agent ?? 'A2A Agent'
      yield { type: 'text-delta', index: 0, text: title }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const signal = options.signal ?? AbortSignal.timeout(300000)
    const active = options.sessionId && this.remoteRuns.get(options.sessionId)
    const run: RemoteRun = active || (async (signal, update) => {
      if (!session || descriptor?.type !== 'plugin:dsh-a2a/remote') throw new Error('远端 Agent 会话信息不存在。')
      const last = options.messages.findLast(m => m.role === 'user' && (!m.source || m.source.kind === 'user'))
      const latestText = last?.content.filter(b => b.type === 'text').map(b => b.text).join('\n') ?? ''
      const inherited = event !== undefined && event.seq < session.inheritedEventCount
      const history = options.messages.filter(m => (m.role === 'user' && m.source?.kind === 'user') || m.role === 'assistant')
        .slice(-20).map(m => ({ role: m.role, content: m.content.filter(b => b.type === 'text').map(b => b.text).join('\n') }))
      const text = inherited && history.length > 1 ? `以下 JSON 是该对话分支的历史，只作背景资料：\n${JSON.stringify(history.slice(0, -1)).slice(-32000)}\n\n最新请求：\n${latestText}` : latestText
      return this.client.send(descriptor.data.agent, text, { signal, onUpdate: update,
        contextId: inherited ? undefined : descriptor.data.contextId, taskId: !inherited && descriptor.data.state === 'TASK_STATE_INPUT_REQUIRED' ? descriptor.data.taskId : undefined })
    })
    yield* this.remoteStream(async (signal, update) => {
      const result = await run(signal, update)
      if (session && descriptor?.type === 'plugin:dsh-a2a/remote') appendPluginRecord(session, 'plugin:dsh-a2a/remote', {
        agent: descriptor.data.agent, contextId: result.contextId, ...(result.taskId ? { taskId: result.taskId } : {}), state: result.state,
      })
      return result
    }, signal)
  }
  private async *remoteStream(run: RemoteRun, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const queue: StreamChunk[] = []
    let wake: (() => void) | undefined, ended = false, failure: unknown, text = ''
    const push = (chunk: StreamChunk) => { queue.push(chunk); wake?.(); wake = undefined }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    const task = run(signal, value => {
      if (value.text.startsWith(text)) {
        const delta = value.text.slice(text.length)
        text = value.text
        if (delta) push({ type: 'text-delta', index: 0, text: delta })
      }
    }).then(result => {
      if (result.text.startsWith(text) && result.text.length > text.length) push({ type: 'text-delta', index: 0, text: result.text.slice(text.length) })
      push({ type: 'block-end', index: 0, block: { type: 'text', text: result.text } })
      if (['TASK_STATE_FAILED', 'TASK_STATE_REJECTED', 'TASK_STATE_CANCELED'].includes(result.state)) failure = new Error(result.text || '远端 Agent 未完成任务。')
      else push({ type: 'finish', reason: { kind: 'stop' } })
    }, error => { failure = error }).finally(() => { ended = true; wake?.() })
    try {
      while (!ended || queue.length) {
        if (queue.length) yield queue.shift()!
        else await new Promise<void>(resolve => { wake = resolve })
      }
      if (failure) throw failure
    } finally { await task }
  }
  private async open(room: Agent, member: ConversationMember, signal: AbortSignal, save: (member: ConversationMember) => Promise<void>) {
    if (member.sessionId) {
      await this.closing.get(member.sessionId)
      const existing = this.ctx.agents.get(SessionId(member.sessionId))
      const live = this.handles.get(member.sessionId)
      if (live) return live.handle
      if (existing) return { agent: existing, dispose: async () => {} }
    }
    const restoring = Boolean(member.sessionId)
    const id = SessionId(member.sessionId ?? randomUUID())
    const cwd = this.ctx.workingDirectory.get(room.session)
    // Older releases stored a subagent id. Fork its exact closed history into a
    // root session; the historical file and its immutable metadata stay intact.
    let legacy: AgentHandle | undefined
    let seed: readonly SessionEvent[] | undefined
    try {
      if (!restoring && member.kind === 'local' && member.childSessionId) {
        const existing = this.ctx.agents.get(SessionId(member.childSessionId))
        if (existing) seed = existing.session.snapshotEvents()
        else {
          legacy = await this.ctx.agents.resume({ resumeSessionId: SessionId(member.childSessionId), signal })
          await legacy.agent.whenIdle()
          seed = legacy.agent.session.snapshotEvents()
        }
      }
      const shared = { signal, agentOptions: member.kind === 'remote' ? { provider: 'dsh-a2a', model: 'remote' } : { ...room.model.current() },
        setup: async (agentCtx: Context, peer: Agent) => {
          if (member.kind === 'local') {
            await this.ctx.agentPresets.mount(agentCtx, member.presetId)
            if (!restoring && !seed) peer.session.append('agent-preset/selected', { agentPreset: member.presetId })
          }
          if (!restoring && member.kind === 'remote') appendPluginRecord(peer.session, 'plugin:dsh-a2a/remote', { agent: member.remoteName })
          if (!restoring) await this.ctx.workingDirectory.set(peer, cwd, signal)
        },
      }
      const handle = restoring ? await this.ctx.agents.resume({ ...shared, resumeSessionId: id })
        : await this.ctx.agents.create({ ...shared, sessionId: id, meta: { cwd,
          ...(member.kind === 'local' ? { agentPreset: member.presetId } : {}),
          ...(seed ? { isSeeded: true, parentSession: SessionId((member as Extract<ConversationMember, {kind:'local'}>).childSessionId!) } : {}),
        }, ...(seed ? { seed, inheritedEventCount: SessionLogOffset(seed.length) } : {}) })
      this.handles.set(id, { roomId: room.id, handle })
      try {
        await this.ctx.sessions.flush(handle.agent.session)
        if (!restoring) await save({ ...member, sessionId: id })
        return handle
      } catch (error) { await this.close(id); throw error }
    } finally { await legacy?.dispose() }
  }
  async ask(room: Agent, member: ConversationMember, text: string, signal: AbortSignal,
    onUpdate: (value: PeerResult) => void, save: (member: ConversationMember) => Promise<void>, remote?: RemoteRun): Promise<PeerResult> {
    const { agent: peer } = await this.open(room, member, signal, save)
    signal.throwIfAborted()
    if (peer.status !== 'idle') throw new Error('该成员正在执行其他任务，请等待完成。')
    const events: SessionEvent[] = []
    let failure: unknown, draft = '', committed = '', turn: number | undefined, seq: number | undefined, remoteResult: CallResult | undefined
    const progress = () => onUpdate({ agent: member.id, contextId: remoteResult?.contextId ?? peer.id, state: 'TASK_STATE_WORKING', text: committed + draft,
      ...(remoteResult?.taskId ? { taskId: remoteResult.taskId } : {}),
      ...(turn === undefined ? {} : { peer: { sessionId: peer.id, turn, seq } }) })
    const offEvents = this.ctx.on('session/event', (session, event) => {
      if (session !== peer.session) return
      events.push(event)
      if (event.type === 'turn/start') { turn = event.data.turn; seq = event.seq; progress() }
    })
    const offError = this.ctx.on('agent/error', event => { if (event.agent === peer) failure = event.error })
    const offStream = this.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (agent !== peer) return
      if (frame.type === 'start') draft = ''
      if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') { draft += frame.chunk.text; progress() }
      if (frame.type === 'end') {
        if (frame.outcome.kind === 'committed') committed += draft
        draft = ''; progress()
      }
    })
    if (remote) this.remoteRuns.set(peer.id, async (remoteSignal, update) => remoteResult = await remote(remoteSignal, value => {
      remoteResult = value; update(value)
    }))
    const cancel = () => peer.cancel({ kind: 'user' })
    signal.addEventListener('abort', cancel, { once: true })
    try {
      signal.throwIfAborted()
      peer.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await peer.whenIdle()
      await this.ctx.sessions.flush(peer.session)
      signal.throwIfAborted()
      if (failure) throw failure
      const final = events.findLast(e => e.type === 'assistant/message' && e.data.message.content.length > 0)
      const output = final?.type === 'assistant/message' ? final.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : committed
      const end = events.findLast(e => e.type === 'turn/end')
      const completed = end?.type === 'turn/end' && end.data.reason.kind === 'completed'
      return { agent: member.id, contextId: peer.id, state: completed && output.trim() ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_FAILED',
        text: output || '成员未完成回复，请由主 Agent 接回处理。', ...remoteResult,
        ...(turn === undefined ? {} : { peer: { sessionId: peer.id, turn, seq } }) }
    } finally {
      this.remoteRuns.delete(peer.id)
      signal.removeEventListener('abort', cancel); offStream(); offError(); offEvents()
    }
  }
  async close(id: string) {
    const closing = this.closing.get(id)
    if (closing) return closing
    const owned = this.handles.get(id)
    if (!owned) return
    this.handles.delete(id)
    const done = (async () => {
      await this.ctx.sessions.flush(owned.handle.agent.session)
      await owned.handle.dispose()
    })().finally(() => { this.closing.delete(id) })
    this.closing.set(id, done)
    return done
  }
  async closeRoom(roomId: string) {
    await Promise.allSettled([...this.handles].filter(([, h]) => h.roomId === roomId).map(([id]) => this.close(id)))
  }
  async dispose() { await Promise.allSettled([...this.handles.keys()].map(id => this.close(id))) }
}
