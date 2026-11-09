import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Session, SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { sseData } from '../src/sse.js'
import { storyRunner } from '../src/story-model.js'
import { progressWriter } from '../src/progress.js'

function bytes(text: string) {
  const encoded = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of encoded) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } })
}

test('SSE handles bytewise UTF-8, CRLF, comments, multiline data and incomplete EOF', async () => {
  const values = []
  for await (const data of sseData(bytes(': heartbeat\r\ndata: 星星\r\ndata: 回家\r\n\r\ndata: [DONE]\n\ndata: incomplete'))) values.push(data)
  assert.deepEqual(values, ['星星\n回家', '[DONE]'])
})

test('SSE early termination cancels the underlying reader', async () => {
  let canceled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')) },
    cancel() { canceled = true },
  })
  for await (const _data of sseData(body)) break
  assert.equal(canceled, true)
  assert.equal(body.locked, false)
})

test('story runner sends an authenticated streaming request and emits text before completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'story-model-'))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let request: any
  let endSent = false
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions')
    assert.equal(req.headers.authorization, 'Bearer test-only-key')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    request = JSON.parse(Buffer.concat(chunks).toString())
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"星星"}}]}\r\n\r\n')
    await gate
    endSent = true
    res.end('data: {"choices":[{"delta":{"content":"回家了。"}}]}\n\ndata: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const configFile = join(directory, 'model.json')
    await writeFile(configFile, JSON.stringify({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: 'test-only-key', model: 'test-story' }))
    const { run } = await storyRunner(configFile)
    const deltas: string[] = []
    const result = await run('写一个故事', AbortSignal.timeout(5000), delta => {
      if (!deltas.length) { assert.equal(endSent, false); release() }
      deltas.push(delta)
    })
    assert.equal(result, '星星回家了。')
    assert.equal(deltas.join(''), result)
    assert.equal(request.stream, true)
    assert.equal(request.model, 'test-story')
    assert.equal(request.messages[1].content, '写一个故事')
  } finally { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }) }
})

for (const [name, payload, expected] of [
  ['truncated', 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', /before \[DONE\]/],
  ['length', 'data: {"choices":[{"finish_reason":"length"}]}\n\ndata: [DONE]\n\n', /output limit/],
  ['error', 'data: {"error":{"message":"test"}}\n\n', /stream error/],
  ['empty', 'data: [DONE]\n\n', /no story/],
] as const) test(`story runner rejects ${name} streams`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'story-model-'))
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(payload) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const configFile = join(directory, 'model.json')
    await writeFile(configFile, JSON.stringify({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: 'test-only-key' }))
    const { run } = await storyRunner(configFile)
    await assert.rejects(run('故事', AbortSignal.timeout(5000), () => {}), expected)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }) }
})

test('native progress records are throttled, flushed at finish and excluded from model messages', async () => {
  const session = Session.create(SessionId(crypto.randomUUID()))
  const writer = progressWriter(session, 'call-1', 'story-assistant')
  writer.update({ agent: 'story-assistant', contextId: 'ctx', state: 'TASK_STATE_WORKING', text: '星星' })
  await sleep(230)
  writer.finish({ agent: 'story-assistant', contextId: 'ctx', state: 'TASK_STATE_COMPLETED', text: '星星回家了。' })
  writer.update({ agent: 'ignored', contextId: '', state: '', text: '' })
  const records = session.snapshotEvents().map(pluginRecordOf).filter(Boolean)
  assert.equal(records.length, 3)
  assert.equal((records[1]!.data as any).text, '星星')
  assert.equal((records[2]!.data as any).done, true)
  assert.deepEqual(session.deriveMessages(), [])
})
