import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GroupRuntime } from './group-runtime.js'
import { memberDelegationTool } from './group-contract.js'

export { memberDelegationTool } from './group-contract.js'

/** Model-facing dispatch only. The normal room handoff owns execution after turn/end. */
export function registerMemberDelegation(ctx: Context, runtime: GroupRuntime) {
  ctx.on('tools/result', (exec, result) => {
    if (exec.agent) runtime.confirmDelegation(exec.agent, exec.callId, !result.isError && result.concludesTurn === true)
    return undefined
  })
  return ctx.tools.register(defineTool({
    name: memberDelegationTool,
    description: '把本轮具体任务交给当前会话已加入的一个成员。memberId 必须使用会话成员资料中的 ID。仅发送完成任务所需信息，不发密钥或整段聊天。等待成员用自己的身份直接回复，不代为转述。',
    parameters: {
      memberId: { type: 'string', required: true, description: '当前会话的稳定成员 ID，不是显示名。' },
      task: { type: 'string', required: true, description: '本次转派的具体任务。' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute({ memberId, task }, exec) {
      if (!exec.agent) throw new Error('转派工具只能由当前会话的顾问执行。')
      exec.signal.throwIfAborted()
      const queued = runtime.queueDelegation(exec.agent, memberId, task, exec.callId, exec.rootCallId)
      exec.concludeTurn()
      return queued
    },
  }), { when: ({ agent }) => runtime.room(agent.session).members.length > 0 })
}
