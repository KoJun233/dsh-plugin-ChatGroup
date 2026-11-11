import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService, type TypertRegistryContract } from '@deepseek-ai/dsh-typert-protocol'
import type { z } from 'zod'
import { A2AClient } from './client.js'
import { agentIdentity, canCall, nacosSources, parseConfig } from './config.js'
import { NacosRegistry } from './nacos.js'
import { CardProbe, NacosSettings, RegistryDraft, RegistryUpdate, registryHost } from './registry-contract.js'

/** Owns discovery settings while preserving unrelated configuration fields. */
export class RegistrySettings {
  readonly path: string
  private writes: Promise<unknown> = Promise.resolve()
  constructor(path: string, private readonly client: A2AClient) { this.path = resolve(path) }

  private async document() {
    let text = ''
    try { text = await readFile(this.path, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const raw: unknown = text ? JSON.parse(text) : {}
    const config = parseConfig(raw)
    return { raw: raw as Record<string, unknown>, config, revision: createHash('sha256').update(text).digest('hex') }
  }

  private snapshot(document: Awaited<ReturnType<RegistrySettings['document']>>) {
    const { config, revision, raw } = document
    return { nacos: config.nacos ?? null, nacosRegistries: nacosSources(config), agents: config.agents, revision, configFile: this.path,
      legacyNaming: (raw.nacos as Record<string, unknown> | undefined)?.registry === 'naming' }
  }

  configuration(signal?: AbortSignal) {
    const operation = this.writes.then(async () => {
      const document = await this.document()
      signal?.throwIfAborted()
      this.client.reconfigure(document.config)
      return this.snapshot(document)
    })
    this.writes = operation.catch(() => {})
    return operation
  }

  save(input: z.infer<typeof RegistryUpdate>, signal?: AbortSignal) {
    const operation = this.writes.then(async () => {
      const update = RegistryUpdate.parse(input)
      signal?.throwIfAborted()
      const current = await this.document()
      if (current.revision !== update.revision) throw new Error('配置已被其他窗口或配置文件修改，请重新加载后再保存。')
      const raw = { ...current.raw }
      const cleanNacos = (previous: Record<string, unknown>, next: object) => {
        for (const key of ['accessTokenEnv', 'registry', 'groupName', 'servicePrefix']) delete previous[key]
        return { ...previous, ...next }
      }
      delete raw.discoveryMode
      if (update.nacosRegistries) {
        const previous = new Map(nacosSources(current.config).map(source => [source.id, source]))
        const rawSources = Array.isArray(current.raw.nacosRegistries) ? current.raw.nacosRegistries : []
        raw.nacosRegistries = update.nacosRegistries.map(source => cleanNacos({
          ...previous.get(source.id),
          ...(source.id === 'legacy' ? current.raw.nacos as object : {}),
          ...rawSources.find(item => item.id === source.id),
        }, source))
        delete raw.nacos
      } else if (update.nacos !== undefined) {
        if (update.nacos) raw.nacos = cleanNacos({ ...(current.raw.nacos as Record<string, unknown> | undefined) }, update.nacos)
        else delete raw.nacos
      }
      if (update.agents) {
        const existing = new Map((Array.isArray(current.raw.agents) ? current.raw.agents : []).map(agent => [agent.name, agent]))
        raw.agents = update.agents.map(agent => {
          const previous = { ...existing.get(agent.name) }
          delete previous.tokenEnv
          delete previous.description
          return { ...previous, ...agent }
        })
      }
      const config = parseConfig(raw)
      const text = JSON.stringify(raw, null, 2) + '\n'
      const temporary = `${this.path}.${randomUUID()}.tmp`
      await mkdir(dirname(this.path), { recursive: true })
      try {
        await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        signal?.throwIfAborted()
        // Catch edits made while the temporary file was being written.
        if ((await this.document()).revision !== current.revision) throw new Error('配置已修改，请重新加载后再保存。')
        await rename(temporary, this.path)
      } finally { await unlink(temporary).catch(() => {}) }
      // A committed save always updates discovery, even if the caller disconnects.
      this.client.reconfigure(config)
      return this.snapshot({ raw, config, revision: createHash('sha256').update(text).digest('hex') })
    })
    this.writes = operation.catch(() => {})
    return operation
  }

  async inspect(input: z.infer<typeof RegistryDraft>, signal?: AbortSignal) {
    const draft = RegistryDraft.parse(input)
    signal?.throwIfAborted()
    const sources = draft.nacosRegistries ?? (draft.nacos ? [{ ...draft.nacos, id: 'legacy', name: 'Nacos 注册中心' }] : [])
    const sourceResults = await Promise.all(sources.map(async source => ({ id: source.id, name: source.name,
      ...(source.enabled === false ? { enabled: false, agents: [], error: '' } : await this.inspectRegistry(source, signal)),
    })))
    const direct = (draft.agents ?? []).filter(agent => agent.enabled !== false)
    const results: Awaited<ReturnType<RegistrySettings['inspectCard']>>[] = new Array(direct.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(4, direct.length) }, async () => {
      while (next < direct.length) {
        const index = next++
        results[index] = await this.inspectCard(direct[index], signal)
      }
    }))
    const agents = [
      ...sourceResults.flatMap(source => source.agents.map(agent => ({ ...agent,
        id: agentIdentity('nacos', source.id, agent.name), source: { id: source.id, name: source.name, kind: 'nacos' as const } }))),
      ...direct.map((agent, index) => ({ ...results[index].agent, ...agent,
        id: agentIdentity('direct', 'direct', agent.name), source: { id: 'direct', name: '直连 Card', kind: 'direct' as const },
        callable: canCall(this.client.config.role, agent.role), error: results[index].error,
      })),
    ]
    const error = sourceResults.filter(source => source.error).map(source => `${source.name}：${source.error}`).join('；')
    // Preserve the response shape used by older clients.
    if (!sources.length && !direct.length && !draft.nacosRegistries && !draft.agents) return { enabled: false, agents: [], error: '' }
    return { enabled: true, agents, sources: sourceResults, error }
  }

  async inspectRegistry(input: z.infer<typeof NacosSettings>, signal?: AbortSignal) {
    const nacos = NacosSettings.parse(input)
    signal?.throwIfAborted()
    try {
      const entries = await new NacosRegistry(nacos).list(signal)
      signal?.throwIfAborted()
      return { enabled: true, error: '', agents: entries.map(agent => ({
        name: agent.name, description: agent.description ?? '', role: agent.role, cardUrl: agent.cardUrl,
        callable: canCall(this.client.config.role, agent.role), ...agent.registryInfo,
      })) }
    } catch {
      signal?.throwIfAborted()
      const missing = nacos.accessTokenEnv && !process.env[nacos.accessTokenEnv]
      return { enabled: true, agents: [], error: missing
        ? `环境变量 ${nacos.accessTokenEnv} 未设置，请在宿主进程中配置后重试。`
        : '无法读取注册中心，请检查地址、命名空间及访问权限后重试。' }
    }
  }

  async inspectCard(input: z.infer<typeof CardProbe>, signal?: AbortSignal) {
    const probe = CardProbe.parse(input)
    signal?.throwIfAborted()
    try {
      const deadline = AbortSignal.timeout(10000)
      const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline
      // Read metadata with the same URL, authentication and protocol checks as actual calls.
      const preview = new A2AClient({ ...this.client.config, nacos: undefined, nacosRegistries: [],
        role: 'personal', agents: [{ ...probe, name: 'card-preview', role: 'personal' }] })
      const client = await preview.connect('card-preview', bounded)
      const card = await client.getAgentCard({ signal: bounded })
      if (!card.name?.trim() || !card.version || !card.supportedInterfaces.length) throw new Error('Invalid Card')
      return { error: '', agent: {
        name: card.name, description: card.description, cardUrl: probe.cardUrl, version: card.version,
        streaming: card.capabilities?.streaming ?? false,
        interfaces: card.supportedInterfaces.map(({ url, protocolBinding, protocolVersion }) => ({ url, protocolBinding, protocolVersion })),
        skills: card.skills.map(({ id, name, description, tags }) => ({ id, name, description, tags })),
      } }
    } catch {
      signal?.throwIfAborted()
      const missing = probe.tokenEnv && !process.env[probe.tokenEnv]
      return { agent: null, error: missing ? `环境变量 ${probe.tokenEnv} 未设置，请在宿主进程中配置后重试。`
        : '无法读取 Agent Card，请检查地址、访问权限及 A2A JSON-RPC 协议支持。' }
    }
  }
}

type RegistryContext = Context & { typert: TypertRegistryContract & { register(contribution: typeof registryHost): () => void } }
export class RegistryRpc extends TypertRemoteService {
  constructor(ctx: RegistryContext, private readonly settings: RegistrySettings) {
    super(ctx, 'a2aRegistry')
    ctx.effect(() => ctx.typert.register(registryHost))
  }
  @Remote
  configuration(signal: AbortSignal) { return this.settings.configuration(signal) }
  @Remote
  save(input: z.infer<typeof RegistryUpdate>, signal: AbortSignal) { return this.settings.save(input, signal) }
  @Remote
  inspect(input: z.infer<typeof RegistryDraft>, signal: AbortSignal) { return this.settings.inspect(input, signal) }
  @Remote
  inspectCard(input: z.infer<typeof CardProbe>, signal: AbortSignal) { return this.settings.inspectCard(input, signal) }
  @Remote
  inspectRegistry(input: z.infer<typeof NacosSettings>, signal: AbortSignal) { return this.settings.inspectRegistry(input, signal) }
}
