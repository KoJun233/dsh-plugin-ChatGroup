import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { TypertRemoteMethodSpec } from '@deepseek-ai/dsh-typert-protocol'

const tokenEnv = z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '请填写保存 Token 的环境变量名。').optional()
export const CardProbe = z.object({
  cardUrl: z.string().trim().min(1, '请填写 Agent Card 地址。').max(2048).superRefine((value, ctx) => {
    try {
      const url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('url')
    } catch { ctx.addIssue({ code: 'custom', message: '请输入 HTTP(S) Agent Card 地址，不包含账号密码或片段。' }) }
  }),
  tokenEnv,
})
export const DirectAgentSettings = CardProbe.extend({
  name: z.string().trim().min(1, '请填写 Agent 名称。').max(200),
  role: z.enum(['personal', 'business']),
  enabled: z.boolean().optional(),
  description: z.string().trim().max(4000).optional(),
})
const directAgents = z.array(DirectAgentSettings).max(100).superRefine((agents, ctx) => {
  const names = new Set<string>()
  for (const [index, agent] of agents.entries()) {
    if (names.has(agent.name)) ctx.addIssue({ code: 'custom', path: [index, 'name'], message: `Agent 名称重复：${agent.name}` })
    names.add(agent.name)
  }
})

export const NacosSettings = z.object({
  serverUrl: z.string().trim().min(1).max(2048).superRefine((value, ctx) => {
    try {
      const url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('url')
    } catch { ctx.addIssue({ code: 'custom', message: '请输入 HTTP(S) 注册中心地址，不包含账号密码、查询参数或片段。' }) }
  }),
  namespaceId: z.string().trim().max(200).default('public'),
  accessTokenEnv: tokenEnv,
})

export const NacosSourceSettings = NacosSettings.extend({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, '注册中心标识无效。'),
  name: z.string().trim().min(1, '请填写注册中心名称。').max(100),
  enabled: z.boolean().optional(),
})
const nacosRegistries = z.array(NacosSourceSettings).max(20).superRefine((sources, ctx) => {
  const ids = new Set<string>(), names = new Set<string>()
  for (const [index, source] of sources.entries()) {
    if (ids.has(source.id)) ctx.addIssue({ code: 'custom', path: [index, 'id'], message: '注册中心标识重复。' })
    if (names.has(source.name)) ctx.addIssue({ code: 'custom', path: [index, 'name'], message: `注册中心名称重复：${source.name}` })
    ids.add(source.id); names.add(source.name)
  }
})
export const RegistryDraft = z.object({
  // The singleton is accepted for older clients; new clients submit the complete source list.
  nacos: NacosSettings.nullable().optional(),
  nacosRegistries: nacosRegistries.optional(),
  agents: directAgents.optional(),
}).strict()
export const RegistryUpdate = RegistryDraft.extend({ revision: z.string().min(1).max(100) })
const codec = (schema: z.ZodType, typeSymbol: string) => ({ mode: 'strict' as const, typeSymbol, create: () => schema })
const method = (schema?: z.ZodType): TypertRemoteMethodSpec => ({
  service: 'a2aRegistry', invocation: { kind: 'direct' },
  parameters: schema ? [{ name: 'input', source: 'json', codec: codec(schema, 'dsh-a2a/registry-input'), strictCodec: codec(schema, 'dsh-a2a/registry-input') }] : [],
  result: codec(z.json(), 'dsh-a2a/registry-result'), cancellation: { parameter: 'signal' },
})
export const registryRemote = createTypertRemoteInfo({ package: 'dsh-a2a/registry', methods: {
  'a2aRegistry/configuration': method(),
  'a2aRegistry/save': method(RegistryUpdate),
  'a2aRegistry/inspect': method(RegistryDraft),
  'a2aRegistry/inspectCard': method(CardProbe),
  'a2aRegistry/inspectRegistry': method(NacosSettings),
} }, z)
export const registryHost = { package: registryRemote.package, face: 'host' as const, schemas: [],
  invocations: registryRemote.descriptors, model: { services: [], events: [], objects: [] } }
