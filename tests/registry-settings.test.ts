import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { A2AClient } from '../src/client.js'
import { parseConfig } from '../src/config.js'
import { RegistrySettings } from '../src/registry-settings.js'
import { RegistryDraft, registryRemote } from '../src/registry-contract.js'

async function fixture(raw?: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), 'a2a-settings-'))
  const path = join(directory, 'a2a.config.json')
  if (raw) await writeFile(path, JSON.stringify(raw))
  const client = new A2AClient(parseConfig({}))
  const settings = new RegistrySettings(path, client)
  return { path, client, settings, close: () => rm(directory, { recursive: true, force: true }) }
}

test('first-run configuration can be created; disabling discovery preserves direct agents and unrelated fields', async () => {
  const f = await fixture()
  try {
    const initial = await f.settings.configuration()
    assert.equal(initial.nacos, null)
    assert.equal(initial.configFile, f.path)
    const saved = await f.settings.save({ revision: initial.revision, ...RegistryDraft.parse({ nacos: { serverUrl: 'http://127.0.0.1:8848/nacos' } }) })
    assert.equal(f.client.nacos?.config.serverUrl, saved.nacos?.serverUrl)
    assert.equal((await stat(f.path)).mode & 0o777, 0o600)
    const raw = { ...JSON.parse(await readFile(f.path, 'utf8')), role: 'business', timeoutMs: 12345, pollIntervalMs: 100,
      agents: [{ name: 'direct', role: 'business', cardUrl: 'https://agent.example/card', tokenEnv: 'A2A_DIRECT_TOKEN' }], futureOption: { keep: true } }
    await writeFile(f.path, JSON.stringify(raw))
    const latest = await f.settings.configuration()
    await f.settings.save({ revision: latest.revision, nacos: null })
    const { nacos: _, ...expected } = raw
    assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), expected)
    assert.equal(f.client.nacos, undefined)
    assert.deepEqual((await f.client.list()).map(a => a.name), ['direct'])
    assert.equal(f.client.config.timeoutMs, 12345)
    const reopened = new A2AClient(parseConfig({}))
    await new RegistrySettings(f.path, reopened).configuration()
    assert.deepEqual(reopened.config, f.client.config)
  } finally { await f.close() }
})

test('stale and concurrent saves cannot overwrite another committed configuration', async () => {
  const f = await fixture({ timeoutMs: 34567 })
  try {
    const { revision } = await f.settings.configuration()
    const candidate = RegistryDraft.parse({ nacos: { serverUrl: 'http://localhost:8848/nacos' } })
    const results = await Promise.allSettled([f.settings.save({ ...candidate, revision }), f.settings.save({ ...candidate, revision })])
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(results.filter(r => r.status === 'rejected').length, 1)
    const latest = await f.settings.configuration()
    const external = { role: 'business', timeoutMs: 45678, agents: [] }
    await writeFile(f.path, JSON.stringify(external))
    await assert.rejects(f.settings.save({ nacos: null, revision: latest.revision }), /配置已被/)
    assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), external)
  } finally { await f.close() }
})

test('clearing the token environment variable removes authentication while preserving unknown registry fields', async () => {
  const f = await fixture({ nacos: { serverUrl: 'http://localhost:8848/nacos', accessTokenEnv: 'OLD_TOKEN', futureOption: 'preserved' } })
  try {
    const initial = await f.settings.configuration()
    const nacos = { ...initial.nacos! }
    delete nacos.accessTokenEnv
    await f.settings.save({ revision: initial.revision, ...RegistryDraft.parse({ nacos }) })
    assert.equal(f.client.nacos?.config.accessTokenEnv, undefined)
    const saved = JSON.parse(await readFile(f.path, 'utf8')).nacos
    assert.equal(saved.accessTokenEnv, undefined)
    assert.equal(saved.futureOption, 'preserved')
  } finally { await f.close() }
})

test('validation and cancellation leave the file and running client intact', async () => {
  const f = await fixture({ agents: [] })
  try {
    const initial = await f.settings.configuration()
    const before = await readFile(f.path, 'utf8')
    for (const url of ['file:///tmp/nacos', 'https://user:pass@example.com', 'http://localhost?accessToken=secret', 'broken']) {
      assert.equal(RegistryDraft.safeParse({ nacos: { serverUrl: url } }).success, false)
    }
    const aborted = AbortSignal.abort()
    await assert.rejects(f.settings.save({ nacos: null, revision: initial.revision }, aborted))
    assert.equal(await readFile(f.path, 'utf8'), before)
    assert.equal(f.client.nacos, undefined)
  } finally { await f.close() }
})

test('preview uses the proposed registry without saving; committed configuration switches live discovery', async () => {
  const f = await fixture({ agents: [] })
  const app = express()
  app.get('/nacos/v3/admin/ai/a2a/list', (req, res) => {
    assert.equal(req.query.namespaceId, 'qa-space')
    res.json({ code: 0, data: { totalCount: 1, pageItems: [{ name: 'registry-agent' }] } })
  })
  app.get('/nacos/v3/admin/ai/a2a', (_req, res) => res.json({ code: 0, data: {
    name: 'registry-agent', version: '2.0.0', description: 'A registered helper', url: 'http://localhost:4100/a2a',
    protocolVersion: '0.3.0', preferredTransport: 'JSONRPC', capabilities: { streaming: true },
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    skills: [{ id: 'help', name: 'Help', description: 'Assist users', tags: ['qa'] }],
  } }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const initial = await f.settings.configuration()
    const input = RegistryDraft.parse({ nacos: { serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/nacos`, namespaceId: 'qa-space' } })
    const preview = await f.settings.inspect(input)
    assert.equal(preview.error, '')
    const agent = preview.agents[0]
    assert.equal(agent.name, 'registry-agent')
    assert.equal(agent.version, '2.0.0')
    assert.equal(agent.skills?.[0].name, 'Help')
    assert.equal(agent.streaming, true)
    assert.equal(agent.interfaces?.[0].protocolBinding, 'JSONRPC')
    assert.deepEqual(await f.client.list(), [], 'preview does not change live discovery')
    assert.equal(JSON.parse(await readFile(f.path, 'utf8')).nacos, undefined)
    await f.settings.save({ ...input, revision: initial.revision })
    assert.deepEqual((await f.client.list()).map(a => a.name), ['registry-agent'])
    assert.equal(preview.agents[0].callable, true)
    f.client.reconfigure({ ...f.client.config, role: 'business' })
    assert.equal((await f.settings.inspect(input)).agents[0].callable, false)
    assert.deepEqual(await f.client.list(), [], 'role restrictions still apply to conversation discovery')
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close() }
})

test('registry failures and missing credential variables return recoverable errors without leaking values', async () => {
  const f = await fixture()
  try {
    const result = await f.settings.inspect(RegistryDraft.parse({ nacos: { serverUrl: 'http://127.0.0.1:1/nacos' } }))
    assert.equal(result.agents.length, 0)
    assert.match(result.error, /无法读取注册中心/)
    const missing = await f.settings.inspect(RegistryDraft.parse({ nacos: { serverUrl: 'http://localhost:8848/nacos', accessTokenEnv: 'A2A_QA_UNSET_REGISTRY_TOKEN' } }))
    assert.match(missing.error, /A2A_QA_UNSET_REGISTRY_TOKEN/)
    const disabled = await f.settings.inspect({ nacos: null })
    assert.deepEqual(disabled, { agents: [], error: '', enabled: false })
  } finally { await f.close() }
})

test('global settings RPCs do not require a selected conversation', () => {
  for (const method of Object.values(registryRemote.methods)) {
    assert.ok(method.parameters.every(p => p.source !== 'lookup'))
  }
})

test('multiple registries and Cards persist together, migrate the singleton and preserve unrelated fields', async () => {
  const raw = { role: 'business', timeoutMs: 23456, futureOption: { keep: true },
    nacos: { serverUrl: 'http://127.0.0.1:1/nacos', registry: 'agent', groupName: 'OLD', servicePrefix: 'old.', futureOption: true },
    agents: [{ name: 'kept', role: 'business', cardUrl: 'https://agent.example/card', tokenEnv: 'OLD_TOKEN', futureOption: 1 },
      { name: 'removed', role: 'personal', cardUrl: 'https://agent.example/old' }] }
  const f = await fixture(raw)
  try {
    const initial = await f.settings.configuration()
    assert.equal(initial.nacosRegistries.length, 1)
    assert.equal(initial.nacosRegistries[0].id, 'legacy')
    const agents = [{ name: 'kept', role: 'business' as const, cardUrl: 'https://agent.example/new-card', description: 'Edited' }]
    const sources = [{ ...initial.nacosRegistries[0], enabled: false },
      { id: 'second', name: '第二注册中心', serverUrl: 'http://127.0.0.1:2/nacos', enabled: true }]
    const saved = await f.settings.save({ revision: initial.revision, ...RegistryDraft.parse({ nacosRegistries: sources, agents }) })
    assert.equal(saved.nacosRegistries.length, 2)
    assert.equal(saved.agents.length, 1)
    const text = JSON.parse(await readFile(f.path, 'utf8'))
    assert.equal(text.nacos, undefined)
    assert.equal(text.discoveryMode, undefined)
    assert.equal(text.nacosRegistries[0].registry, undefined)
    assert.equal(text.nacosRegistries[0].groupName, undefined)
    assert.equal(text.nacosRegistries[0].servicePrefix, undefined)
    assert.equal(text.nacosRegistries[0].futureOption, true)
    assert.equal(text.agents[0].tokenEnv, undefined)
    assert.equal(text.agents[0].futureOption, 1)
    assert.equal(text.timeoutMs, raw.timeoutMs)
    assert.deepEqual(text.futureOption, raw.futureOption)
    const reopened = new A2AClient(parseConfig({}))
    const snapshot = await new RegistrySettings(f.path, reopened).configuration()
    assert.deepEqual(snapshot.nacosRegistries, saved.nacosRegistries)
    assert.deepEqual(snapshot.agents, agents)
    assert.equal(reopened.nacos?.config.serverUrl, 'http://127.0.0.1:2/nacos')
    const emptied = await f.settings.save({ revision: saved.revision, nacosRegistries: [], agents: [] })
    assert.deepEqual(emptied.nacosRegistries, [])
    assert.deepEqual(await f.client.list(), [])
  } finally { await f.close() }
})

test('discovery combines registries and direct Cards, isolates failed sources and retains duplicate names with stable identities', async () => {
  const requests: string[] = []
  const app = express()
  app.get('/:source/nacos/v3/admin/ai/a2a/list', (req, res) => {
    requests.push(req.params.source)
    if (req.params.source === 'failed') { res.status(503).json({ code: 503, data: null }); return }
    res.json({ code: 0, data: { totalCount: 1, pageItems: [{ name: 'same' }] } })
  })
  app.get('/:source/nacos/v3/admin/ai/a2a', (req, res) => res.json({ code: 0, data: {
    name: 'same', version: '1.0', description: req.params.source, protocolVersion: '0.3.0',
    url: `http://localhost:4100/${req.params.source}`, preferredTransport: 'JSONRPC', capabilities: { streaming: true },
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [],
  } }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const source = (id: string, enabled = true) => ({ id, name: id, enabled, serverUrl: `${origin}/${id}/nacos` })
    const client = new A2AClient(parseConfig({
      nacosRegistries: [source('first'), source('second'), source('failed'), source('disabled', false)],
      agents: [{ name: 'same', role: 'personal', cardUrl: `${origin}/direct-card` }, { name: 'off', role: 'personal', cardUrl: `${origin}/off`, enabled: false }],
    }))
    const result = await client.discover()
    assert.deepEqual(result.agents.map(a => a.id), ['nacos:first:same', 'nacos:second:same', 'direct:same'])
    assert.deepEqual(result.agents.map(a => a.displayName), ['same（first）', 'same（second）', 'same（直连 Card）'])
    assert.deepEqual(result.errors.map(e => e.id), ['failed'])
    assert.ok(!requests.includes('disabled'))
    await assert.rejects(client.connect('same'), /ambiguous/)
    const before = requests.length
    const connected = await client.connect('nacos:second:same')
    assert.equal((await connected.getAgentCard()).description, 'second')
    assert.deepEqual(requests.slice(before), ['second'], 'source-bound call reads only the selected registry')
    client.reconfigure({ ...client.config, nacosRegistries: client.config.nacosRegistries!.filter(s => s.id === 'second') })
    assert.ok((await client.list()).some(a => a.id === 'nacos:second:same'), 'identity survives other source removal')
    const settings = new RegistrySettings(join(tmpdir(), 'unused-a2a-settings-file'), client)
    const preview = await settings.inspect(RegistryDraft.parse({ nacosRegistries: client.config.nacosRegistries, agents: [] }))
    assert.equal(preview.agents.length, 1)
    assert.equal(preview.sources?.[0].id, 'second')
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('source settings reject duplicate identities and names, unsafe URLs and duplicate direct aliases before writing', async () => {
  const f = await fixture({ agents: [] })
  try {
    const { revision } = await f.settings.configuration()
    const before = await readFile(f.path, 'utf8')
    const agent = { name: 'same', role: 'personal', cardUrl: 'https://agent.example/card' }
    const registry = { id: 'one', name: 'One', serverUrl: 'https://registry.example/nacos' }
    assert.equal(RegistryDraft.safeParse({ agents: [agent, { ...agent, name: ' same ' }] }).success, false)
    assert.equal(RegistryDraft.safeParse({ nacosRegistries: [registry, registry] }).success, false)
    assert.equal(RegistryDraft.safeParse({ nacosRegistries: [registry, { ...registry, id: 'two' }] }).success, false)
    for (const cardUrl of ['file:///tmp/card', 'https://user:pass@example.com/card', 'invalid', 'https://agent.example/card#fragment']) {
      assert.equal(RegistryDraft.safeParse({ agents: [{ ...agent, cardUrl }] }).success, false)
    }
    await assert.rejects(f.settings.save({ revision, agents: [agent, agent] } as never))
    assert.equal(await readFile(f.path, 'utf8'), before)
    assert.deepEqual(await f.client.list(), [])
  } finally { await f.close() }
})

test('Card preview reads v1 and legacy metadata with scoped auth, without executing or saving', async () => {
  const { createA2AServer } = await import('../src/server.js')
  const f = await fixture({ role: 'business', agents: [] })
  let calls = 0, cardReads = 0
  const agent = createA2AServer({ name: 'actual-agent', description: 'Actual helper', role: 'business', publicUrl: 'http://127.0.0.1:1', localDemo: true }, async () => { calls++; return 'direct reply' })
  const app = express()
  app.use((req, _res, next) => { if (req.path.includes('card')) { cardReads++; assert.equal(req.headers.authorization, 'Bearer card-preview-secret') } next() })
  app.get('/custom-card', (_req, res) => res.json({
    name: 'legacy-agent', version: '2.0.0', description: 'Legacy helper', protocolVersion: '0.3.0',
    url: agent.card.supportedInterfaces[0].url, preferredTransport: 'JSONRPC', capabilities: { streaming: true },
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [{ id: 'assist', name: 'Help', description: 'Assist', tags: [] }],
  }))
  app.use(agent.app)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  for (const iface of agent.card.supportedInterfaces) iface.url = `${origin}/a2a`
  process.env.A2A_CARD_PREVIEW_TOKEN = 'card-preview-secret'
  try {
    const initial = await f.settings.configuration()
    const before = await readFile(f.path, 'utf8')
    for (const path of ['/.well-known/agent-card.json', '/custom-card']) {
      const result = await f.settings.inspectCard({ cardUrl: `${origin}${path}`, tokenEnv: 'A2A_CARD_PREVIEW_TOKEN' })
      assert.equal(result.error, '')
      assert.ok(result.agent?.version)
      assert.equal(result.agent.interfaces[0].protocolBinding, 'JSONRPC')
      assert.equal(result.agent.streaming, true)
      assert.ok(result.agent.skills.length)
      assert.equal(JSON.stringify(result).includes('card-preview-secret'), false)
    }
    assert.ok(cardReads >= 2)
    assert.equal(calls, 0)
    assert.equal(await readFile(f.path, 'utf8'), before)
    assert.deepEqual(await f.client.list(), [])
    const entry = { name: 'alias', role: 'business' as const, cardUrl: `${origin}/.well-known/agent-card.json`, tokenEnv: 'A2A_CARD_PREVIEW_TOKEN' }
    await f.settings.save({ revision: initial.revision, ...RegistryDraft.parse({ nacos: { serverUrl: 'http://127.0.0.1:1/nacos' }, agents: [entry] }) })
    assert.equal((await f.client.send('direct:alias', 'hello')).text, 'direct reply')
    assert.equal(calls, 1)
  } finally {
    delete process.env.A2A_CARD_PREVIEW_TOKEN
    await agent.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close()
  }
})

test('direct preview keeps per-Agent errors, enforces role visibility and never leaks error bodies', async () => {
  const f = await fixture({ role: 'business', agents: [] })
  const app = express()
  app.get('/bad-card', (_req, res) => res.status(401).json({ error: 'sensitive-remote-secret' }))
  app.get('/unsupported-card', (_req, res) => res.json({ name: 'grpc-only', version: '1', supportedInterfaces: [{ url: 'https://agent.example/grpc', protocolBinding: 'GRPC', protocolVersion: '1.0' }] }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    await f.settings.configuration()
    const result = await f.settings.inspect(RegistryDraft.parse({ nacosRegistries: [], agents: [
      { name: 'bad', role: 'personal', cardUrl: `${origin}/bad-card` },
      { name: 'missing-token', role: 'business', cardUrl: `${origin}/bad-card`, tokenEnv: 'A2A_CARD_UNSET_QA_TOKEN' },
      { name: 'unsupported', role: 'business', cardUrl: `${origin}/unsupported-card` },
    ] }))
    assert.equal(result.agents.length, 3)
    assert.ok(result.agents.every(agent => 'error' in agent && agent.error))
    assert.equal(result.agents[0].callable, false)
    assert.match('error' in result.agents[1] ? result.agents[1].error as string : '', /A2A_CARD_UNSET_QA_TOKEN/)
    assert.equal(JSON.stringify(result).includes('sensitive-remote-secret'), false)
    await assert.rejects(f.settings.inspectCard({ cardUrl: `${origin}/bad-card` }, AbortSignal.abort()))
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close() }
})

test('long multilingual Agent names keep a bounded stable identity for conversation selection', async () => {
  const { agentIdentity } = await import('../src/config.js')
  const { MemberSelection } = await import('../src/group-contract.js')
  const name = '中文助手'.repeat(40)
  const id = agentIdentity('direct', 'direct', name)
  assert.equal(id, agentIdentity('direct', 'direct', name))
  assert.notEqual(id, agentIdentity('direct', 'direct', name + '二'))
  assert.equal(MemberSelection.safeParse({ kind: 'remote', id }).success, true)
  assert.equal(MemberSelection.safeParse({ kind: 'remote', id: agentIdentity('nacos', 'a'.repeat(80), name) }).success, true)
})
