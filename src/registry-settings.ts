import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService, type TypertRegistryContract } from '@deepseek-ai/dsh-typert-protocol'
import type { z } from 'zod'
import { A2AClient } from './client.js'
import { canCall, parseConfig } from './config.js'
import { NacosRegistry } from './nacos.js'
import { RegistryDraft, RegistryUpdate, registryHost } from './registry-contract.js'

/** Owns the existing config file; only the nacos key is changed by this page. */
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

  configuration(signal?: AbortSignal) {
    const operation = this.writes.then(async () => {
      const { config, revision } = await this.document()
      signal?.throwIfAborted()
      this.client.reconfigure(config)
      return { nacos: config.nacos ?? null, revision, configFile: this.path }
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
      if (update.nacos) {
        const previous = { ...(current.raw.nacos as Record<string, unknown> | undefined) }
        delete previous.accessTokenEnv
        raw.nacos = { ...previous, ...update.nacos }
      } else delete raw.nacos
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
      return { nacos: config.nacos ?? null, revision: createHash('sha256').update(text).digest('hex'), configFile: this.path }
    })
    this.writes = operation.catch(() => {})
    return operation
  }

  async inspect(input: z.infer<typeof RegistryDraft>, signal?: AbortSignal) {
    const { nacos } = RegistryDraft.parse(input)
    signal?.throwIfAborted()
    if (!nacos) return { agents: [], error: '', enabled: false }
    const config = this.client.config
    try {
      const entries = await new NacosRegistry(nacos).list(signal)
      signal?.throwIfAborted()
      return { enabled: true, error: '', agents: entries.map(agent => ({
        name: agent.name, description: agent.description ?? '', role: agent.role, cardUrl: agent.cardUrl,
        callable: canCall(config.role, agent.role), ...agent.registryInfo,
      })) }
    } catch (error) {
      signal?.throwIfAborted()
      const missing = nacos.accessTokenEnv && !process.env[nacos.accessTokenEnv]
      // Fetch errors may contain URLs or server response content. Keep those off the wire.
      return { enabled: true, agents: [], error: missing
        ? `环境变量 ${nacos.accessTokenEnv} 未设置，请在宿主进程中配置后重试。`
        : '无法读取注册中心，请检查地址、命名空间、注册模式及访问权限后重试。' }
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
}
