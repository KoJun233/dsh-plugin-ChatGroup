import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { GroupRoom, type GroupRecord, type ConversationMember } from '../src/group.js'
import { GroupRuntime } from '../src/group-runtime.js'
import { MemberSelection, groupRemote } from '../src/group-contract.js'
import { administratorDispatch, memberMentions, routeMemberMessage } from '../src/group-routing.js'
import type { CallResult, SendOptions } from '../src/client.js'

const members: ConversationMember[] = [
  { id: 'story-assistant', name: '故事助手', kind: 'remote', remoteName: 'story-assistant', description: '故事创作' },
  { id: 'oa', name: 'OA助手', kind: 'remote', remoteName: 'oa', description: '年假查询' },
]
const answer = (agent: string, text: string): CallResult => ({ agent, contextId: `${agent}-context`, state: 'TASK_STATE_COMPLETED', text })
function roomFixture() {
  const records: GroupRecord[] = []
  const store = { read: () => records, append: (record: GroupRecord) => { records.push(record) } }
  return { room: new GroupRoom(store), records, store }
}
function runtimeFixture(send: (name: string, text: string, options?: SendOptions) => Promise<CallResult>) {
  const ctx = new Context()
  ctx.provide('systemPrompt', { context() { return () => {} } })
  ctx.provide('agentPresets', { list: async () => [] })
  ctx.provide('sessions', { flush: async () => true })
  const id = SessionId(crypto.randomUUID())
  const agent = { id, session: Session.create(id), status: 'idle' } as Agent
  const runtime = new GroupRuntime(ctx, { list: async () => [], send }, {
    ask: async (_room, _member, _text, signal, update, _save, remote) => {
      assert.ok(remote, 'remote members execute through the native peer adapter')
      return remote(signal, update)
    },
    close: async () => {}, closeRoom: async () => {}, dispose: async () => {},
  })
  for (const member of members) runtime.room(agent.session).add(member)
  return { ctx, agent, runtime, async dispose() { await runtime.dispose(); await ctx.fiber.dispose() } }
}

test('conversation candidates exclude shipped presets while preserving custom presets and existing members', async () => {
  const f = runtimeFixture(async name => answer(name, 'ok'))
  Object.assign(f.ctx.agentPresets, { list: async () => [
    ...['standard', 'ptc', 'minimal', 'cordis'].map(id => ({ id })),
    { id: 'story', name: '故事生成助手' }, { id: 'english', name: 'English Practice' },
    { id: 'custom', broken: 'invalid' },
  ] })
  try {
    f.runtime.room(f.agent.session).add({ id: 'local:standard', name: 'standard', description: '', kind: 'local', presetId: 'standard' })
    const state = await f.runtime.state(f.agent)
    assert.deepEqual(state.agents.map(a => a.id), ['local:story', 'local:english', 'local:custom'])
    assert.equal(state.agents[2].unavailable, '此预设暂不可用')
    assert.ok(state.members.some(m => m.id === 'local:standard'), 'filtering candidates preserves previously joined members')
    await assert.rejects(f.runtime.add(f.agent, { kind: 'local', id: 'local:ptc' }), /暂不可用/)
    await f.runtime.add(f.agent, { kind: 'local', id: 'local:english' })
    assert.ok(f.runtime.room(f.agent.session).members.some(m => m.id === 'local:english'))
    Object.assign(f.ctx.agentPresets, { list: async () => [{ id: 'standard', name: 'Custom standard' }] })
    assert.equal((await f.runtime.state(f.agent)).agents[0].name, 'Custom standard')
  } finally { await f.dispose() }
})

test('any-position mentions route directly, preserve native references and keep multi-member order', () => {
  assert.deepEqual(routeMemberMessage('帮我@故事助手写一个故事', members), { kind: 'direct', member: 'story-assistant', text: '帮我写一个故事' })
  assert.deepEqual(routeMemberMessage('写故事吧，@故事助手', members), { kind: 'direct', member: 'story-assistant', text: '写故事吧，' })
  assert.deepEqual(routeMemberMessage('请 @故事助手 写故事，@OA助手 查年假', members), { kind: 'main', members: ['story-assistant', 'oa'] })
  for (const text of ['继续写长一点', 'employee@example.com', '@src/app.ts 看文件', '@"故事助手" 看文件', '@unknown.txt']) {
    assert.deepEqual(routeMemberMessage(text, members), { kind: 'main', members: [] })
  }
  assert.equal(routeMemberMessage('@story-assistant-extra 任务', members).kind, 'main')
  assert.equal(routeMemberMessage('@故事助手', members).kind, 'notice')
  assert.match((routeMemberMessage('请@OA助手查年假', [members[0]], members) as { text: string }).text, /尚未加入/)
})

test('main dispatch requires an explicit leading joined member and preserves spaced names', () => {
  const roster = [...members, { id: 'local:english', name: 'English Practice' }]
  assert.deepEqual(administratorDispatch('  @English Practice hello  ', roster), { member: 'local:english', text: 'hello' })
  assert.deepEqual(administratorDispatch('@故事助手 写故事', roster), { member: 'story-assistant', text: '写故事' })
  for (const text of ['我建议 @故事助手 写故事', '@故事助手', '@English Practice/file.ts', '```\n@故事助手 写故事\n```', '@unknown 任务']) assert.equal(administratorDispatch(text, roster), undefined)
  const text = '请 @English Practice hello，再 @故事助手写故事'
  assert.deepEqual(memberMentions(text, roster).map(m => text.slice(m.start, m.end)), ['@English Practice', '@故事助手'])
  assert.deepEqual(routeMemberMessage('请 @English Practice hello', roster), { kind: 'direct', member: 'local:english', text: '请  hello' })
})

test('rosters replay independently, removal preserves signed history and member contexts', () => {
  const f = roomFixture()
  f.room.add(members[0]); f.room.add(members[0]); f.room.add(members[1])
  assert.equal(f.room.members.length, 2)
  f.room.message('dispatch', '顾问', '猫咪故事', { recipient: 'story-assistant' })
  f.room.message('member', 'story-assistant', '小猫捡到星星', { authorName: '故事助手', contextId: 'story-context' })
  f.room.message('dispatch', '顾问', 'OA机密', { recipient: 'oa' })
  f.room.message('member', 'oa', 'OA结果', { contextId: 'oa-context' })
  f.room.remove('story-assistant')
  const replay = new GroupRoom(f.store)
  assert.deepEqual(replay.members.map(m => m.id), ['oa'])
  const prompt = replay.memberPrompt('story-assistant', '续写')
  assert.match(prompt, /小猫捡到星星/); assert.doesNotMatch(prompt, /OA机密|OA结果/)
  assert.equal(replay.messages[1].authorName, '故事助手')
  assert.equal(roomFixture().room.members.length, 0)
})

test('member transfers stream durable replies and isolate each member history', async () => {
  const requests: { name: string; text: string; options?: SendOptions }[] = []
  const f = runtimeFixture(async (name, text, options) => {
    requests.push({ name, text, options }); options?.onUpdate?.({ ...answer(name, '部分故事'), state: 'TASK_STATE_WORKING' })
    await sleep(120); return answer(name, `${name}最终答复`)
  })
  try {
    for (const [name, text] of [['story-assistant', '猫咪故事'], ['oa', 'OA机密'], ['story-assistant', '续写']]) await f.runtime.delegate(f.agent, name, text, { callId: crypto.randomUUID() })
    assert.match(requests[2].text, /猫咪故事|story-assistant最终答复/)
    assert.doesNotMatch(requests[2].text, /OA机密|oa最终答复/)
    assert.equal(requests[2].options?.contextId, 'story-assistant-context')
    const messages = f.runtime.room(f.agent.session).messages.filter(m => m.role === 'member')
    assert.equal(messages.length, 3); assert.equal(messages.at(-1)?.state, 'completed')
    assert.equal(f.agent.session.deriveMessages().filter(m => m.role === 'user').length, 0, 'tool does not create a second user message')
  } finally { await f.dispose() }
})

test('concurrent member transfers execute sequentially', async () => {
  let active = 0, maximum = 0
  const order: string[] = []
  const f = runtimeFixture(async name => { maximum = Math.max(maximum, ++active); order.push(name); await sleep(20); active--; return answer(name, '完成') })
  try {
    await Promise.all(members.map(member => f.runtime.delegate(f.agent, member.id, '任务', { callId: crypto.randomUUID(), answerMode: 'collect' })))
    assert.equal(maximum, 1); assert.deepEqual(order, members.map(m => m.id))
  } finally { await f.dispose() }
})

test('cancellation and failure preserve partial output, and no unjoined member can execute', async () => {
  let calls = 0
  const f = runtimeFixture(async (name, _text, options) => {
    calls++; options?.onUpdate?.({ ...answer(name, '已生成的部分'), state: 'TASK_STATE_WORKING' })
    await sleep(10000, undefined, { signal: options?.signal }); return answer(name, '不会完成')
  })
  try {
    await assert.rejects(f.runtime.delegate(f.agent, 'unjoined', '任务', { callId: 'unknown' }), /尚未加入/)
    assert.throws(() => f.runtime.remoteName(f.agent, 'unjoined'), /尚未加入/)
    assert.equal(f.runtime.remoteName(f.agent, '故事助手'), 'story-assistant')
    const abort = new AbortController()
    const run = f.runtime.delegate(f.agent, 'story-assistant', '任务', { callId: 'cancel', signal: abort.signal })
    await sleep(10); abort.abort(); await assert.rejects(run)
    assert.equal(calls, 1)
    const reply = f.runtime.room(f.agent.session).messages.find(m => m.role === 'member')!
    assert.equal(reply.state, 'canceled'); assert.match(reply.text, /已生成的部分/)
  } finally { await f.dispose() }
})

test('input-required resumes only that member pending task', async () => {
  const requests: (SendOptions | undefined)[] = []
  const f = runtimeFixture(async (name, _text, options) => {
    requests.push(options)
    return requests.length === 1 ? { ...answer(name, '主角叫什么名字？'), state: 'TASK_STATE_INPUT_REQUIRED', taskId: 'pending-one' } : answer(name, '完成')
  })
  try {
    await f.runtime.delegate(f.agent, 'story-assistant', '写故事', { callId: 'one' })
    await f.runtime.delegate(f.agent, 'story-assistant', '叫星星', { callId: 'two' })
    assert.equal(requests[1]?.taskId, 'pending-one')
  } finally { await f.dispose() }
})

test('settings RPC has bounded validated selections, authorized native session lookup, and no send endpoint', () => {
  assert.equal(MemberSelection.safeParse({ kind: 'remote', id: 'x', url: 'http://untrusted' }).success, false)
  assert.equal('a2aGroup/send' in groupRemote.methods, false)
  for (const descriptor of groupRemote.descriptors) {
    assert.equal(descriptor.parameters[0].wire, 'agentId'); assert.equal(descriptor.parameters[0].lookup, 'agent')
    const codec = descriptor.parameters[0].codec
    if (codec.mode === 'strict') assert.equal(codec.typeSymbol, '@deepseek-ai/dsh-session/types#SessionId')
  }
})
