import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import express from 'express'
import { Artifact } from '@a2a-js/sdk'
import { BlockAssembler, ToolCallId, type ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { A2AClient } from '../src/client.js'
import { AGUI_EXTENSION, AgUiTraceReader, type AgUiRecord } from '../src/agui.js'
import { AgUiDshRun } from '../src/agui-dsh.js'

const events = [
  { type: 'RUN_STARTED', runId: 'run', threadId: 'thread' },
  { type: 'STEP_STARTED', stepName: 'model-1' },
  { type: 'REASONING_MESSAGE_START', messageId: 'r1', role: 'reasoning' },
  { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: '先查状态' },
  { type: 'REASONING_MESSAGE_END', messageId: 'r1' },
  { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '我先查询。' },
  { type: 'TOOL_CALL_START', toolCallId: 'call', toolCallName: 'lookup', parentMessageId: 'm1' },
  { type: 'TOOL_CALL_ARGS', toolCallId: 'call', delta: '{"id":' },
  { type: 'TOOL_CALL_ARGS', toolCallId: 'call', delta: '"123"}' },
  { type: 'TOOL_CALL_END', toolCallId: 'call' },
  { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
  { type: 'STEP_FINISHED', stepName: 'model-1' },
  { type: 'TOOL_CALL_RESULT', toolCallId: 'call', messageId: 'result', content: '任务尚未同步', role: 'tool' },
  { type: 'STEP_STARTED', stepName: 'model-2' },
  { type: 'TEXT_MESSAGE_START', messageId: 'm2', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm2', delta: '稍后重试。' },
  { type: 'TEXT_MESSAGE_END', messageId: 'm2' },
  { type: 'STEP_FINISHED', stepName: 'model-2' },
  { type: 'RUN_FINISHED', runId: 'run', threadId: 'thread' },
]
const answer = { agent: 'backend', taskId: 'run', contextId: 'thread', state: 'TASK_STATE_COMPLETED', text: '我先查询。稍后重试。' }
function artifact(items: readonly Record<string, unknown>[] = events, start = 1) {
  return Artifact.fromJSON({ artifactId: 'trace', name: 'ag-ui.events', metadata: { extension: AGUI_EXTENSION },
    parts: items.map((data, index) => ({ data, metadata: { [AGUI_EXTENSION]: { schemaVersion: 1, runId: 'run', threadId: 'thread', sequence: start + index } } })),
  })
}
const records = () => new AgUiTraceReader().read(artifact())
const assemble = async (run: AgUiDshRun) => {
  const assembler = new BlockAssembler()
  for await (const chunk of run.stream()) assembler.push(chunk)
  return assembler
}

test('official AG-UI schemas validate events, and Task snapshot replays are deduplicated', () => {
  const reader = new AgUiTraceReader()
  assert.equal(reader.read(artifact()).length, events.length)
  assert.equal(reader.read(artifact()).length, 0)
  assert.doesNotThrow(() => reader.assertEnded())
})
test('trace reader rejects missing first frames, sequence gaps, schema and run mismatches', () => {
  assert.throws(() => new AgUiTraceReader().read(artifact(events.slice(1), 2)), /缺失/)
  assert.throws(() => new AgUiTraceReader().read(artifact(events.slice(1))), /首事件/)
  const reader = new AgUiTraceReader()
  reader.read(artifact(events.slice(0, 1)))
  assert.throws(() => reader.read(artifact(events.slice(2, 3), 3)), /缺失/)
  assert.throws(() => reader.assertEnded(), /中断/)
  const invalid = artifact(events.slice(0, 1))
  invalid.metadata!.extension = 'other'
  assert.throws(() => new AgUiTraceReader().read(invalid), /扩展标识/)
  const wrongRun = artifact([{ type: 'RUN_STARTED', runId: 'other', threadId: 'thread' }])
  assert.throws(() => new AgUiTraceReader().read(wrongRun), /标识不一致/)
  const bad = artifact([{ type: 'UNKNOWN' }])
  assert.throws(() => new AgUiTraceReader().read(bad), /schema/)
})

test('one remote run becomes native reasoning, two assistant steps and a recorded tool result, with no duplicate text', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let requests = 0
  const run = new AgUiDshRun(async (_signal, update, trace) => {
    requests++
    for (const record of records()) {
      if (record.event.type === 'TOOL_CALL_RESULT') await gate
      trace!(record)
      if (record.event.type === 'TEXT_MESSAGE_CONTENT') update({ ...answer, text: record.event.delta })
    }
    return answer
  }, new AbortController().signal)
  const session = Session.create(SessionId(crypto.randomUUID()))
  const agent = { session } as Agent
  try {
    const first = await assemble(run)
    assert.equal(first.finish.kind, 'tool-calls')
    assert.deepEqual(first.blocks().slice(0, 2), [{ type: 'reasoning', text: '先查状态' }, { type: 'text', text: '我先查询。' }])
    const call = first.blocks().find(block => block.type === 'tool-call')! as ToolCallBlock
    assert.equal(call.name, 'a2a.lookup')
    assert.equal(call.arguments, '{"id":"123"}')
    const replay = run.replayTools({ calls: [call], signal: new AbortController().signal, agent, log: { turn: 1, step: 1 } })
    await sleep(10)
    assert.equal(session.snapshotEvents().filter(e => e.type === 'tool/call').length, 1, 'native pending tool exists before remote result')
    assert.equal(session.snapshotEvents().filter(e => e.type === 'tool/result').length, 0)
    release()
    const outcome = await replay
    assert.equal(outcome.results[0].result.content[0].type, 'text')
    assert.equal(outcome.concluded, false)
    const final = await assemble(run)
    assert.equal(final.finish.kind, 'stop')
    assert.deepEqual(final.blocks(), [{ type: 'text', text: '稍后重试。' }])
    assert.equal(requests, 1)
    const result = session.snapshotEvents().find(e => e.type === 'tool/result')!
    assert.equal(result.type === 'tool/result' && result.data.message.source.callId, call.id)
  } finally { release(); await run.close() }
})

test('plain A2A fallback remains streamed and final snapshots do not duplicate the answer', async () => {
  const run = new AgUiDshRun(async (_signal, update) => {
    update({ ...answer, text: '你好' }); update({ ...answer, text: '你好世界' })
    return { ...answer, text: '你好世界' }
  }, new AbortController().signal)
  try { assert.deepEqual((await assemble(run)).blocks(), [{ type: 'text', text: '你好世界' }]) }
  finally { await run.close() }
})

test('multiple remote tool results may arrive out of order, and a tools-only run ends without an extra native model step', async () => {
  const items = [
    ...events.slice(0, 11),
    { type: 'TOOL_CALL_START', toolCallId: 'second', toolCallName: 'other', parentMessageId: 'm1' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'second', delta: '{}' },
    { type: 'TOOL_CALL_END', toolCallId: 'second' },
    ...events.slice(11, 13),
    { type: 'TOOL_CALL_RESULT', toolCallId: 'second', messageId: 'r-second', content: 'second result' },
    events[13], events.at(-1)!,
  ]
  const run = new AgUiDshRun(async (_signal, _update, trace) => {
    for (const record of new AgUiTraceReader().read(artifact(items))) trace!(record)
    return { ...answer, text: '我先查询。' }
  }, new AbortController().signal)
  try {
    const first = await assemble(run)
    const calls = first.blocks().filter((block): block is ToolCallBlock => block.type === 'tool-call')
    assert.equal(calls.length, 2)
    const session = Session.create(SessionId(crypto.randomUUID()))
    const input = { agent: { session } as Agent, signal: new AbortController().signal, log: { turn: 1, step: 1 } }
    await assert.rejects(run.replayTools({ ...input, calls: [{ ...calls[0], name: 'bash' }] }))
    const result = await run.replayTools({ ...input, calls })
    assert.equal(result.concluded, true)
    assert.deepEqual(result.results.map(r => r.callId), calls.map(c => c.id))
    assert.equal(session.snapshotEvents().filter(e => e.type === 'tool/result').length, 2)
  } finally { await run.close() }
})

test('remote run errors and missing terminal events fail rather than claim success', async () => {
  for (const fail of [false, true]) {
    const run = new AgUiDshRun(async (_signal, _update, trace) => {
      trace!(records()[0])
      if (fail) trace!({ ...records()[0], sequence: 2, event: { type: 'RUN_ERROR', message: '业务执行失败' } as AgUiRecord['event'] })
      return answer
    }, new AbortController().signal)
    try { await assert.rejects(assemble(run), fail ? /业务执行失败/ : /结束事件/) }
    finally { await run.close() }
  }
})

test('tool replay rejects undeclared invocations and cancellation releases a waiting stream', async () => {
  const controller = new AbortController()
  const run = new AgUiDshRun(async signal => { await sleep(10000, undefined, { signal }); return answer }, controller.signal)
  const waiting = assemble(run)
  await assert.rejects(run.replayTools({ agent: { session: Session.create(SessionId('test')) } as Agent,
    calls: [{ type: 'tool-call', id: ToolCallId('forged'), name: 'bash', arguments: '{}' }],
    signal: controller.signal, log: { turn: 1, step: 1 },
  }), /batch|invocation|tool/i)
  controller.abort()
  await assert.rejects(waiting)
  await run.close()
})

for (const stream of [true, false]) test(`A2A SDK negotiates the extension, decodes artifacts and deduplicates ${stream ? 'stream' : 'poll'} snapshots`, async () => {
  const app = express(); app.use(express.json())
  let origin = '', calls = 0
  const task = (complete: boolean) => ({ id: 'run', contextId: 'thread', status: { state: complete ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_WORKING' },
    artifacts: [Artifact.toJSON(artifact(complete ? events : events.slice(0, 1))), ...(complete ? [{ artifactId: 'text', parts: [{ text: answer.text }] }] : [])], history: [],
  })
  app.get('/card', (_req, res) => res.json({ name: 'backend', version: '1', capabilities: { streaming: true, extensions: [{ uri: AGUI_EXTENSION }] },
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain', 'application/json'], skills: [],
    supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: `${origin}/call` }],
  }))
  app.post('/call', (req, res) => {
    assert.equal(req.headers['a2a-extensions'], AGUI_EXTENSION)
    const { id, method } = req.body
    if (method === 'GetTask') { res.json({ jsonrpc: '2.0', id, result: task(true) }); return }
    calls++
    assert.ok(req.body.params.configuration.acceptedOutputModes.includes('application/json'))
    if (method === 'SendMessage') { res.json({ jsonrpc: '2.0', id, result: { task: task(false) } }); return }
    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('A2A-Extensions', AGUI_EXTENSION)
    const send = (result: unknown) => res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`)
    send({ task: task(false) })
    events.forEach((event, index) => {
      send({ artifactUpdate: { taskId: 'run', contextId: 'thread', artifact: Artifact.toJSON(artifact([event], index + 1)), append: index > 0 } })
      if (event.type === 'TEXT_MESSAGE_CONTENT') send({ artifactUpdate: { taskId: 'run', contextId: 'thread', append: index > 6,
        artifact: { artifactId: 'text', name: 'conversation_result', parts: [{ text: event.delta }] } } })
    })
    send({ statusUpdate: { taskId: 'run', contextId: 'thread', status: { state: 'TASK_STATE_COMPLETED' } } })
    res.end()
  })
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const client = new A2AClient({ role: 'personal', timeoutMs: 5000, pollIntervalMs: 50,
      agents: [{ name: 'backend', role: 'business', cardUrl: `${origin}/card` }],
    })
    const received: AgUiRecord[] = []
    const result = await client.send('backend', '查询', { stream, onTrace: record => received.push(record) })
    assert.equal(result.text, answer.text)
    assert.equal(received.length, events.length)
    assert.equal(calls, 1)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
