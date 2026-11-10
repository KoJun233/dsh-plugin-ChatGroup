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
