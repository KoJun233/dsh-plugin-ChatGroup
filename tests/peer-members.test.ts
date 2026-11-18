import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, ToolCallId, type LlmAdapter, type ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool, ToolExecutorUnavailableError } from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { PeerMembers } from '../src/peer-members.js'
import type { A2AClient } from '../src/client.js'
import type { AgUiRecord } from '../src/agui.js'

async function fixture() {
  let ctx = new Context()
  const root = ctx
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(NativeExecutor)
  let adapter!: LlmAdapter, localCalls = 0, remoteCalls = 0
  const sessions = new Map<string, Session>()
  const agents = new Map<string, Agent>()
  ctx.provide('agents', { get: (id: string) => agents.get(id), list: () => [...agents.values()] })
  ctx.provide('llm', { registerAdapter(_providers: string[], value: LlmAdapter) { adapter = value } })
  ctx.provide('sessions', { get: (id: string) => sessions.get(id) })
  // A local tool with the exact displayed name must never handle the remote call.
  ctx.tools.register(defineTool({ name: 'a2a.queryDocBlocks', description: 'Local execution sentinel', parameters: {},
    output: { schema: { type: 'json' }, render: () => [] },
    async execute() { localCalls++; return 'wrong local result' },
  }))
  await ctx.plugin({ name: 'peer-test-services', inject: ['tools', 'agents', 'llm', 'sessions'],
    apply(scoped: Context) { ctx = scoped },
  })
  const send: A2AClient['send'] = async (_name, text, options) => {
    remoteCalls++
    assert.equal(text, '排查')
    const events = [
      { type: 'RUN_STARTED', runId: 'run', threadId: 'thread' },
      { type: 'TOOL_CALL_START', toolCallId: 'query', toolCallName: 'queryDocBlocks' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'query', delta: '{"docId":"test-doc"}' },
      { type: 'TOOL_CALL_END', toolCallId: 'query' },
      { type: 'TOOL_CALL_RESULT', toolCallId: 'query', messageId: 'result', content: 'remote document content' },
      { type: 'RUN_FINISHED', runId: 'run', threadId: 'thread' },
    ]
    for (const event of events) options?.onTrace?.({ event, runId: 'run', threadId: 'thread' } as AgUiRecord)
    return { agent: 'backend', contextId: options?.contextId ?? 'thread', state: 'TASK_STATE_COMPLETED', text: '' }
  }
  const enter = async (remote: boolean) => {
    const session = Session.create(SessionId(crypto.randomUUID()))
    if (remote) appendPluginRecord(session, 'plugin:dsh-a2a/remote', { agent: 'backend', contextId: 'thread' })
    sessions.set(session.id, session)
    const agent = { id: session.id, session } as Agent
    const scope = createScope(ctx, agent)
    Object.assign(agent, { ctx: scope.ctx })
    agents.set(agent.id, agent)
    const detach = async () => {
      await scope.dispose()
      agents.delete(agent.id)
      agentEvents(ctx, agent).emit('agent/disposed', {})
    }
    await agentEvents(ctx, agent).serial('agent/created', { source: 'resume' })
    return { agent, detach }
  }
  const replay = async (agent: Agent) => {
    const assembler = new BlockAssembler()
    for await (const chunk of adapter.stream({ provider: 'dsh-a2a', model: 'remote', sessionId: agent.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: '排查' }] }],
    })) assembler.push(chunk)
    const calls = assembler.blocks().filter((block): block is ToolCallBlock => block.type === 'tool-call')
    assert.equal(calls.length, 1)
    return ctx.tools.execute({ agent, calls, signal: new AbortController().signal, log: { turn: 1, step: 1 } })
  }
  const local = (agent: Agent) => ctx.tools.execute({ agent, signal: new AbortController().signal,
    calls: [{ type: 'tool-call', id: ToolCallId(crypto.randomUUID()), name: 'a2a.queryDocBlocks', arguments: '{}' }],
  })
  return { ctx, enter, replay, local, client: { send }, calls: () => ({ localCalls, remoteCalls }),
    async close(peers?: PeerMembers) { await peers?.dispose(); await root.fiber.dispose() },
  }
}

for (const loadedBeforePlugin of [false, true]) test(`remote executor survives a peer resumed ${loadedBeforePlugin ? 'before' : 'after'} plugin startup without custom setup`, async () => {
  const f = await fixture()
  let peers: PeerMembers | undefined
  try {
    const local = await f.enter(false)
    const existing = loadedBeforePlugin ? await f.enter(true) : undefined
    peers = new PeerMembers(f.ctx, f.client)
    const peer = existing ?? await f.enter(true)
    const result = await f.replay(peer.agent)
    assert.equal(result.results[0].result.isError, false)
    assert.equal(result.results[0].result.value, 'remote document content')
    assert.deepEqual(f.calls(), { localCalls: 0, remoteCalls: 1 })
    assert.equal((await f.local(local.agent)).results[0].result.value, 'wrong local result')
    const logged = peer.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    assert.equal(logged.length, 1)
    assert.equal(logged[0].type === 'tool/result' && logged[0].data.message.isError, false)
    await peer.detach()
    await new Promise(resolve => setImmediate(resolve))
    await assert.rejects(f.local(peer.agent), ToolExecutorUnavailableError, 'peer disposal removes its scoped executor')
  } finally { await f.close(peers) }
})
