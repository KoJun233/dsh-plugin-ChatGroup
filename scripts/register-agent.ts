import { parseArgs } from 'node:util'
import { httpUrl, loadConfig, nacosSources } from '../src/config.js'
import { NacosRegistry } from '../src/nacos.js'

const { values } = parseArgs({ options: {
  config: { type: 'string', default: process.env.DSH_A2A_CONFIG ?? './a2a.config.json' },
  name: { type: 'string' },
  'card-url': { type: 'string' },
  role: { type: 'string', default: 'business' },
  registry: { type: 'string' },
} })
if (!values.name?.trim() || !values['card-url'] || !['personal', 'business'].includes(values.role!)) {
  throw new Error('用法：npm run register:agent -- --name backend --card-url http://127.0.0.1:8080/a2a/back/card.json [--config ./a2a.config.json] [--role business]')
}
const config = await loadConfig(values.config!)
const sources = nacosSources(config).filter(source => source.enabled !== false)
const source = values.registry ? sources.find(source => source.id === values.registry || source.name === values.registry)
  : sources.length === 1 ? sources[0] : undefined
if (!source) throw new Error('请配置启用的 Nacos 注册中心；存在多个时使用 --registry 指定注册中心 id 或名称。')
const cardUrl = httpUrl(values['card-url']).href
const registry = new NacosRegistry(source)
const entry = { name: values.name, cardUrl, role: values.role as 'business' | 'personal' }
const result = await registry.publish(entry)
console.log(`已发布 Agent ${result.name}（${result.version}）到 ${source.name}；namespace=${source.namespaceId || 'public'}。注册信息持久保存，无需保持此进程运行。`)
