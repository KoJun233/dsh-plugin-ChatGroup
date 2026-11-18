import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import express from 'express'
import { Artifact } from '@a2a-js/sdk'
import { A2AClient } from '../src/client.js'
import { parseConfig } from '../src/config.js'
import { createA2AServer } from '../src/server.js'
import { CallLiveness, HEARTBEAT_ARTIFACT, HEARTBEAT_EXTENSION, HeartbeatReader, heartbeatArtifact } from '../src/heartbeat.js'

type Mode = 'heartbeat' | 'progress' | 'duplicate' | 'invalid' | 'comments' | 'wrong-context' | 'silence'
async function fixture(mode: Mode, cancelState = 'TASK_STATE_CANCELED') {
  const app = express()
  app.use(express.json())
  let origin = '', sends = 0, gets = 0, cancels = 0, beats = 0
  const taskId = 'task-1', contextId = 'session-1'
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const task = () => ({ id: taskId, contextId, status: { state: 'TASK_STATE_WORKING' }, artifacts: [], history: [] })
  app.get('/card', (_req, res) => res.json({
    name: 'heartbeat-test', description: 'test', version: '1',
    supportedInterfaces: [{ url: `${origin}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: true }, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain', 'application/json'], skills: [],
  }))
  app.post('/a2a', (req, res) => {
    const { id, method } = req.body
    if (method === 'GetTask') { gets++; res.json({ jsonrpc: '2.0', id, result: task() }); return }
    if (method === 'CancelTask') {
      cancels++
      res.json({ jsonrpc: '2.0', id, result: { ...task(), status: { state: cancelState } } }); return
    }
    sends++
    res.setHeader('content-type', 'text/event-stream')
    const send = (result: unknown) => res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`)
    send({ task: task() })
    const interval = setInterval(() => {
      beats++
      if (mode === 'silence') return
      if (mode === 'comments') { res.write(': pong\n\n'); return }
      if (mode === 'progress') {
        send({ artifactUpdate: { taskId, contextId, artifact: { artifactId: 'text', parts: [{ text: '.' }] }, append: true } }); return
      }
      const artifact = Artifact.toJSON(heartbeatArtifact(taskId, mode === 'duplicate' ? 1 : beats)) as any
      if (mode === 'invalid') artifact.parts[0].data.type = 'PONG'
      send({ artifactUpdate: { taskId, contextId: mode === 'wrong-context' ? 'other-session' : contextId, artifact, append: false } })
    }, 60)
    const end = setTimeout(() => {
      send({ artifactUpdate: { taskId, contextId, artifact: { artifactId: 'text', parts: [{ text: 'done' }] }, append: false } })
      send({ statusUpdate: { taskId, contextId, status: { state: 'TASK_STATE_COMPLETED' } } })
      res.end()
    }, 1200)
    timers.add(interval); timers.add(end)
    res.on('close', () => { clearInterval(interval); clearTimeout(end); timers.delete(interval); timers.delete(end) })
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const config = parseConfig({ timeoutMs: 400, agents: [{ name: 'remote', role: 'business', cardUrl: `${origin}/card` }] })
  return { config, client: new A2AClient(config), counts: () => ({ sends, gets, cancels, beats }), async close() {
    for (const timer of timers) clearTimeout(timer)
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  } }
}

for (const mode of ['heartbeat', 'progress'] as const) test(`${mode} renews idle time beyond the old total timeout, without query or resend`, async () => {
  const f = await fixture(mode)
  const updates: string[] = []
  try {
    const result = await f.client.send('remote', 'only once', { contextId: 'session-1', onUpdate: value => updates.push(value.text) })
    assert.equal(result.text, 'done')
    assert.equal(result.state, 'TASK_STATE_COMPLETED')
    assert.ok(f.counts().beats > 5)
    assert.deepEqual({ ...f.counts(), beats: 0 }, { sends: 1, gets: 0, cancels: 0, beats: 0 })
    if (mode === 'heartbeat') assert.deepEqual(updates, ['', 'done', 'done'], 'heartbeat never produces a UI update')
    assert.ok(updates.every(text => !text.includes('HEARTBEAT')))
  } finally { await f.close() }
})

for (const mode of ['silence', 'comments', 'duplicate'] as const) test(`${mode} cannot keep the stream alive`, async () => {
  const f = await fixture(mode)
  try {
    await assert.rejects(f.client.send('remote', 'wait', { contextId: 'session-1' }), /A2A idle timeout after 400ms.*taskId=task-1; remoteCancellation=confirmed/)
    assert.equal(f.counts().gets, 0)
    assert.equal(f.counts().cancels, 1)
    assert.equal(f.counts().sends, 1)
  } finally { await f.close() }
})

for (const mode of ['invalid', 'wrong-context'] as const) test(`${mode} heartbeat fails the contract instead of pretending to be activity`, async () => {
  const f = await fixture(mode)
  try {
    await assert.rejects(f.client.send('remote', 'wait', { contextId: 'session-1' }), /HEARTBEAT.*(invalid|another task\/context).*remoteCancellation=confirmed/)
  } finally { await f.close() }
})

test('hard maximum remains effective while valid heartbeats arrive', async () => {
  const f = await fixture('heartbeat')
  try {
    const client = new A2AClient({ ...f.config, maxDurationMs: 700 })
    await assert.rejects(client.send('remote', 'wait'), /A2A max duration exceeded after 700ms.*remoteCancellation=confirmed/)
    assert.ok(f.counts().beats > 3)
  } finally { await f.close() }
})

test('caller cancellation is distinct from timeout and still cancels the remote task', async () => {
  const f = await fixture('heartbeat')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 220)
  try {
    await assert.rejects(f.client.send('remote', 'wait', { signal: controller.signal }), /A2A cancelled by caller.*remoteCancellation=confirmed/)
    assert.equal(f.counts().cancels, 1)
  } finally { clearTimeout(timer); await f.close() }
})

test('a cancel response without canceled status is not reported as confirmed', async () => {
  const f = await fixture('silence', 'TASK_STATE_WORKING')
  try { await assert.rejects(f.client.send('remote', 'wait'), /idle timeout.*remoteCancellation=unknown/) }
  finally { await f.close() }
})

test('pre-aborted calls do not send, and failed connection still disposes liveness', async () => {
  const f = await fixture('heartbeat')
  try {
    await assert.rejects(f.client.send('remote', 'no', { signal: AbortSignal.abort() }), /cancelled by caller/)
    assert.equal(f.counts().sends, 0)
    await assert.rejects(f.client.send('missing', 'no'), /unavailable/)
  } finally { await f.close() }
})

test('heartbeat schema validates, deduplicates and binds task/context', () => {
  const reader = new HeartbeatReader('session')
  const beat = heartbeatArtifact('task', 1)
  assert.equal(reader.read(beat, 'task', 'session', 'task'), true)
  assert.equal(reader.read(beat, 'task', 'session', 'task'), false)
  assert.throws(() => reader.read(heartbeatArtifact('task', 2), 'other', 'session', 'task'), /another task\/context/)
  assert.throws(() => reader.read(beat, 'task', 'other', 'task'), /another task\/context/)
  assert.equal(reader.read(Artifact.fromJSON({ artifactId: 'text', parts: [{ text: 'pong' }] }), 'task', 'session'), undefined)
  for (const change of [
    (a: Artifact) => { a.metadata!.extension = 'wrong' },
    (a: Artifact) => { a.parts.push(a.parts[0]) },
    (a: Artifact) => { a.parts = Artifact.fromJSON({ parts: [{ text: 'HEARTBEAT' }] }).parts },
    (a: Artifact) => { (a.parts[0].content!.value as any).sequence = 0 },
    (a: Artifact) => { (a.parts[0].content!.value as any).timestamp = 'now' },
  ]) {
    const invalid = heartbeatArtifact('task', 2); change(invalid)
    assert.throws(() => reader.read(invalid, 'task', 'session'), /invalid/)
  }
})

test('liveness timers are cleared on completion and cannot be restarted after disposal', async () => {
  const life = new CallLiveness(30, 40)
  life.dispose(); life.touch()
  await sleep(60)
  assert.equal(life.signal.aborted, false)
  assert.equal(parseConfig({}).maxDurationMs, 0)
  for (const maxDurationMs of [-1, 0.5, 86400001]) assert.throws(() => parseConfig({ maxDurationMs }), /Invalid A2A/)
})

for (const legacy of [false, true]) test(`reference executor pushes the contract over ${legacy ? '0.3' : '1.0'} without displaying it`, async () => {
  const agent = createA2AServer({ name: 'reference', role: 'business', description: 'test', publicUrl: 'http://127.0.0.1:1', localDemo: true, heartbeatIntervalMs: 60 }, async () => {
    await sleep(1100); return 'reference done'
  })
  const app = express()
  if (legacy) app.get('/card', (_req, res) => res.json({
    name: 'reference', description: 'test', version: '1', protocolVersion: '0.3.0',
    url: agent.card.supportedInterfaces[0].url, preferredTransport: 'JSONRPC', capabilities: { streaming: true },
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [],
  }))
  app.use(agent.app)
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  for (const iface of agent.card.supportedInterfaces) iface.url = `${origin}/a2a`
  try {
    const client = new A2AClient(parseConfig({ timeoutMs: 400, agents: [{ name: 'reference', role: 'business', cardUrl: `${origin}/${legacy ? 'card' : '.well-known/agent-card.json'}` }] }))
    const result = await client.send('reference', 'hello', { contextId: 'dsh-session' })
    assert.equal(result.text, 'reference done')
    const sdk = await client.connect('reference')
    const task = await sdk.getTask({ id: result.taskId!, tenant: '' })
    const beats = task.artifacts.filter(a => a.name === HEARTBEAT_ARTIFACT)
    assert.equal(beats.length, 1, 'fixed artifact ID replaces rather than accumulating heartbeats')
    assert.equal(beats[0].metadata?.extension, HEARTBEAT_EXTENSION)
    assert.equal((await client.get('reference', result.taskId!)).text, 'reference done')
  } finally { await agent.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
