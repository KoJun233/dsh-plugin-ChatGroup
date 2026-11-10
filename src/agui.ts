import { EventSchema } from '@ag-ui/core/schemas'
import type { Artifact } from '@a2a-js/sdk'

/** Optional project binding: AG-UI event bodies in A2A artifact DataParts. */
export const AGUI_EXTENSION = 'urn:raycloud:a2a:ag-ui:v1'
export type AgUiEvent = ReturnType<typeof EventSchema.parse>
export interface AgUiRecord {
  event: AgUiEvent
  runId: string
  threadId: string
  sequence: number
}
export class AgUiProtocolError extends Error {}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Validates the negotiated artifact, detects gaps and deduplicates Task snapshot replays. */
export class AgUiTraceReader {
  private runId?: string
  private threadId?: string
  private sequence = 0
  private terminal = false
  get observed(): boolean { return this.sequence > 0 }

  read(artifact: Artifact): AgUiRecord[] {
    if (artifact.name !== 'ag-ui.events') return []
    if (artifact.metadata?.extension !== AGUI_EXTENSION) throw new AgUiProtocolError('AG-UI 产物缺少匹配的扩展标识。')
    const records: AgUiRecord[] = []
    for (const part of artifact.parts) {
      const meta = object(part.metadata?.[AGUI_EXTENSION])
      if (part.content?.$case !== 'data' || !meta || meta.schemaVersion !== 1
        || !Number.isSafeInteger(meta.sequence) || Number(meta.sequence) < 1
        || typeof meta.runId !== 'string' || !meta.runId || typeof meta.threadId !== 'string' || !meta.threadId) {
        throw new AgUiProtocolError('AG-UI 事件或扩展元数据无效。')
      }
      if (this.runId && (meta.runId !== this.runId || meta.threadId !== this.threadId)) throw new AgUiProtocolError('AG-UI 运行或上下文标识不一致。')
      const sequence = Number(meta.sequence)
      if (sequence <= this.sequence) continue
      if (sequence !== this.sequence + 1) throw new AgUiProtocolError(`AG-UI 事件缺失：期望序号 ${this.sequence + 1}，收到 ${sequence}。`)
      const parsed = EventSchema.safeParse(part.content.value)
      if (!parsed.success) throw new AgUiProtocolError('AG-UI 事件未通过官方 schema 校验。')
      const event = parsed.data
      if (!this.observed && event.type !== 'RUN_STARTED') throw new AgUiProtocolError('AG-UI 首事件不是 RUN_STARTED。')
      if (this.terminal) throw new AgUiProtocolError('AG-UI 运行结束后仍有新事件。')
      if (event.type === 'RUN_STARTED' || event.type === 'RUN_FINISHED') {
        if (event.runId !== meta.runId || event.threadId !== meta.threadId) throw new AgUiProtocolError('AG-UI 事件和扩展元数据的运行标识不一致。')
        if (event.type === 'RUN_STARTED' && this.observed) throw new AgUiProtocolError('AG-UI 重复开始运行。')
      }
      this.runId = meta.runId
      this.threadId = meta.threadId
      this.sequence = sequence
      this.terminal = event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR'
      records.push({ event, runId: this.runId, threadId: this.threadId, sequence })
    }
    return records
  }

  assertEnded(): void {
    if (this.observed && !this.terminal) throw new AgUiProtocolError('AG-UI 流中断，未收到 RUN_FINISHED 或 RUN_ERROR。')
  }
}
