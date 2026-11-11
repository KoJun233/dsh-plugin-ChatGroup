import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { AgentCard } from '@a2a-js/sdk'
import { NacosRegistry, DSH_REGISTRY_EXTENSION } from '../src/nacos.js'
import { A2AClient } from '../src/client.js'
import { createA2AServer } from '../src/server.js'
import { AGUI_EXTENSION } from '../src/agui.js'
import { FileConfig, type NacosConfig } from '../src/config.js'

type Json = Record<string, any>
async function fixture() {
  const cards = new Map<string, Json>()
  const requests: { path: string; method: string; params: Json }[] = []
  const app = express()
  app.use(express.urlencoded({ extended: false }))
  let apiError = 0
  app.use('/nacos/v3', (req, _res, next) => {
    requests.push({ path: req.path, method: req.method, params: req.method === 'GET' ? { ...req.query } : { ...req.body } })
    next()
  })
  app.get('/nacos/v3/admin/ai/a2a/list', (req, res) => {
    if (apiError) { res.json({ code: apiError, data: null }); return }
    // Real Nacos 3.2 requires an explicit empty agentName for an unfiltered list.
    assert.equal(req.query.agentName, '')
    assert.equal(req.query.search, 'blur')
    const all = [...cards.values()]
    const page = Number(req.query.pageNo)
    // Small pages exercise pagination without constructing a hundred cards.
    res.json({ code: 0, data: { totalCount: all.length, pageItems: all.slice(page - 1, page).map(c => ({ name: c.name })) } })
  })
  app.get('/nacos/v3/admin/ai/a2a', (req, res) => {
    const card = cards.get(String(req.query.agentName))
    res.json(card ? { code: 0, data: card } : { code: 50100, data: 'Agent not found' })
  })
  app.post('/nacos/v3/admin/ai/a2a', (req, res) => {
    const card = JSON.parse(req.body.agentCard)
    assert.equal(req.body.registrationType, 'URL')
    cards.set(card.name, card)
    res.json({ code: 0, data: 'ok' })
  })
  app.put('/nacos/v3/admin/ai/a2a', (req, res) => {
    assert.equal(req.body.setAsLatest, 'true')
    const card = JSON.parse(req.body.agentCard)
    cards.set(card.name, card)
    res.json({ code: 0, data: 'ok' })
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const config: NacosConfig = { serverUrl: `${origin}/nacos`, namespaceId: 'test-space' }
  return { app, cards, requests, origin, config, registry: new NacosRegistry(config),
    fail(code: number) { apiError = code },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}

function legacyCard(name: string, url: string): Json {
  return { name, version: '1.0.0', description: 'imported Agent', protocolVersion: '0.3.0', url,
    preferredTransport: 'JSONRPC', capabilities: { streaming: true, extensions: [] },
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    skills: [{ id: 'assist', name, description: 'assist', tags: ['test'] }],
  }
}

test('native Registry publishes durable Cards and resolves the original v1 Card without losing AG-UI', async () => {
  const f = await fixture()
  const agent = createA2AServer({ name: 'BACK_AGENT', description: 'backend', role: 'business', publicUrl: f.origin, localDemo: true }, async text => `reply:${text}`)
  agent.card.supportedInterfaces = agent.card.supportedInterfaces.filter(i => i.protocolVersion === '1.0')
  agent.card.capabilities!.extensions.push({ uri: AGUI_EXTENSION, required: false, description: 'trace', params: { schemaVersion: 1 } })
  const methods: string[] = []
  f.app.use((req, _res, next) => {
    if (req.path === '/a2a') {
      express.json()(req, _res, () => { methods.push(req.body.method); next() })
    } else next()
  })
  f.app.use(agent.app)
  const entry = { name: 'backend', role: 'business' as const, cardUrl: `${f.origin}/.well-known/agent-card.json` }
  try {
    const stop = await f.registry.register(entry)
    const catalog = f.cards.get('backend')!
    assert.equal(catalog.protocolVersion, '1.0')
    assert.equal(catalog.url, `${f.origin}/a2a`)
    assert.equal(catalog.capabilities.extensions[0].uri, AGUI_EXTENSION)
    assert.equal(catalog.capabilities.extensions[1].params.role, 'business')
    const client = new A2AClient({ role: 'personal', timeoutMs: 5000, pollIntervalMs: 50, agents: [], nacos: f.config })
    const discovered = await client.list()
    assert.deepEqual(discovered.map(a => a.name), ['backend'])
    const sdk = await client.connect('backend')
    assert.equal(sdk.protocolVersion, '1.0')
    assert.equal((await sdk.getAgentCard()).name, 'BACK_AGENT')
    assert.equal((await sdk.getAgentCard()).capabilities!.extensions[0].uri, AGUI_EXTENSION)
    assert.equal((await client.send('backend', 'hello', { stream: false })).text, 'reply:hello')
    assert.ok(methods.includes('SendMessage'))
    assert.ok(!methods.includes('message/send'))
    await stop()
    assert.ok(f.cards.has('backend'))
    assert.ok(f.requests.every(r => !r.path.includes('/ns/') && r.method !== 'DELETE'))
    assert.ok(f.requests.every(r => r.params.namespaceId === 'test-space'))
  } finally { await agent.dispose(); await f.close() }
})

test('native import works without a DSH source extension; role omission cannot permit business-to-personal calls', async () => {
  const f = await fixture()
  const agent = createA2AServer({ name: 'imported', description: 'imported', role: 'business', publicUrl: f.origin, localDemo: true }, async () => 'import works')
  let sourceReads = 0
  f.app.get('/.well-known/agent-card.json', (_req, res) => { sourceReads++; res.status(500).end() })
  f.app.use(agent.app)
  f.cards.set('legacy', legacyCard('legacy', `${f.origin}/a2a`))
  f.cards.set('v1', { ...legacyCard('v1', `${f.origin}/a2a`), protocolVersion: '1.0' })
  f.cards.set('grpc-only', { ...legacyCard('grpc-only', 'grpc://127.0.0.1:9999'), preferredTransport: 'GRPC' })
  f.cards.get('legacy')!.additionalInterfaces = [{ url: 'grpc://127.0.0.1:9999', transport: 'GRPC' }]
  try {
    const personal = new A2AClient({ role: 'personal', timeoutMs: 5000, pollIntervalMs: 50, agents: [], nacos: f.config })
    const entries = await personal.list()
    assert.equal(entries.length, 2)
    assert.ok(entries.every(a => a.registryCard && a.role === 'personal'))
    assert.equal((await personal.send('legacy', 'hello')).text, 'import works')
    assert.equal((await personal.connect('v1')).protocolVersion, '1.0')
    assert.equal(sourceReads, 0)
    assert.deepEqual(f.requests.filter(r => r.path === '/admin/ai/a2a/list').slice(0, 2).map(r => r.params.pageNo), ['1', '2'])
    const business = new A2AClient({ ...personal.config, role: 'business' })
    assert.deepEqual(await business.list(), [])
  } finally { await agent.dispose(); await f.close() }
})

test('native upsert selects the new published version and refuses to overwrite a different source', async () => {
  const f = await fixture()
  const card = AgentCard.fromJSON({ name: 'source', version: '1.0.0', supportedInterfaces: [{ url: `${f.origin}/call`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] })
  const entry = { name: 'backend', role: 'business' as const, cardUrl: `${f.origin}/card` }
  try {
    await f.registry.publish(entry, card)
    card.version = '2.0.0'
    await f.registry.publish(entry, card)
    assert.equal(f.cards.get('backend')!.version, '2.0.0')
    assert.deepEqual(f.requests.filter(r => ['POST', 'PUT'].includes(r.method)).map(r => r.method), ['POST', 'PUT'])
    await assert.rejects(f.registry.publish({ ...entry, cardUrl: `${f.origin}/someone-else` }, card), /different owner\/source/)
    await assert.rejects(f.registry.publish({ ...entry, name: '无效名称' }, card), /printable ASCII/)
    assert.equal(f.requests.filter(r => r.method === 'PUT').length, 1)
  } finally { await f.close() }
})

test('native Registry errors do not silently fall back to Naming', async () => {
  const f = await fixture()
  try {
    f.fail(403)
    await assert.rejects(f.registry.list(), /application error 403/)
    assert.equal(f.requests.length, 1)
    assert.equal(f.requests[0].path, '/admin/ai/a2a/list')
    const config = FileConfig.parse({ nacos: { serverUrl: f.config.serverUrl } })
    assert.equal('registry' in config.nacos!, false)
    assert.equal(config.nacos!.namespaceId, 'public')
  } finally { await f.close() }
})

test('Nacos access token stays at Registry and does not enter published Agent metadata', async () => {
  const f = await fixture()
  process.env.A2A_TEST_NACOS_TOKEN = 'registry-test-token'
  process.env.A2A_TEST_AGENT_TOKEN = 'agent-test-token'
  f.app.get('/protected-card', (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer agent-test-token')
    assert.equal(req.query.accessToken, undefined)
    res.json(legacyCard('source', `${f.origin}/call`))
  })
  try {
    const registry = new NacosRegistry({ ...f.config, accessTokenEnv: 'A2A_TEST_NACOS_TOKEN' })
    await registry.publish({ name: 'protected', role: 'business', cardUrl: `${f.origin}/protected-card`, tokenEnv: 'A2A_TEST_AGENT_TOKEN' })
    const data = JSON.stringify(f.cards.get('protected'))
    assert.ok(!data.includes('agent-test-token') && !data.includes('registry-test-token') && !data.includes('tokenEnv'))
    assert.ok(f.requests.every(r => r.params.accessToken === 'registry-test-token'))
    assert.ok(f.cards.get('protected')!.capabilities.extensions.some((e: Json) => e.uri === DSH_REGISTRY_EXTENSION))
  } finally { delete process.env.A2A_TEST_NACOS_TOKEN; delete process.env.A2A_TEST_AGENT_TOKEN; await f.close() }
})

test('obsolete Naming selectors cannot route discovery through Naming APIs', async () => {
  const f = await fixture()
  f.app.get('/nacos/v3/admin/ns/service/list', (_req, res) => res.json({ code: 0, data: { totalCount: 1, pageItems: [{ name: 'a2a.legacy' }] } }))
  f.app.get('/nacos/v3/client/ns/instance/list', (_req, res) => res.json({ code: 0, data: [{ healthy: true, enabled: true, ip: '127.0.0.1', port: 4100,
    metadata: { a2aRole: 'business', a2aCardUrl: `${f.origin}/card` } }] }))
  try {
    const config = FileConfig.parse({ nacos: { ...f.config, registry: 'naming', groupName: 'OLD', servicePrefix: 'old.' } })
    const registry = new NacosRegistry(config.nacos!)
    assert.deepEqual(await registry.list(), [])
    assert.ok(f.requests.length > 0 && f.requests.every(r => r.path.startsWith('/admin/ai/a2a')))
    assert.equal('registry' in config.nacos!, false)
    assert.equal('groupName' in config.nacos!, false)
    assert.equal('servicePrefix' in config.nacos!, false)
  } finally { await f.close() }
})
