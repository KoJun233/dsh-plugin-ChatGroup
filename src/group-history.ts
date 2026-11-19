import { symbols } from '@deepseek-ai/cordis'
import { freezeMessage, isAgentLoopRequest, markAgentLoopRequest, MessageId, type AssistantMessage, type GenerateOptions, type LlmRuntime, type RequestMessage } from '@deepseek-ai/dsh-llm'
import { isSurfaceEvent, pluginRecordOf, SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import type { GroupRecord } from './group.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    // Read-only migration for the 0.11.5 projection; no new recall events.
    'dsh-a2a/member-reply': { kind: 'dsh-a2a/member-reply'; form: 'recall'; replyId: string }
  }
}

interface PublicReply {
  seq: number
  revision: number
  input?: string
  callId?: string
  message?: AssistantMessage
}
interface RoomHistory {
  next: SessionLogOffset
  lastInput?: string
  dispatchInputs: Map<string, string | undefined>
  placements: Map<number, number>
  positions: Map<string, number>
  replies: Map<string, PublicReply>
}

const isInput = (message: RequestMessage) => message.role === 'user' &&
  (message.source?.kind === 'user' || message.source?.kind === 'dsh-a2a/handoff')

/** Read the durable room log, without creating native turns or writing another copy. */
export class MemberHistory {
  private readonly histories = new WeakMap<Session, RoomHistory>()

  project(session: Session, messages: GenerateOptions['messages']): GenerateOptions['messages'] {
    let history = this.histories.get(session)
    if (!history) {
      history = { next: SessionLogOffset(0), dispatchInputs: new Map(), placements: new Map(), positions: new Map(), replies: new Map() }
      this.histories.set(session, history)
    }
    for (const event of session.snapshotEvents(history.next)) {
      if (isSurfaceEvent(event)) {
        const op = event.surfaceOp
        const position = op === 'append' ? event.seq : history.placements.get(op.startSeq) ?? op.startSeq
        history.placements.set(event.seq, position)
        const data = event.type === 'user/message' ? event.data : event.data.message
        history.positions.set(data.id, position)
        if (isInput(data)) history.lastInput = data.id
        continue
      }
      const record = pluginRecordOf(event)
      if (record?.type !== 'plugin:dsh-a2a/group') continue
      const item = record.data as GroupRecord
      if (item.kind !== 'message') continue
      if (item.role === 'dispatch' && item.callId) history.dispatchInputs.set(item.callId, history.lastInput)
      if (item.role !== 'member' || (history.replies.get(item.id)?.revision ?? -1) >= item.revision) continue
      const input = item.callId && history.dispatchInputs.has(item.callId) ? history.dispatchInputs.get(item.callId) : history.lastInput
      const message = (item.state === 'completed' || item.state === 'input-required') && item.text.trim() ? freezeMessage<AssistantMessage>({
        id: MessageId(item.id), role: 'assistant', source: { kind: 'model', provider: 'dsh-a2a', model: 'member' },
        // Not all provider APIs expose a speaker/name field on assistant input.
        // Keep the body verbatim with a short speaker label, and no replay token.
        content: [{ type: 'text', text: `${(item.authorName || item.author).replace(/\s+/gu, ' ')}：\n${item.text}` }],
      }) : undefined
      history.replies.set(item.id, { seq: event.seq, revision: item.revision, input, callId: item.callId, message })
    }
    history.next = session.seq
    if (!history.replies.size) return messages
    const { positions, replies } = history
    const keptInputs = new Set<string>(messages.flatMap(m => isInput(m) && m.id ? [m.id] : []))
    const toolResults = new Set<string>(messages.flatMap(m => m.role === 'tool' && !m.isError ? [m.toolCallId] : []))
    const presentIds = new Set(messages.map(m => m.id))
    const visible = [...replies.values()].filter((r): r is PublicReply & { message: AssistantMessage } => Boolean(r.message &&
      (r.input === undefined || keptInputs.has(r.input)) && (!r.callId || !toolResults.has(r.callId)) && !presentIds.has(r.message.id)))
      .sort((a, b) => a.seq - b.seq)
    const projected: RequestMessage[] = []
    let i = 0
    for (const message of messages) {
      const position = message.id === undefined ? undefined : positions.get(message.id)
      if (position !== undefined) while (i < visible.length && visible[i].seq < position) projected.push(visible[i++].message)
      // The original room reply replaces the old wrapper, including on resume.
      if (message.role === 'user' && message.source?.kind === 'dsh-a2a/member-reply' && replies.get(message.source.replyId)?.message) continue
      projected.push(message)
    }
    while (i < visible.length) projected.push(visible[i++].message)
    return projected.length === messages.length && projected.every((m, index) => m === messages[index]) ? messages : projected
  }
}

/** DSH 0.2.2's stream waterfall observes a frozen request and cannot replace it.
 * Decorate the public dispatch entry points before that waterfall; retain the
 * original prepared adapter, config, one-shot dispatch, and routing marker.
 */
export function bindMemberHistory(llm: LlmRuntime, sessionOf: (id: string) => Session | undefined) {
  const service: LlmRuntime = Reflect.get(llm, symbols.original) ?? llm
  const history = new MemberHistory()
  let active = true
  function project(request: GenerateOptions) {
    if (!active || request.purpose || !isAgentLoopRequest(request) || !request.sessionId || request.provider === 'dsh-a2a') return request
    const session = sessionOf(request.sessionId)
    if (!session) return request
    const messages = history.project(session, request.messages)
    if (messages === request.messages) return request
    Object.freeze(messages)
    return markAgentLoopRequest(Object.freeze({ ...request, messages }))
  }
  const prepare = service.prepareCall
  const stream = service.stream
  const wrappedPrepare: typeof prepare = async function (this: LlmRuntime, ...args) {
    const prepared = await prepare.apply(this, args)
    return Object.freeze({ ...prepared, stream: (request: GenerateOptions) => prepared.stream(project(request)) })
  }
  const wrappedStream: typeof stream = function (this: LlmRuntime, request) {
    return stream.call(this, project(request))
  }
  const prepareDescriptor = Object.getOwnPropertyDescriptor(service, 'prepareCall')
  const streamDescriptor = Object.getOwnPropertyDescriptor(service, 'stream')
  Object.defineProperty(service, 'prepareCall', { value: wrappedPrepare, configurable: true, writable: true })
  Object.defineProperty(service, 'stream', { value: wrappedStream, configurable: true, writable: true })
  return () => {
    active = false
    if (service.prepareCall === wrappedPrepare) {
      if (prepareDescriptor) Object.defineProperty(service, 'prepareCall', prepareDescriptor)
      else Reflect.deleteProperty(service, 'prepareCall')
    }
    if (service.stream === wrappedStream) {
      if (streamDescriptor) Object.defineProperty(service, 'stream', streamDescriptor)
      else Reflect.deleteProperty(service, 'stream')
    }
  }
}
