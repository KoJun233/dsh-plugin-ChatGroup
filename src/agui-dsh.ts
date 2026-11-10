import { createToolResultMessage, ToolCallId, type ContentBlock, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolBatchExecutionError, type ToolBatchInput, type ToolBatchResult, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { AgUiProtocolError, type AgUiRecord } from './agui.js'
import type { CallResult } from './client.js'

export type RemoteRun = (signal: AbortSignal, update: (value: CallResult) => void, trace?: (value: AgUiRecord) => void) => Promise<CallResult>
interface Block { index: number; block: ContentBlock; closed: boolean }
interface RemoteTool { id: ToolCallId; name: string; arguments: string; block: Block; result?: string; replayed: boolean }

/** Converts one remote execution into native model streams and recorded tool outcomes.
 * The scoped tool consumer never resolves, authorizes or invokes a local tool.
 */
export class AgUiDshRun {
  private readonly controller = new AbortController()
  private readonly signal: AbortSignal
  private readonly queue: StreamChunk[] = []
  private readonly listeners = new Set<() => void>()
  private readonly blocks = new Map<string, Block>()
  private readonly tools = new Map<string, RemoteTool>()
  private readonly skippedMessages = new Set<string>()
  private task?: Promise<void>
  private failure?: unknown
  private ended = false
  private traced = false
  private terminal = false
  private plain = ''
  private index = 0
  private segmentCalls = 0
  private segmentContent = false

  constructor(private readonly run: RemoteRun, signal: AbortSignal) {
    this.signal = AbortSignal.any([signal, this.controller.signal])
  }
  private notify() { for (const listener of this.listeners) listener() }
  private push(chunk: StreamChunk) { this.queue.push(chunk); this.notify() }
  private fail(error: unknown) { this.failure ??= error; this.notify() }
  private start() {
    if (this.task) return
    this.task = this.run(this.signal, value => {
      if (!this.traced) this.updatePlain(value.text)
    }, record => {
      try { this.accept(record) }
      catch (error) { this.fail(error); this.controller.abort(error); throw error }
    }).then(result => {
      if (!this.traced) this.updatePlain(result.text)
      if (['TASK_STATE_FAILED', 'TASK_STATE_REJECTED', 'TASK_STATE_CANCELED'].includes(result.state)) {
        throw new Error(`远端 Agent 未完成任务：${result.state}`)
      }
      if (this.traced && !this.terminal) throw new AgUiProtocolError('远端 AG-UI 执行缺少结束事件。')
      if (!this.traced || this.segmentContent) this.endSegment('stop')
    }).catch(error => { this.fail(error) }).finally(() => { this.ended = true; this.notify() })
  }
  private updatePlain(text: string) {
    if (!text.startsWith(this.plain)) throw new AgUiProtocolError('远端替换了已显示的正文，无法继续追加。')
    const delta = text.slice(this.plain.length)
    this.plain = text
    if (delta) this.delta('plain', 'text', delta)
  }
  private open(key: string, block: ContentBlock): Block {
    if (this.blocks.has(key)) throw new AgUiProtocolError('AG-UI 消息或工具重复开始。')
    const entry = { index: this.index++, block, closed: false }
    this.blocks.set(key, entry)
    this.segmentContent = true
    this.push({ type: 'block-start', index: entry.index, blockType: block.type })
    return entry
  }
  private delta(key: string, type: 'text' | 'reasoning', text: string) {
    const entry = this.blocks.get(key) ?? this.open(key, { type, text: '' })
    if (entry.closed || entry.block.type !== type) throw new AgUiProtocolError('AG-UI 消息增量不匹配或已结束。')
    entry.block = { type, text: entry.block.text + text }
    this.push({ type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: entry.index, text })
  }
  private closeBlock(key: string) {
    const entry = this.blocks.get(key)
    if (!entry || entry.closed) return
    entry.closed = true
    this.push({ type: 'block-end', index: entry.index, block: entry.block })
  }
  private endSegment(kind: 'stop' | 'tool-calls') {
    for (const key of this.blocks.keys()) this.closeBlock(key)
    this.push({ type: 'finish', reason: { kind } })
    this.blocks.clear(); this.index = 0; this.segmentCalls = 0; this.segmentContent = false
  }
  private call(id: string): RemoteTool {
    const call = this.tools.get(id)
    if (!call) throw new AgUiProtocolError('AG-UI 工具事件缺少对应的 TOOL_CALL_START。')
    return call
  }
  private finishToolStep() {
    if (!this.segmentCalls) return
    if ([...this.blocks.values()].some(entry => entry.block.type === 'tool-call' && !entry.closed)) {
      throw new AgUiProtocolError('AG-UI 工具参数未结束。')
    }
    this.endSegment('tool-calls')
  }
  private accept({ event, runId }: AgUiRecord) {
    if (this.plain) throw new AgUiProtocolError('远端在正文输出后才开始 AG-UI，无法安全合并。')
    this.traced = true
    if ('subagentRunId' in event && event.subagentRunId) return
    switch (event.type) {
      case 'RUN_STARTED': return
      case 'TEXT_MESSAGE_START':
        if (event.role !== 'assistant') { this.skippedMessages.add(event.messageId); return }
        this.open(`text:${event.messageId}`, { type: 'text', text: '' }); return
      case 'TEXT_MESSAGE_CONTENT':
        if (!this.skippedMessages.has(event.messageId)) this.delta(`text:${event.messageId}`, 'text', event.delta)
        return
      case 'TEXT_MESSAGE_END':
        if (this.skippedMessages.has(event.messageId)) return
        this.closeBlock(`text:${event.messageId}`)
        // A completed parent message admits the recorded tool batch into DSH.
        if (this.segmentCalls && [...this.blocks.values()].every(entry => entry.closed)) this.finishToolStep()
        return
      case 'REASONING_MESSAGE_START': this.open(`reasoning:${event.messageId}`, { type: 'reasoning', text: '' }); return
      case 'REASONING_MESSAGE_CONTENT': this.delta(`reasoning:${event.messageId}`, 'reasoning', event.delta); return
      case 'REASONING_MESSAGE_END': this.closeBlock(`reasoning:${event.messageId}`); return
      case 'TOOL_CALL_START': {
        if (this.tools.has(event.toolCallId)) throw new AgUiProtocolError('AG-UI 工具标识重复。')
        const id = ToolCallId(`${runId}:${event.toolCallId}`)
        // A namespace also prevents a remote name from selecting a local tool's renderer.
        const name = `a2a.${event.toolCallName}`
        const block = this.open(`tool:${event.toolCallId}`, { type: 'tool-call', id, name, arguments: '' })
        this.tools.set(event.toolCallId, { id, name, arguments: '', block, replayed: false })
        this.segmentCalls++
        this.push({ type: 'tool-call-delta', index: block.index, id, name, argumentsDelta: '' }); return
      }
      case 'TOOL_CALL_ARGS': {
        const call = this.call(event.toolCallId)
        if (call.block.closed) throw new AgUiProtocolError('AG-UI 工具参数在结束后仍有增量。')
        call.arguments += event.delta
        call.block.block = { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments }
        this.push({ type: 'tool-call-delta', index: call.block.index, id: call.id, argumentsDelta: event.delta }); return
      }
      case 'TOOL_CALL_END': this.call(event.toolCallId); this.closeBlock(`tool:${event.toolCallId}`); return
      case 'TOOL_CALL_RESULT': {
        this.finishToolStep()
        const call = this.call(event.toolCallId)
        if (call.result !== undefined) throw new AgUiProtocolError('AG-UI 工具结果重复。')
        call.result = typeof event.content === 'string' ? event.content : JSON.stringify(event.content)
        this.notify(); return
      }
      case 'STEP_FINISHED': this.finishToolStep(); return
      case 'RUN_FINISHED':
        if (event.outcome?.type === 'cancelled') throw new Error('远端 AG-UI 执行已取消。')
        this.finishToolStep(); this.terminal = true; return
      case 'RUN_ERROR':
        this.terminal = true; this.fail(new Error(`远端 Agent 执行失败：${event.message}`)); return
      // State snapshots, activities, encrypted reasoning and subagent events have no
      // equivalent in this converter. They never become local inputs or instructions.
      default: return
    }
  }
  private async waitFor(ready: () => boolean, signal = this.signal) {
    while (!ready()) {
      signal.throwIfAborted()
      if (this.failure) throw this.failure
      await new Promise<void>(resolve => {
        const wake = () => { this.listeners.delete(wake); signal.removeEventListener('abort', wake); resolve() }
        this.listeners.add(wake)
        signal.addEventListener('abort', wake, { once: true })
        if (signal.aborted) wake()
      })
    }
  }
  /** Each native model step consumes a segment of the same remote HTTP execution. */
  async *stream(): AsyncIterable<StreamChunk> {
    this.start()
    while (true) {
      await this.waitFor(() => this.queue.length > 0 || this.ended)
      const chunk = this.queue.shift()
      if (chunk) { yield chunk; if (chunk.type === 'finish') return }
      else {
        if (this.failure) throw this.failure
        // A tools-only remote run may finish immediately after its final result.
        yield { type: 'finish', reason: { kind: 'stop' } }; return
      }
    }
  }
  /** Records remote results using native events. This method cannot dispatch local work. */
  async replayTools(input: ToolBatchInput): Promise<ToolBatchResult> {
    const results: ToolBatchResult['results'][number][] = []
    try {
      if (!input.agent || !input.log) throw new Error('远端工具记录缺少所属会话。')
      const { session } = input.agent
      for (const block of input.calls) {
        const call = [...this.tools.values()].find(call => call.id === block.id)
        if (!call || call.replayed || call.name !== block.name || call.arguments !== block.arguments) {
          throw new AgUiProtocolError('仅允许记录本次远端执行已声明的工具调用。')
        }
        call.replayed = true
        const seq = session.append('tool/call', { ...input.log, callId: call.id, name: call.name, arguments: call.arguments }).seq
        await this.waitFor(() => call.result !== undefined || this.ended, input.signal)
        if (call.result === undefined) throw this.failure ?? new Error('远端结束时未提供工具执行结果。')
        const result: ToolExecutionResult = { content: [{ type: 'text', text: call.result }], isError: false, value: call.result }
        session.append('tool/result', { ...input.log,
          message: createToolResultMessage({ callId: call.id, content: result.content, isError: result.isError }),
        }, { surfaceOp: 'append', sourceEventSeqs: [seq] })
        results.push({ callId: call.id, result })
      }
      // Wait for the next model segment or the terminal outcome, avoiding an empty
      // native assistant step after a remote tools-only run.
      await this.waitFor(() => this.queue.length > 0 || this.ended, input.signal)
      if (this.failure) throw this.failure
      return { results, additionalContexts: [], concluded: this.ended && !this.queue.length }
    } catch (error) {
      throw new ToolBatchExecutionError(error, { results, additionalContexts: [], concluded: false })
    }
  }
  async close() { this.controller.abort(); await this.task }
}
