import { randomUUID } from 'node:crypto'
import { Artifact, Message, Role, Task, TaskState, TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from '@a2a-js/sdk'
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from '@a2a-js/sdk/server'
import { partsText } from './client.js'

export type Runner = (text: string, signal: AbortSignal, emitText: (delta: string) => void) => Promise<string>
interface RunningTask { controller: AbortController; contextId: string; done: Promise<void>; cancelled: boolean; bus: ExecutionEventBus }

/** One incoming task owns one execution. No client can pick a local DSH session. */
export class TextExecutor implements AgentExecutor {
  private readonly running = new Map<string, RunningTask>()
  private closing = false
  constructor(private readonly runner: Runner, private readonly timeoutMs = 60000) {}

  async execute(request: RequestContext, bus: ExecutionEventBus): Promise<void> {
    if (this.closing) throw new Error('Agent is shutting down')
    const text = partsText(request.userMessage.parts)
    if (!text.trim() || request.userMessage.parts.some(p => p.content?.$case !== 'text')) {
      throw new Error('This Agent accepts nonempty text messages only')
    }
    const { taskId, contextId } = request
    const controller = new AbortController()
    let settled!: () => void
    const done = new Promise<void>(resolve => { settled = resolve })
    const entry: RunningTask = { controller, contextId, done, cancelled: false, bus }
    this.running.set(taskId, entry)
    bus.publish(AgentEvent.task(Task.fromJSON({
      id: taskId, contextId, history: [Message.toJSON(request.userMessage)],
      status: { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString() },
    })))
    const timer = setTimeout(() => controller.abort(new Error('Task execution timed out')), this.timeoutMs)
    const artifactId = randomUUID()
    let emitted = false
    const publishText = (text: string, lastChunk: boolean, append: boolean) => {
      bus.publish(AgentEvent.artifactUpdate(TaskArtifactUpdateEvent.fromJSON({
        taskId, contextId, artifact: Artifact.toJSON(Artifact.fromJSON({
          artifactId, name: 'answer', parts: [{ text, mediaType: 'text/plain' }],
        })), append, lastChunk,
      })))
    }
    try {
      const answer = await this.runner(text, controller.signal, delta => {
        controller.signal.throwIfAborted()
        if (!delta) return
        publishText(delta, false, emitted)
        emitted = true
      })
      controller.signal.throwIfAborted()
      // Final replacement reconciles streamed previews with the authoritative answer.
      publishText(answer, true, false)
      this.status(bus, taskId, contextId, TaskState.TASK_STATE_COMPLETED)
    } catch (error) {
      this.status(bus, taskId, contextId,
        entry.cancelled ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED,
        error instanceof Error ? error.message : 'Execution failed')
    } finally {
      clearTimeout(timer)
      this.running.delete(taskId)
      settled()
    }
  }

  private status(bus: ExecutionEventBus, taskId: string, contextId: string, state: TaskState, text?: string): void {
    bus.publish(AgentEvent.statusUpdate(TaskStatusUpdateEvent.fromJSON({
      taskId, contextId, status: {
        state, timestamp: new Date().toISOString(),
        message: text ? { messageId: randomUUID(), role: Role.ROLE_AGENT, taskId, contextId, parts: [{ text }] } : undefined,
      },
    })))
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    const entry = this.running.get(taskId)
    if (!entry) throw new Error('Task is no longer running')
    entry.cancelled = true
    entry.controller.abort(new Error('Task canceled'))
    await entry.done
    if (bus !== entry.bus) this.status(bus, taskId, entry.contextId, TaskState.TASK_STATE_CANCELED)
  }

  async dispose(): Promise<void> {
    this.closing = true
    const entries = [...this.running.values()]
    for (const entry of entries) entry.controller.abort(new Error('Agent shutting down'))
    await Promise.all(entries.map(entry => entry.done))
  }
}
