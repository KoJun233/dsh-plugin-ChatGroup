import { randomUUID } from 'node:crypto'
import type { Request, Response } from 'express'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { createA2AServer, type Principal } from './server.js'
import { loadConfig, nacosSources, type AgentRole } from './config.js'
import { NacosRegistry } from './nacos.js'

export const name = 'a2a-server'
export const inject = ['agents', 'tools', 'webServer']
export interface Config {
  name: string; description: string; role: AgentRole; publicUrl: string
  provider: string; model: string; allowedTools: string[]; principals: Principal[]; timeoutMs: number
  registryConfigFile?: string
}
const role = z.enum(['personal', 'business'])
export const Config = z.object({
  name: z.string().default('dsh-personal'), description: z.string().default('个人 DSH 助理'),
  role: role.default('personal'), publicUrl: z.string(),
  provider: z.string().default('deepseek-official'), model: z.string().default('deepseek-v4-flash'),
  allowedTools: z.array(z.string()).default([]),
  principals: z.array(z.object({ id: z.string(), role, tokenEnv: z.string() })),
  timeoutMs: z.number().min(1000).max(600000).default(60000),
  registryConfigFile: z.string().optional(),
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  const server = createA2AServer(config, async (text, signal, emitText) => {
    const handle = await ctx.agents.create({
      sessionId: randomUUID() as Parameters<typeof ctx.agents.create>[0]['sessionId'],
      agentOptions: { provider: config.provider, model: config.model }, signal,
      setup: scoped => { scoped.tools.restrict({ allow: config.allowedTools }) },
    })
    const agent = handle.agent
    let failure: unknown
    const off = ctx.on('agent/error', payload => { if (payload.agent.id === agent.id) failure = payload.error })
    const offStream = ctx.on('agent/assistant-stream', ({ agent: source, frame }) => {
      if (source.id === agent.id && frame.type === 'chunk' && frame.chunk.type === 'text-delta' && !signal.aborted) {
        emitText(frame.chunk.text)
      }
    })
    const cancel = () => agent.cancel({ kind: 'user' })
    signal.addEventListener('abort', cancel, { once: true })
    try {
      signal.throwIfAborted()
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }], source: { kind: 'user' },
      }))
      await agent.whenIdle()
      signal.throwIfAborted()
      if (failure) throw failure
      const message = agent.session.deriveMessages().findLast(m => m.role === 'assistant')
      const answer = message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      if (!answer) throw new Error('DSH produced no assistant text')
      return answer
    } finally {
      signal.removeEventListener('abort', cancel)
      off()
      offStream()
      await handle.dispose()
    }
  })
  for (const path of ['/a2a', '/.well-known/agent-card.json']) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path,
      handler: (req, res) => { server.app(req as Request, res as Response) },
    }))
  }
  ctx.effect(() => () => server.dispose())
  if (config.registryConfigFile) {
    const sources = nacosSources(await loadConfig(config.registryConfigFile)).filter(source => source.enabled !== false)
    if (!sources.length) throw new Error('registryConfigFile must contain an enabled Nacos registry')
    for (const source of sources) {
      const deregister = await new NacosRegistry(source).register({
        name: config.name, role: config.role, description: config.description,
        cardUrl: `${new URL(config.publicUrl).origin}/.well-known/agent-card.json`,
      }, server.card)
      try { ctx.effect(() => deregister) } catch (error) { await deregister(); throw error }
    }
  }
}
