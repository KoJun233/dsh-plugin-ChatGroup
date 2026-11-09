import { appendPluginRecord, type Session } from '@deepseek-ai/dsh-session'
import type { CallResult } from './client.js'

export interface ProgressRecord extends CallResult {
  callId: string
  done: boolean
  revision: number
}
declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap { 'plugin:dsh-a2a/progress': ProgressRecord }
}

/** Native Session publication supplies authenticated live updates and history replay. */
export function progressWriter(session: Session | undefined, callId: string, agent: string) {
  let latest: CallResult = { agent, contextId: '', state: 'CONNECTING', text: '' }
  let timer: ReturnType<typeof setTimeout> | undefined
  let revision = 0
  let closed = false
  let detached = false
  const publish = (done: boolean) => {
    if (!session || detached) return
    try {
      appendPluginRecord(session, 'plugin:dsh-a2a/progress', {
        callId, agent: latest.agent, contextId: latest.contextId, taskId: latest.taskId ?? '',
        state: latest.state, text: latest.text, done, revision: ++revision,
      })
    } catch {
      // Session closure must never crash an in-flight remote call or its timer.
      detached = true
    }
  }
  publish(false)
  return {
    update(result: CallResult) {
      if (closed) return
      latest = result
      if (session && !detached && !timer) timer = setTimeout(() => { timer = undefined; publish(false) }, 200)
    },
    finish(result?: CallResult) {
      if (closed) return
      closed = true
      clearTimeout(timer)
      if (result) latest = result
      else latest = { ...latest, state: 'TASK_STATE_FAILED' }
      publish(true)
    },
  }
}
