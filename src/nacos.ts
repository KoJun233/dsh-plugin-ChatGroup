import { randomUUID } from 'node:crypto'
import { envSecret, httpUrl, type AgentEntry, type NacosConfig } from './config.js'

interface Instance {
  ip: string
  port: number
  healthy: boolean
  enabled: boolean
  metadata?: Record<string, string>
}

/** Nacos Naming HTTP adapter. Agent Card URLs live in instance metadata. */
export class NacosRegistry {
  constructor(readonly config: NacosConfig) {}

  private async request<T>(path: string, params: Record<string, string>, method = 'GET', signal?: AbortSignal): Promise<T> {
    const url = httpUrl(`${this.config.serverUrl.replace(/\/$/, '')}/v3/${path}`)
    const values = new URLSearchParams({
      namespaceId: this.config.namespaceId ?? '',
      groupName: this.config.groupName ?? 'DSH_A2A', ...params,
    })
    const token = envSecret(this.config.accessTokenEnv)
    if (token) values.set('accessToken', token)
    if (method === 'GET' || method === 'DELETE') url.search = values.toString()
    const response = await fetch(url, {
      method, signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
      headers: method === 'GET' || method === 'DELETE' ? {} : { 'content-type': 'application/x-www-form-urlencoded' },
      body: method === 'GET' || method === 'DELETE' ? undefined : values,
    })
    if (!response.ok) throw new Error(`Nacos ${path}: HTTP ${response.status}`)
    const result = await response.json() as { code: number; data: T }
    if (result.code !== 0) throw new Error(`Nacos ${path}: application error ${result.code}`)
    return result.data
  }

  private serviceName(name: string): string { return `${this.config.servicePrefix ?? 'a2a.'}${name}` }

  async list(signal?: AbortSignal): Promise<AgentEntry[]> {
    const names: string[] = []
    for (let pageNo = 1; ; pageNo++) {
      const page = await this.request<{ totalCount: number; pageItems: { name: string }[] }>('admin/ns/service/list', {
        pageNo: String(pageNo), pageSize: '100',
      }, 'GET', signal)
      names.push(...page.pageItems.map(item => item.name))
      if (names.length >= page.totalCount || !page.pageItems.length) break
    }
    const entries: AgentEntry[] = []
    for (const service of names.filter(name => name.startsWith(this.config.servicePrefix ?? 'a2a.'))) {
      const hosts = await this.request<Instance[]>('client/ns/instance/list', {
        serviceName: service, healthyOnly: 'true',
      }, 'GET', signal)
      const instance = hosts.find(h => h.healthy && h.enabled && h.metadata?.a2aCardUrl)
      if (!instance?.metadata) continue
      const metadata = instance.metadata
      if (metadata.a2aRole !== 'personal' && metadata.a2aRole !== 'business') continue
      httpUrl(metadata.a2aCardUrl)
      entries.push({
        name: service.slice((this.config.servicePrefix ?? 'a2a.').length),
        role: metadata.a2aRole, cardUrl: metadata.a2aCardUrl,
        description: metadata.a2aDescription,
      })
    }
    return entries
  }

  /** Registration owner keeps this lease alive; shutdown explicitly deregisters. */
  async register(agent: AgentEntry, heartbeatMs = 5000): Promise<() => Promise<void>> {
    const url = httpUrl(agent.cardUrl)
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    const metadata = JSON.stringify({
      a2aCardUrl: agent.cardUrl, a2aRole: agent.role,
      a2aDescription: agent.description ?? '', registrationId: randomUUID(),
    })
    const params = { serviceName: this.serviceName(agent.name), ip: url.hostname, port, ephemeral: 'true', metadata }
    const register = () => this.request('client/ns/instance', params, 'POST')
    await register()
    let stopped = false
    let active: Promise<unknown> | undefined
    const timer = setInterval(() => {
      if (stopped || active) return
      // Nacos 3.2 InstanceOpenApiController: POST instance?heartBeat=true.
      active = this.request('client/ns/instance', { ...params, heartBeat: 'true' }, 'POST')
      .catch(async error => {
        if (stopped) return
        try { await register(); return } catch { /* Retry on the next scheduled heartbeat. */ }
        console.warn('[dsh-a2a] Nacos heartbeat failed:', error instanceof Error ? error.message : 'unknown error')
      }).finally(() => { active = undefined })
    }, heartbeatMs)
    timer.unref()
    return async () => {
      stopped = true
      clearInterval(timer)
      await active
      await this.request('client/ns/instance', params, 'DELETE')
    }
  }
}
