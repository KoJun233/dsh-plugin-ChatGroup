import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { AgentCard } from '@a2a-js/sdk'

export type AgentRole = 'personal' | 'business'
export interface AgentEntry {
  /** Stable source-qualified identity; display names may overlap across sources. */
  id?: string
  displayName?: string
  source?: { id: string; name: string; kind: 'nacos' | 'direct' }
  enabled?: boolean
  name: string
  role: AgentRole
  description?: string
  cardUrl: string
  tokenEnv?: string
  /** In-memory Card returned by native Agent Registry, never a credential. */
  registryCard?: AgentCard
  /** Display-only registry metadata; calls still resolve the original source Card. */
  registryInfo?: {
    version: string
    streaming: boolean
    interfaces: { url: string; protocolBinding: string; protocolVersion: string }[]
    skills: { id: string; name: string; description: string; tags: string[] }[]
  }
}
export interface NacosConfig {
  serverUrl: string
  namespaceId?: string
  accessTokenEnv?: string
}
export interface NacosSource extends NacosConfig {
  id: string
  name: string
  enabled?: boolean
}
export interface A2AConfig {
  role: AgentRole
  timeoutMs: number
  pollIntervalMs: number
  agents: AgentEntry[]
  nacos?: NacosConfig
  nacosRegistries?: NacosSource[]
}

const role = z.enum(['personal', 'business'])
const nacosConfig = z.object({
  serverUrl: z.string(), namespaceId: z.string().default('public'), accessTokenEnv: z.string().optional(),
})
export const FileConfig = z.object({
  role: role.default('personal'),
  timeoutMs: z.number().min(100).max(600000).default(60000),
  pollIntervalMs: z.number().min(50).max(30000).default(500),
  agents: z.array(z.object({
    name: z.string(), role,
    enabled: z.boolean().optional(),
    description: z.string().optional(), cardUrl: z.string(), tokenEnv: z.string().optional(),
  })).default([]),
  nacos: nacosConfig.optional(),
  nacosRegistries: z.array(nacosConfig.extend({ id: z.string(), name: z.string(), enabled: z.boolean().optional() })).optional(),
})

export function httpUrl(value: string): URL {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Agent and Nacos URLs must use HTTP(S) without embedded credentials')
  }
  return url
}

export async function loadConfig(path: string): Promise<A2AConfig> {
  const value: unknown = JSON.parse(await readFile(resolve(path), 'utf8'))
  return parseConfig(value)
}

export function parseConfig(value: unknown): A2AConfig {
  const result = FileConfig.safeParse(value)
  if (!result.success) throw new Error(`Invalid A2A configuration: ${JSON.stringify(result.error.issues)}`)
  const config = result.data as A2AConfig
  const names = new Set<string>()
  for (const agent of config.agents) {
    httpUrl(agent.cardUrl)
    if (!agent.name.trim() || names.has(agent.name)) throw new Error(`Duplicate/empty Agent name: ${agent.name}`)
    names.add(agent.name)
  }
  if (config.nacos) httpUrl(config.nacos.serverUrl)
  const ids = new Set<string>(), sourceNames = new Set<string>()
  for (const source of nacosSources(config)) {
    httpUrl(source.serverUrl)
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(source.id) || !source.name.trim() || ids.has(source.id) || sourceNames.has(source.name)) throw new Error('Duplicate/empty Nacos source identity or name')
    ids.add(source.id); sourceNames.add(source.name)
  }
  return config
}

/** An explicit list supersedes the legacy singleton, including an empty list. */
export function nacosSources(config: Pick<A2AConfig, 'nacos' | 'nacosRegistries'>): NacosSource[] {
  return config.nacosRegistries ?? (config.nacos ? [{ ...config.nacos, id: 'legacy', name: 'Nacos 注册中心' }] : [])
}

export function agentIdentity(kind: 'direct' | 'nacos', sourceId: string, name: string): string {
  const prefix = kind === 'direct' ? 'direct:' : `nacos:${sourceId}:`
  const encoded = encodeURIComponent(name)
  return prefix + (prefix.length + encoded.length <= 180 ? encoded : createHash('sha256').update(name).digest('hex'))
}

export function envSecret(name?: string): string | undefined {
  if (!name) return undefined
  const value = process.env[name]
  if (!value) throw new Error(`Required environment variable is missing: ${name}`)
  return value
}

export function canCall(from: AgentRole, to: AgentRole): boolean {
  return from === 'personal' || to === 'business'
}
