import { NacosRegistry } from '../src/nacos.js'
import { httpUrl } from '../src/config.js'

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
httpUrl(serverUrl)
httpUrl(cardUrl)

const stop = await new NacosRegistry({
  serverUrl,
  namespaceId: process.env.NACOS_NAMESPACE_ID,
  groupName: process.env.NACOS_GROUP_NAME,
  servicePrefix: process.env.NACOS_SERVICE_PREFIX,
  accessTokenEnv: process.env.NACOS_ACCESS_TOKEN ? 'NACOS_ACCESS_TOKEN' : undefined,
}).register({ name, role, cardUrl, description: process.env.A2A_AGENT_DESCRIPTION ?? '' })

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
