import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { TypertRemoteMethodSpec } from '@deepseek-ai/dsh-typert-protocol'

export const NacosSettings = z.object({
  serverUrl: z.string().trim().min(1).max(2048).superRefine((value, ctx) => {
    try {
      const url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('url')
    } catch { ctx.addIssue({ code: 'custom', message: '请输入 HTTP(S) 注册中心地址，不包含账号密码、查询参数或片段。' }) }
  }),
  registry: z.enum(['agent', 'naming']).default('agent'),
  namespaceId: z.string().trim().max(200).default('public'),
  groupName: z.string().trim().max(200).default('DSH_A2A'),
  servicePrefix: z.string().trim().max(200).default('a2a.'),
  accessTokenEnv: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '请填写保存 Token 的环境变量名。').optional(),
})

export const RegistryDraft = z.object({ nacos: NacosSettings.nullable() }).strict()
export const RegistryUpdate = RegistryDraft.extend({ revision: z.string().min(1).max(100) }).strict()
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
} }, z)
export const registryHost = { package: registryRemote.package, face: 'host' as const, schemas: [],
  invocations: registryRemote.descriptors, model: { services: [], events: [], objects: [] } }
