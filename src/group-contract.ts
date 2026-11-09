import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { TypertRemoteMethodSpec } from '@deepseek-ai/dsh-typert-protocol'

export const MemberSelection = z.object({ kind: z.enum(['local', 'remote']), id: z.string().min(1).max(200) }).strict()
export type MemberSelection = z.infer<typeof MemberSelection>
const sessionId = z.string().min(1).max(200)
const codec = (schema: z.ZodType, typeSymbol: string) => ({ mode: 'strict' as const, typeSymbol, create: () => schema })
const parameter = (name: string, schema: z.ZodType) => ({ name, source: 'json' as const,
  codec: codec(schema, `dsh-a2a/${name}`), strictCodec: codec(schema, `dsh-a2a/${name}`) })
const agentParameter = { name: 'agent', wire: 'agentId', source: 'lookup' as const, lookup: 'agent',
  codec: codec(sessionId, '@deepseek-ai/dsh-session/types#SessionId'),
  strictCodec: codec(sessionId, '@deepseek-ai/dsh-session/types#SessionId') }
const method = (parameters: TypertRemoteMethodSpec['parameters']): TypertRemoteMethodSpec => ({
  service: 'a2aGroup', invocation: { kind: 'direct' }, parameters,
  result: codec(z.json(), 'dsh-a2a/result'), cancellation: { parameter: 'signal' },
})
export const groupRemote = createTypertRemoteInfo({ package: 'dsh-a2a', methods: {
  'a2aGroup/state': method([agentParameter]),
  'a2aGroup/cancel': method([agentParameter]),
  'a2aGroup/members': method([agentParameter]),
  'a2aGroup/addMember': method([agentParameter, parameter('selection', MemberSelection)]),
  'a2aGroup/removeMember': method([agentParameter, parameter('id', sessionId)]),
} }, z)
export const groupHost = { package: groupRemote.package, face: 'host' as const, schemas: [],
  invocations: groupRemote.descriptors, model: { services: [], events: [], objects: [] } }
