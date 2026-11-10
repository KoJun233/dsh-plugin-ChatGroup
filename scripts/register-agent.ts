import { NacosRegistry } from '../src/nacos.js'
import { httpUrl, type AgentEntry } from '../src/config.js'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Required environment variable is missing: ${name}`)
  return value
}

const serverUrl = required('NACOS_URL')
const name = required('A2A_AGENT_NAME')
const cardUrl = required('A2A_AGENT_CARD_URL')
const role = process.env.A2A_AGENT_ROLE ?? 'business'
if (role !== 'personal' && role !== 'business') throw new Error('A2A_AGENT_ROLE must be personal or business.')
const registryMode = process.env.NACOS_REGISTRY ?? 'agent'
if (registryMode !== 'agent' && registryMode !== 'naming') throw new Error('NACOS_REGISTRY must be agent or naming.')
httpUrl(serverUrl)
httpUrl(cardUrl)

const registry = new NacosRegistry({
  serverUrl,
  registry: registryMode,
  namespaceId: process.env.NACOS_NAMESPACE_ID,
  groupName: process.env.NACOS_GROUP_NAME,
  servicePrefix: process.env.NACOS_SERVICE_PREFIX,
  accessTokenEnv: process.env.NACOS_ACCESS_TOKEN ? 'NACOS_ACCESS_TOKEN' : undefined,
})
const entry: AgentEntry = { name, role, cardUrl, description: process.env.A2A_AGENT_DESCRIPTION }

if (registryMode === 'agent') {
  const result = await registry.publish(entry)
  console.log(`已发布 Agent ${result.name}（${result.version}）到 Nacos Agent Registry，无需保持注册进程运行。`)
} else {
  const stop = await registry.register(entry)

  console.log('Agent 已注册，保持此进程运行以发送心跳。')
  const hold = setInterval(() => {}, 60000)
  let stopping = false
  async function shutdown() {
    if (stopping) return
    stopping = true
    clearInterval(hold)
    try { await stop() } catch { console.error('Agent 注销失败，请检查 Nacos 中的实例状态。'); process.exitCode = 1 }
  }
  process.once('SIGINT', () => { void shutdown() })
  process.once('SIGTERM', () => { void shutdown() })
}
