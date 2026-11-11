import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Role, SendMessageRequest, TaskState } from '@a2a-js/sdk'
import express from 'express'
import { createA2AServer, type ServerOptions } from '../src/server.js'
import { A2AClient } from '../src/client.js'
import { loadConfig, type A2AConfig } from '../src/config.js'
import * as plugin from '../src/plugin.js'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import type { Runner } from '../src/executor.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

async function fixture(runner: Runner, options: Partial<ServerOptions> = {}, legacy = false) {
  const agent = createA2AServer({ name: 'test-agent', description: 'test', role: 'business', publicUrl: 'http://127.0.0.1:1', localDemo: true, ...options }, runner)
  const app = express()
  if (legacy) app.get('/.well-known/agent-card.json', (_req, res) => res.json({
    name: 'test-agent', description: 'legacy test', version: '0.1.0', protocolVersion: '0.3.0',
    url: agent.card.supportedInterfaces[0].url, preferredTransport: 'JSONRPC',
    capabilities: { streaming: true }, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    skills: [{ id: 'assist', name: 'test', description: 'test', tags: ['test'] }],
  }))
  app.use(agent.app)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  for (const iface of agent.card.supportedInterfaces) iface.url = `${origin}/a2a`
  const config: A2AConfig = {
    role: 'personal', timeoutMs: 5000, pollIntervalMs: 50,
    agents: [{ name: 'test-agent', role: options.role ?? 'business', cardUrl: `${origin}/.well-known/agent-card.json` }],
  }
  return { agent, origin, config, client: new A2AClient(config), async close() {
    await agent.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  } }
}

test('official SDK sends a task and returns the remote artifact', async () => {
  const f = await fixture(async text => `资金任务待处理：${text}`)
  try {
    const result = await f.client.send('test-agent', '退款123')
    assert.equal(result.state, 'TASK_STATE_COMPLETED')
    assert.equal(result.text, '资金任务待处理：退款123')
    assert.ok(result.taskId)
    assert.equal((await f.client.get('test-agent', result.taskId)).text, result.text)
  } finally { await f.close() }
})

test('v1 streaming publishes Task first and includes an artifact and completed status', async () => {
  const f = await fixture(async () => 'done')
  try {
    const sdk = await f.client.connect('test-agent')
    assert.equal(sdk.protocolVersion, '1.0')
    const events = []
    for await (const event of sdk.sendMessageStream(SendMessageRequest.fromJSON({
      message: { messageId: crypto.randomUUID(), role: Role.ROLE_USER, parts: [{ text: 'hello' }] },
    }))) events.push(event)
    assert.equal(events[0].payload?.$case, 'task')
    assert.ok(events.some(e => e.payload?.$case === 'artifactUpdate'))
    assert.ok(events.some(e => e.payload?.$case === 'statusUpdate' && e.payload.value.status?.state === TaskState.TASK_STATE_COMPLETED))
  } finally { await f.close() }
})

for (const legacy of [false, true]) test(`streaming ${legacy ? '0.3' : '1.0'} exposes text before the runner finishes, without duplicated final text`, async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let finished = false
  const f = await fixture(async (_text, signal, emit) => {
    emit('星星')
    await gate
    signal.throwIfAborted()
    emit('回家了。')
    finished = true
    return '星星回家了。'
  }, {}, legacy)
  let sawPartial = false
  try {
    const result = await f.client.send('test-agent', '故事', { onUpdate: snapshot => {
      if (snapshot.text === '星星') {
        assert.equal(finished, false)
        sawPartial = true
        release()
      }
    } })
    assert.equal(sawPartial, true)
    assert.equal(result.text, '星星回家了。')
    assert.equal((await f.client.get('test-agent', result.taskId!)).text, result.text)
  } finally { release(); await f.close() }
})

for (const mode of ['explicit', 'capability'] as const) test(`non-streaming fallback: ${mode}`, async () => {
  const f = await fixture(async (_text, _signal, emit) => { emit('预览'); return '最终故事' })
  try {
    if (mode === 'capability') f.agent.card.capabilities!.streaming = false
    const result = await f.client.send('test-agent', 'hello', mode === 'explicit' ? { stream: false } : {})
    assert.equal(result.state, 'TASK_STATE_COMPLETED')
    assert.equal(result.text, '最终故事')
  } finally { await f.close() }
})

test('upstream failure after partial output is reported as failed', async () => {
  const f = await fixture(async (_text, _signal, emit) => { emit('未完的故事'); throw new Error('upstream disconnected') })
  try {
    const result = await f.client.send('test-agent', 'hello')
    assert.equal(result.state, 'TASK_STATE_FAILED')
    assert.equal(result.text, '未完的故事')
  } finally { await f.close() }
})

test('legacy 0.3 Agent Card is normalized and task calls use the compatible wire protocol', async () => {
  const f = await fixture(async text => `legacy: ${text}`, {}, true)
  try {
    const sdk = await f.client.connect('test-agent')
    assert.match(sdk.protocolVersion, /^0\.3/)
    const result = await f.client.send('test-agent', 'hello')
    assert.equal(result.state, 'TASK_STATE_COMPLETED')
    assert.equal(result.text, 'legacy: hello')
    assert.ok(result.taskId)
    assert.equal((await f.client.get('test-agent', result.taskId)).text, result.text)
  } finally { await f.close() }
})

test('nonblocking execution can be explicitly canceled and actually stops the runner', async () => {
  let stopped = false
  const f = await fixture(async (_text, signal) => {
    try { await sleep(30000, undefined, { signal }); return 'unexpected' }
    finally { stopped = true }
  })
  try {
    const result = await f.client.send('test-agent', 'wait', { wait: false })
    assert.ok(result.taskId)
    const cancelled = await f.client.cancel('test-agent', result.taskId)
    assert.equal(cancelled.state, 'TASK_STATE_CANCELED')
    assert.equal(stopped, true)
    assert.equal((await f.client.get('test-agent', result.taskId)).state, 'TASK_STATE_CANCELED')
  } finally { await f.close() }
})

test('business outbound policy excludes personal Agents', async () => {
  const f = await fixture(async () => 'done', { role: 'personal' })
  try {
    const business = new A2AClient({ ...f.config, role: 'business' })
    assert.deepEqual(await business.list(), [])
    await assert.rejects(business.send('test-agent', 'hello'), /disallowed/)
  } finally { await f.close() }
})

test('ingress verifies credentials and rejects business callers even if they claim a personal role', async () => {
  process.env.A2A_TEST_PERSONAL_TOKEN = 'personal-test-token'
  process.env.A2A_TEST_BUSINESS_TOKEN = 'business-test-token'
  const f = await fixture(async () => 'private', {
    role: 'personal', localDemo: false,
    principals: [
      { id: 'alice', role: 'personal', tokenEnv: 'A2A_TEST_PERSONAL_TOKEN' },
      { id: 'service', role: 'business', tokenEnv: 'A2A_TEST_BUSINESS_TOKEN' },
    ],
  })
  try {
    assert.equal((await fetch(`${f.origin}/a2a`, { method: 'POST' })).status, 401)
    assert.equal((await fetch(`${f.origin}/a2a`, { method: 'POST', headers: { authorization: 'Bearer business-test-token', 'x-agent-role': 'personal' } })).status, 403)
    const client = new A2AClient({ ...f.config, agents: [{ ...f.config.agents[0], tokenEnv: 'A2A_TEST_PERSONAL_TOKEN' }] })
    assert.equal((await client.send('test-agent', 'hello')).text, 'private')
  } finally { await f.close() }
})

test('tasks are isolated between authenticated callers', async () => {
  process.env.A2A_TEST_ALICE = 'alice-test'
  process.env.A2A_TEST_BOB = 'bob-test'
  const f = await fixture(async () => 'alice only', {
    localDemo: false, principals: [
      { id: 'alice', role: 'personal', tokenEnv: 'A2A_TEST_ALICE' },
      { id: 'bob', role: 'personal', tokenEnv: 'A2A_TEST_BOB' },
    ],
  })
  try {
    const alice = new A2AClient({ ...f.config, agents: [{ ...f.config.agents[0], tokenEnv: 'A2A_TEST_ALICE' }] })
    const bob = new A2AClient({ ...f.config, agents: [{ ...f.config.agents[0], tokenEnv: 'A2A_TEST_BOB' }] })
    const result = await alice.send('test-agent', 'secret')
    assert.ok(result.taskId)
    await assert.rejects(bob.get('test-agent', result.taskId))
  } finally { await f.close() }
})

test('timeout cancels the remote task instead of only disconnecting', async () => {
  let stopped = false
  const f = await fixture(async (_text, signal) => {
    try { await sleep(30000, undefined, { signal }); return 'unexpected' }
    finally { stopped = true }
  })
  try {
    const client = new A2AClient({ ...f.config, timeoutMs: 300 })
    await assert.rejects(client.send('test-agent', 'wait'), /remoteCancellation=confirmed/)
    assert.equal(stopped, true)
  } finally { await f.close() }
})

test('DSH Cordis loads the plugin, exposes tools to the model, and executes a real A2A call', async () => {
  const f = await fixture(async () => '插件调用成功')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-a2a-test-'))
  const ctx = new Context()
  try {
    const configFile = join(directory, 'config.json')
    await writeFile(configFile, JSON.stringify(f.config))
    assert.equal((await loadConfig(configFile)).nacos, undefined)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(NativeExecutor)
    await ctx.plugin(plugin, { configFile })
    assert.equal(ctx.tools.schemas().length, 4)
    assert.equal((await ctx.systemPrompt.assemble()).tools.length, 4)
    const id = SessionId(crypto.randomUUID())
    const agent = { id, session: Session.create(id) } as Agent
    const signal = new AbortController().signal
    const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'test', model: 'test' }, signal })
    const execute = async (name: string, args: unknown) => (await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId(crypto.randomUUID()), name, arguments: JSON.stringify(args) }],
      agent, toolSet, signal,
    })).results[0].result
    const agents = await execute('a2a_list_agents', {})
    assert.equal(agents.isError, false)
    assert.deepEqual(agents.value, [{ id: 'direct:test-agent', name: 'test-agent', displayName: 'test-agent',
      source: { id: 'direct', name: '直连 Card', kind: 'direct' }, role: 'business', description: '' }])
    const result = await execute('a2a_send_message', { agent: 'direct:test-agent', message: 'hello' })
    assert.equal(result.isError, false)
    assert.equal((result.value as { text: string }).text, '插件调用成功')
    assert.equal(result.concludesTurn, true)
    const collected = await execute('a2a_send_message', { agent: 'test-agent', message: 'collect', answerMode: 'collect' })
    assert.equal(collected.isError, false)
    assert.equal(collected.concludesTurn, undefined)
  } finally { await ctx.fiber.dispose(); await f.close(); await rm(directory, { recursive: true, force: true }) }
})
