import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  Role, SendMessageRequest, TaskState, taskStateToJSON,
  type Task, type Part, type SendMessageResult,
} from '@a2a-js/sdk'
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client'
import { agentIdentity, canCall, envSecret, httpUrl, nacosSources, type A2AConfig, type AgentEntry } from './config.js'
import { NacosRegistry } from './nacos.js'
import { AGUI_EXTENSION, AgUiProtocolError, AgUiTraceReader, type AgUiRecord } from './agui.js'

export interface CallResult {
  agent: string
  taskId?: string
  contextId: string
  state: string
  text: string
  peer?: { sessionId: string; turn: number; seq?: number }
}

export interface SendOptions {
  contextId?: string
  taskId?: string
  wait?: boolean
  stream?: boolean
  signal?: AbortSignal
  onUpdate?: (result: CallResult) => void
  /** Negotiates the optional AG-UI binding; records are validated and deduplicated. */
  onTrace?: (record: AgUiRecord) => void
}

export function partsText(parts: Part[]): string {
  return parts.flatMap(part => part.content?.$case === 'text' ? [part.content.value] : []).join('\n')
}

export function summarize(agent: string, result: SendMessageResult): CallResult {
  if ('messageId' in result) return { agent, contextId: result.contextId, state: 'MESSAGE', text: partsText(result.parts) }
  return {
    agent, taskId: result.id, contextId: result.contextId,
    state: taskStateToJSON(result.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED),
    text: result.artifacts.map(a => partsText(a.parts)).filter(Boolean).join('\n')
      || (result.status?.message ? partsText(result.status.message.parts) : ''),
  }
}

function pending(task: Task): boolean {
  return task.status?.state === TaskState.TASK_STATE_SUBMITTED || task.status?.state === TaskState.TASK_STATE_WORKING
}

export class A2AClient {
  /** First active registry, retained for singleton integrations. */
  nacos?: NacosRegistry
  constructor(public config: A2AConfig) {
    this.reconfigure(config)
  }

  reconfigure(config: A2AConfig): void {
    this.config = config
    const first = nacosSources(config).find(source => source.enabled !== false)
    this.nacos = first ? new NacosRegistry(first) : undefined
  }

  async list(signal?: AbortSignal): Promise<AgentEntry[]> {
    return (await this.discover(signal)).agents
  }

  async discover(signal?: AbortSignal) {
    const config = this.config
    signal?.throwIfAborted()
    const sources = nacosSources(config).filter(source => source.enabled !== false)
    const results = await Promise.allSettled(sources.map(source => new NacosRegistry(source).list(signal)))
    signal?.throwIfAborted()
    const entries: AgentEntry[] = []
    const errors: { id: string; name: string; error: string }[] = []
    for (const [index, result] of results.entries()) {
      const source = sources[index]
      if (result.status === 'rejected') {
        errors.push({ id: source.id, name: source.name, error: '无法读取注册中心，请检查地址、命名空间及访问权限。' })
      } else for (const agent of result.value) entries.push({ ...agent,
        id: agentIdentity('nacos', source.id, agent.name), source: { id: source.id, name: source.name, kind: 'nacos' } })
    }
    for (const agent of config.agents.filter(agent => agent.enabled !== false)) entries.push({ ...agent,
      id: agentIdentity('direct', 'direct', agent.name), source: { id: 'direct', name: '直连 Card', kind: 'direct' } })
    const allowed = entries.filter(agent => canCall(config.role, agent.role))
    const counts = new Map<string, number>()
    for (const agent of allowed) counts.set(agent.name, (counts.get(agent.name) ?? 0) + 1)
    return { agents: allowed.map(agent => ({ ...agent,
      displayName: (counts.get(agent.name) ?? 0) > 1 ? `${agent.name}（${agent.source!.name}）` : agent.name })), errors }
  }

  async connect(name: string, signal?: AbortSignal) {
    const direct = this.config.agents.find(agent => agentIdentity('direct', 'direct', agent.name) === name
      && agent.enabled !== false && canCall(this.config.role, agent.role))
    const source = nacosSources(this.config).find(source => source.enabled !== false && name.startsWith(`nacos:${source.id}:`))
    // Source-bound calls do not depend on unrelated registries being reachable.
    const entries = direct ? [{ ...direct, id: name }]
      : source ? await new A2AClient({ ...this.config, nacosRegistries: [source], agents: [] }).list(signal)
      : await this.list(signal)
    // Old histories may contain bare names; ambiguous names must never silently retarget.
    const exact = entries.find(entry => entry.id === name)
    const matches = entries.filter(entry => entry.name === name)
    if (!exact && /^(direct|nacos):/.test(name)) throw new Error(`Agent unavailable or disallowed: ${name}`)
    if (!exact && matches.length > 1) throw new Error(`Agent name is ambiguous; select its source: ${name}`)
    const agent = exact ?? matches[0]
    if (!agent) throw new Error(`Agent unavailable or disallowed: ${name}`)
    const cardUrl = httpUrl(agent.cardUrl)
    const token = envSecret(agent.tokenEnv)
    // Credentials are scoped to the configured card origin, including redirects.
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = httpUrl(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (token && url.origin !== cardUrl.origin) throw new Error('Authenticated Agent endpoint changed origin')
      const headers = new Headers(init?.headers)
      if (token) headers.set('authorization', `Bearer ${token}`)
      return fetch(input, { ...init, headers, redirect: 'error', signal: init?.signal ?? signal ?? AbortSignal.timeout(this.config.timeoutMs) })
    }
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl, legacyCompat: { enabled: true } })],
      cardResolver: new DefaultAgentCardResolver({ fetchImpl, legacyCompat: { enabled: true } }),
    })
    return agent.registryCard
      ? factory.createFromAgentCard(agent.registryCard)
      : factory.createFromUrl(cardUrl.href, '')
  }

  async send(name: string, text: string, options: SendOptions = {}): Promise<CallResult> {
    const deadline = AbortSignal.timeout(this.config.timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
    const client = await this.connect(name, signal)
    const card = await client.getAgentCard({ signal })
    const trace = new AgUiTraceReader()
    const withTrace = Boolean(options.onTrace && card.capabilities?.extensions.some(extension => extension.uri === AGUI_EXTENSION))
    const requestOptions = { signal, ...(withTrace ? { serviceParameters: { 'A2A-Extensions': AGUI_EXTENSION } } : {}) }
    const readTrace = (artifacts: import('@a2a-js/sdk').Artifact[]) => {
      if (withTrace) for (const artifact of artifacts) for (const record of trace.read(artifact)) options.onTrace?.(record)
    }
    let taskId: string | undefined
    try {
      const request = SendMessageRequest.fromJSON({
        message: {
          messageId: randomUUID(), role: Role.ROLE_USER,
          contextId: options.contextId ?? '', taskId: options.taskId ?? '',
          parts: [{ text, mediaType: 'text/plain' }],
        },
        configuration: { returnImmediately: true, acceptedOutputModes: withTrace ? ['text/plain', 'application/json'] : ['text/plain'] },
      })
      if (options.wait !== false && options.stream !== false && card.capabilities?.streaming) {
        const artifacts = new Map<string, string>()
        let snapshot: CallResult | undefined
        let settled = false
        for await (const event of client.sendMessageStream(request, requestOptions)) {
          const payload = event.payload
          if (!payload) continue
          switch (payload.$case) {
            case 'task': {
              const task = payload.value
              taskId = task.id
              readTrace(task.artifacts)
              artifacts.clear()
              for (const artifact of task.artifacts) artifacts.set(artifact.artifactId, partsText(artifact.parts))
              snapshot = summarize(name, task)
              settled = !pending(task)
              break
            }
            case 'artifactUpdate': {
              const update = payload.value
              taskId = update.taskId
              const artifact = update.artifact
              if (!artifact) continue
              readTrace([artifact])
              const chunk = partsText(artifact.parts)
              artifacts.set(artifact.artifactId, (update.append ? artifacts.get(artifact.artifactId) ?? '' : '') + chunk)
              snapshot = {
                agent: name, taskId, contextId: update.contextId, state: snapshot?.state ?? 'TASK_STATE_WORKING',
                text: [...artifacts.values()].filter(Boolean).join('\n'),
              }
              break
            }
            case 'statusUpdate': {
              const update = payload.value
              taskId = update.taskId
              const state = update.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED
              snapshot = {
                agent: name, taskId, contextId: update.contextId, state: taskStateToJSON(state),
                text: [...artifacts.values()].filter(Boolean).join('\n') || (update.status?.message ? partsText(update.status.message.parts) : snapshot?.text ?? ''),
              }
              settled = state !== TaskState.TASK_STATE_SUBMITTED && state !== TaskState.TASK_STATE_WORKING
                && state !== TaskState.TASK_STATE_UNSPECIFIED
              break
            }
            case 'message':
              snapshot = summarize(name, payload.value)
              settled = true
              break
          }
          if (snapshot) options.onUpdate?.({ ...snapshot })
        }
        if (!snapshot || !settled) throw new Error(`A2A stream ended without a settled result${taskId ? `; taskId=${taskId}` : ''}`)
        trace.assertEnded()
        return snapshot
      }
      let result = await client.sendMessage(request, requestOptions)
      if ('id' in result) taskId = result.id
      if ('id' in result) readTrace(result.artifacts)
      options.onUpdate?.(summarize(name, result))
      while (options.wait !== false && 'id' in result && pending(result)) {
        await sleep(this.config.pollIntervalMs, undefined, { signal })
        result = await client.getTask({ id: result.id, tenant: '' }, requestOptions)
        readTrace(result.artifacts)
        options.onUpdate?.(summarize(name, result))
      }
      if (options.wait !== false) trace.assertEnded()
      return summarize(name, result)
    } catch (error) {
      if ((signal.aborted || error instanceof AgUiProtocolError) && taskId) {
        let cancelled = false
        try {
          await client.cancelTask({ id: taskId, tenant: '', metadata: undefined }, { signal: AbortSignal.timeout(3000) })
          cancelled = true
        } catch { /* Expose unknown remote cancellation instead of claiming success. */ }
        throw new Error(`${error instanceof AgUiProtocolError ? error.message : 'A2A interrupted'}; taskId=${taskId}; remoteCancellation=${cancelled ? 'confirmed' : 'unknown'}`, { cause: error })
      }
      throw error
    }
  }

  async get(name: string, taskId: string, signal?: AbortSignal): Promise<CallResult> {
    const combined = AbortSignal.any([AbortSignal.timeout(this.config.timeoutMs), ...(signal ? [signal] : [])])
    return summarize(name, await (await this.connect(name, combined)).getTask({ id: taskId, tenant: '' }, { signal: combined }))
  }

  async cancel(name: string, taskId: string, signal?: AbortSignal): Promise<CallResult> {
    const combined = AbortSignal.any([AbortSignal.timeout(this.config.timeoutMs), ...(signal ? [signal] : [])])
    return summarize(name, await (await this.connect(name, combined)).cancelTask({ id: taskId, tenant: '', metadata: undefined }, { signal: combined }))
  }
}
