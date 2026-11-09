import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as plugin from '../src/plugin.js'

const file = process.env.DSH_A2A_CONFIG ?? './a2a.config.json'
const agentName = process.env.A2A_AGENT_NAME?.trim()
const message = process.env.A2A_MESSAGE?.trim()
if (!agentName || !message) throw new Error('Set A2A_AGENT_NAME and A2A_MESSAGE before running the verification.')
const ctx = new Context()
try {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(NativeExecutor)
  await ctx.plugin(plugin, { configFile: file })
  const execute = async (name: string, args: unknown) => (await ctx.tools.execute({
    calls: [{ type: 'tool-call', name, arguments: JSON.stringify(args), id: ToolCallId(crypto.randomUUID()) }],
    signal: AbortSignal.timeout(180000),
  })).results[0].result
  const list = await execute('a2a_list_agents', {})
  if (list.isError) throw new Error(JSON.stringify(list.content))
  const agents = list.value as { name: string }[]
  console.log('DSH 已加载 A2A 插件；可发现的 Agent:', agents.map(a => a.name))
  if (!agents.some(a => a.name === agentName)) throw new Error('The configured Agent was not discovered.')
  const answer = await execute('a2a_send_message', { agent: agentName, message })
  if (answer.isError) throw new Error(JSON.stringify(answer.content))
  const result = answer.value as { state: string; text: string }
  if (result.state !== 'TASK_STATE_COMPLETED' || !result.text.trim()) throw new Error('Unexpected A2A result')
  console.log(`PASS: DSH 原生工具 → Agent 发现 → A2A 调用完成（${result.text.length} 字符）。`)
} finally { await ctx.fiber.dispose() }
