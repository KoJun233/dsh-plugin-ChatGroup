import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { AgentCard } from '@a2a-js/sdk'

export type AgentRole = 'personal' | 'business'
export interface AgentEntry {
  name: string
  role: AgentRole
  description?: string
  cardUrl: string
  tokenEnv?: string
  /** In-memory Card returned by native Agent Registry, never a credential. */
  registryCard?: AgentCard
}
export interface NacosConfig {
  serverUrl: string
  registry?: 'agent' | 'naming'
  namespaceId?: string
  groupName?: string
  servicePrefix?: string
  accessTokenEnv?: string
}
export interface A2AConfig {
  role: AgentRole
  timeoutMs: number
  pollIntervalMs: number
  agents: AgentEntry[]
  nacos?: NacosConfig
}

const role = z.enum(['personal', 'business'])
export const FileConfig = z.object({
  role: role.default('personal'),
  timeoutMs: z.number().min(100).max(600000).default(60000),
  pollIntervalMs: z.number().min(50).max(30000).default(500),
  agents: z.array(z.object({
    name: z.string(), role,
    description: z.string().optional(), cardUrl: z.string(), tokenEnv: z.string().optional(),
  })).default([]),
  nacos: z.object({
    serverUrl: z.string(), registry: z.enum(['agent', 'naming']).default('agent'),
    namespaceId: z.string().default('public'),
    groupName: z.string().default('DSH_A2A'),
    servicePrefix: z.string().default('a2a.'), accessTokenEnv: z.string().optional(),
  }).optional(),
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
  const result = await FileConfig['~standard'].validate(value)
  if (result.issues) throw new Error(`Invalid A2A configuration: ${JSON.stringify(result.issues)}`)
  const config = result.value as A2AConfig
  const names = new Set<string>()
  for (const agent of config.agents) {
    httpUrl(agent.cardUrl)
    if (!agent.name.trim() || names.has(agent.name)) throw new Error(`Duplicate/empty Agent name: ${agent.name}`)
    names.add(agent.name)
  }
  if (config.nacos) httpUrl(config.nacos.serverUrl)
  return config
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
