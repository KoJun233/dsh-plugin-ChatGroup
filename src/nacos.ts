import { AgentCard } from '@a2a-js/sdk'
import { DefaultAgentCardResolver } from '@a2a-js/sdk/client'
import { isLegacyAgentCard } from '@a2a-js/sdk/compat/v0_3/client'
import { envSecret, httpUrl, type AgentEntry, type NacosConfig } from './config.js'

/** Plugin policy/source information; independent from the AG-UI execution extension. */
export const DSH_REGISTRY_EXTENSION = 'urn:dsh:a2a:registry:v1'
const resolver = new DefaultAgentCardResolver({ legacyCompat: { enabled: true } })
type CatalogCard = Record<string, unknown>

class NacosError extends Error {
  constructor(readonly code: number, readonly status: number) {
    super(`Nacos Agent Registry: application error ${code} (HTTP ${status})`)
  }
}

function normalize(raw: unknown): AgentCard {
  const card = isLegacyAgentCard(raw)
    ? AgentCard.fromJSON(AgentCard.toJSON(resolver.normalizeAgentCard(raw)))
    : AgentCard.fromJSON(raw)
  if (!card.name?.trim() || !card.version || !card.supportedInterfaces.length) {
    throw new Error('Agent Card must contain name, version and supported interfaces')
  }
  for (const endpoint of card.supportedInterfaces.filter(item => item.protocolBinding === 'JSONRPC')) httpUrl(endpoint.url)
  return card
}

function policy(card: AgentCard) {
  return card.capabilities?.extensions.find(extension => extension.uri === DSH_REGISTRY_EXTENSION)?.params
}

/** Nacos native Agent Registry. */
export class NacosRegistry {
  constructor(readonly config: NacosConfig) {}

  private async request<T>(suffix: string, params: Record<string, string> = {}, method = 'GET', signal?: AbortSignal): Promise<T> {
    const url = httpUrl(`${this.config.serverUrl.replace(/\/$/, '')}/v3/admin/ai/a2a${suffix}`)
    const values = new URLSearchParams({ namespaceId: this.config.namespaceId || 'public', ...params })
    const token = envSecret(this.config.accessTokenEnv)
    if (token) values.set('accessToken', token)
    const query = method === 'GET' || method === 'DELETE'
    if (query) url.search = values.toString()
    const response = await fetch(url, {
      method, redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
      headers: query ? {} : { 'content-type': 'application/x-www-form-urlencoded' },
      body: query ? undefined : values,
    })
    // Do not print response bodies or URLs, which may contain deployment credentials.
    const result = await response.json() as { code: number; data: T }
    if (!response.ok || result.code !== 0) throw new NacosError(result.code, response.status)
    return result.data
  }

  async list(signal?: AbortSignal): Promise<AgentEntry[]> {
    const entries: AgentEntry[] = []
    let count = 0
    for (let pageNo = 1; ; pageNo++) {
      const page = await this.request<{ totalCount: number; pageItems: { name: string }[] }>('/list', {
        pageNo: String(pageNo), pageSize: '100', search: 'blur', agentName: '',
      }, 'GET', signal)
      for (const item of page.pageItems) {
        let raw: CatalogCard
        try { raw = await this.request('', { agentName: item.name }, 'GET', signal) }
        catch (error) {
          if (error instanceof NacosError && error.code === 50100) continue // Deleted between list and detail.
          throw error
        }
        const card = normalize(raw)
        const endpoint = card.supportedInterfaces.find(item => item.protocolBinding === 'JSONRPC')
        if (!endpoint) continue
        const meta = policy(card)
        const source = meta?.cardUrl
        if (source !== undefined && typeof source !== 'string') throw new Error('Invalid registered Agent Card URL')
        // Missing classification stays personal: business callers must not gain access by omission.
        const role = meta?.role === 'business' ? 'business' : 'personal'
        const cardUrl = httpUrl(source ?? endpoint.url).href
        entries.push({ name: item.name, role, cardUrl, description: card.description,
          registryInfo: { version: card.version, streaming: card.capabilities?.streaming ?? false,
            interfaces: card.supportedInterfaces.map(({ url, protocolBinding, protocolVersion }) => ({ url, protocolBinding, protocolVersion })),
            skills: card.skills.map(({ id, name, description, tags }) => ({ id, name, description, tags })),
          },
          ...(source ? {} : { registryCard: card }),
        })
      }
      count += page.pageItems.length
      if (count >= page.totalCount || !page.pageItems.length) break
    }
    return entries
  }

  /** Publish a persistent URL registration. This does not register a Naming instance or a health lease. */
  async publish(agent: AgentEntry, supplied?: AgentCard): Promise<{ name: string; version: string }> {
    if (!/^[\x20-\x7e]{1,64}$/.test(agent.name) || !agent.name.trim()) {
      throw new Error('Nacos Agent name must contain 1–64 printable ASCII characters')
    }
    const sourceUrl = httpUrl(agent.cardUrl).href
    let card: AgentCard
    if (supplied) card = normalize(AgentCard.toJSON(supplied))
    else {
      const token = envSecret(agent.tokenEnv)
      const response = await fetch(sourceUrl, {
        redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'A2A-Version': '1.0', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      })
      if (!response.ok) throw new Error(`Agent Card: HTTP ${response.status}`)
      card = normalize(await response.json())
    }
    const endpoint = card.supportedInterfaces.find(item => item.protocolBinding === 'JSONRPC')
    if (!endpoint) throw new Error('A JSONRPC Agent interface is required')
    const extensions = (card.capabilities?.extensions ?? []).filter(item => item.uri !== DSH_REGISTRY_EXTENSION)
    extensions.push({ uri: DSH_REGISTRY_EXTENSION, required: false,
      description: 'DSH role and original Agent Card URL; catalog name may be a local alias.',
      params: { role: agent.role, cardUrl: sourceUrl },
    })
    // Nacos 3.2 stores url/preferredTransport, not 1.0 supportedInterfaces.
    // Project its catalog fields without claiming 0.3 support. Calls resolve the original Card.
    const catalog: CatalogCard = {
      name: agent.name, description: agent.description ?? card.description, version: card.version,
      protocolVersion: endpoint.protocolVersion, url: endpoint.url, preferredTransport: endpoint.protocolBinding,
      capabilities: { streaming: card.capabilities?.streaming ?? false,
        pushNotifications: card.capabilities?.pushNotifications ?? false, extensions },
      defaultInputModes: card.defaultInputModes, defaultOutputModes: card.defaultOutputModes,
      skills: card.skills.map(({ securityRequirements: _, ...skill }) => skill),
      provider: card.provider, documentationUrl: card.documentationUrl, iconUrl: card.iconUrl,
      supportsAuthenticatedExtendedCard: card.capabilities?.extendedAgentCard ?? false,
      securitySchemes: Object.fromEntries(Object.entries(card.securitySchemes).map(([name, scheme]) => {
        const value = scheme.scheme
        if (!value) throw new Error('Invalid Agent security scheme')
        const types = { apiKeySecurityScheme: 'apiKey', httpAuthSecurityScheme: 'http', oauth2SecurityScheme: 'oauth2',
          openIdConnectSecurityScheme: 'openIdConnect', mtlsSecurityScheme: 'mutualTLS' }
        const projected = { ...value.value, type: types[value.$case] } as Record<string, unknown>
        if (value.$case === 'apiKeySecurityScheme') { projected.in = value.value.location; delete projected.location }
        return [name, projected]
      })),
      security: card.securityRequirements.map(item => Object.fromEntries(Object.entries(item.schemes).map(([k, v]) => [k, v.list]))),
    }
    let exists = false
    try {
      const current = normalize(await this.request('', { agentName: agent.name }))
      if (policy(current)?.cardUrl !== sourceUrl) throw new Error(`Agent already exists with a different owner/source: ${agent.name}`)
      exists = true
    } catch (error) { if (!(error instanceof NacosError && error.code === 50100)) throw error }
    await this.request('', { agentCard: JSON.stringify(catalog), registrationType: 'URL',
      ...(exists ? { setAsLatest: 'true' } : {}),
    }, exists ? 'PUT' : 'POST')
    return { name: agent.name, version: card.version }
  }

  /** Native catalogs persist across shutdown. */
  async register(agent: AgentEntry, card?: AgentCard): Promise<() => Promise<void>> {
    await this.publish(agent, card)
    return async () => {}
  }
}
