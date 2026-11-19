import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage, ToolCallId, LlmAdapter, LlmRuntime, markAgentLoopRequest, type GenerateOptions, type RequestMessage, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { buildForkSeed, Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { GroupRoom, type GroupRecord, type ConversationMember } from '../src/group.js'
import { GroupRuntime } from '../src/group-runtime.js'
import { MemberSelection, groupRemote } from '../src/group-contract.js'
import { memberMentions, routeMemberMessage } from '../src/group-routing.js'
import { A2AClient, type CallResult, type SendOptions } from '../src/client.js'
import { parseConfig } from '../src/config.js'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { memberDelegationTool, registerMemberDelegation } from '../src/group-tool.js'

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
function runtimeFixture(send: (name: string, text: string, options?: SendOptions) => Promise<CallResult>, session = Session.create(SessionId(crypto.randomUUID())), client?: A2AClient) {
  const ctx = new Context()
  new LlmRuntime(ctx)
  let respond: (messages: RequestMessage[]) => string = () => ''
  class AdvisorAdapter extends LlmAdapter {
    async listModels(provider: string) { return [{ provider, id: 'advisor', name: 'Advisor' }] }
    async *stream({ messages }: GenerateOptions): AsyncIterable<StreamChunk> {
      const text = respond(messages)
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['test'], new AdvisorAdapter())
  ctx.provide('systemPrompt', { context() { return () => {} }, tools() { return () => {} } })
  ctx.provide('agentPresets', { list: async () => [] })
  ctx.provide('sessions', { flush: async () => true })
  const followups: UserMessage[] = []
  const agent = { id: session.id, session, status: 'idle', followup: (m: UserMessage) => followups.push(m) } as unknown as Agent
  ctx.provide('agents', { get: (id: string) => id === agent.id ? agent : undefined, list: () => [agent] })
  const scope = createScope(ctx, agent)
  Object.assign(agent, { ctx: scope.ctx })
  if (client) client.send = send
  const runtime = new GroupRuntime(ctx, client ?? { list: async () => [], send }, {
    ask: async (_room, _member, _text, signal, update, _save, remote) => {
      assert.ok(remote, 'remote members execute through the native peer adapter')
      return remote(signal, update)
    },
    close: async () => {}, closeRoom: async () => {}, dispose: async () => {},
  })
  for (const member of members) runtime.room(agent.session).add(member)
  return { ctx, agent, runtime, followups, replyWith: (model: typeof respond) => { respond = model }, async dispose() { await runtime.dispose(); await scope.dispose(); await ctx.fiber.dispose() } }
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

test('user mentions preserve spaced names and ignore file references', () => {
  const roster = [...members, { id: 'local:english', name: 'English Practice' }]
  const text = '请 @English Practice hello，再 @故事助手写故事'
  assert.deepEqual(memberMentions(text, roster).map(m => text.slice(m.start, m.end)), ['@English Practice', '@故事助手'])
  assert.deepEqual(routeMemberMessage('@English Practice/file.ts', roster), { kind: 'main', members: [] })
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
  assert.equal(replay.contextId('story-assistant'), 'story-context')
  assert.equal(replay.contextId('oa'), 'oa-context')
  assert.equal(replay.messages[1].text, '小猫捡到星星')
  assert.equal(replay.messages[1].authorName, '故事助手')
  assert.equal(roomFixture().room.members.length, 0)
})

test('member transfers send only the current input and pin contextId to the DSH session', async () => {
  const requests: { name: string; text: string; options?: SendOptions }[] = []
  const f = runtimeFixture(async (name, text, options) => {
    requests.push({ name, text, options }); options?.onUpdate?.({ ...answer(name, '部分故事'), state: 'TASK_STATE_WORKING' })
    await sleep(120); return answer(name, `${name}最终答复`)
  })
  try {
    for (const [name, text] of [['story-assistant', '猫咪故事'], ['oa', 'OA机密'], ['story-assistant', '续写']]) await f.runtime.delegate(f.agent, name, text, { callId: crypto.randomUUID() })
    assert.deepEqual(requests.map(request => request.text), ['猫咪故事', 'OA机密', '续写'])
    assert.deepEqual(requests.map(request => request.options?.contextId), Array(3).fill(f.agent.session.id))
    const messages = f.runtime.room(f.agent.session).messages.filter(m => m.role === 'member')
    assert.equal(messages.length, 3); assert.equal(messages.at(-1)?.state, 'completed')
    assert.equal(f.agent.session.deriveMessages().filter(m => m.role === 'user').length, 0, 'tool does not create a second user message')
  } finally { await f.dispose() }
})

const userMessage = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const messageText = (message: RequestMessage) => message.content.map(block => block.type === 'text' ? block.text : '').join('')
const memberReply = (message: RequestMessage) => message.role === 'assistant' && message.source.provider === 'dsh-a2a'

async function prepare(f: ReturnType<typeof runtimeFixture>, messages: UserMessage[], turn: number, signal: AbortSignal) {
  const decision = await agentEvents(f.ctx, f.agent).waterfall('agent/pre-step', {
    messages, signal, turn, step: 1, modelSelection: { provider: 'test', model: 'advisor' },
  }, async () => ({ kind: 'enter', messages }))
  assert.equal(decision.kind, 'enter')
  return decision.messages
}

type Dispatch = { memberId: string; task: string }
async function enableDelegation(f: ReturnType<typeof runtimeFixture>) {
  await f.ctx.plugin(Tools)
  await f.ctx.plugin(NativeExecutor)
  registerMemberDelegation(f.ctx, f.runtime)
}
async function executeDelegation(f: ReturnType<typeof runtimeFixture>, args: unknown, signal: AbortSignal) {
  const toolSet = await f.ctx.tools.resolve({ agent: f.agent, modelSelection: { provider: 'test', model: 'advisor' }, signal })
  try {
    const [outcome] = (await f.ctx.tools.execute({ agent: f.agent, signal, toolSet,
      calls: [{ type: 'tool-call', id: ToolCallId(crypto.randomUUID()), name: memberDelegationTool, arguments: JSON.stringify(args) }],
    })).results
    return outcome.result
  } finally { toolSet.dispose() }
}

async function runTurn(f: ReturnType<typeof runtimeFixture>, messages: UserMessage[], turn: number, model: (history: RequestMessage[]) => string | Dispatch, usePrepared = true) {
  const signal = new AbortController().signal
  const session = f.agent.session
  session.append('turn/start', { turn })
  for (const message of await prepare(f, messages, turn, signal)) session.append('user/message', message, { surfaceOp: 'append' })
  const history = session.deriveMessages()
  Object.freeze(history)
  const config = { provider: 'test', model: 'advisor' }
  const prepared = usePrepared ? await f.ctx.llm.prepareCall(config, signal) : undefined
  const request = markAgentLoopRequest(Object.freeze({ ...prepared?.config ?? config, messages: history, sessionId: session.id, signal }))
  let modelError: unknown
  let dispatch: Dispatch | undefined
  f.replyWith(messages => { try {
    const reply = model(messages)
    if (typeof reply === 'string') return reply
    dispatch = reply
    return ''
  } catch (error) { modelError = error; throw error } })
  for await (const chunk of prepared ? prepared.stream(request) : f.ctx.llm.stream(request)) {
    if (modelError) throw modelError
    if (chunk.type === 'finish') assert.equal(chunk.reason.kind, 'stop')
  }
  if (dispatch) {
    const result = await executeDelegation(f, dispatch, signal)
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(result.concludesTurn, true)
    assert.deepEqual(result.value, { status: 'queued', memberId: dispatch.memberId,
      memberName: f.runtime.room(session).members.find(m => m.id === dispatch!.memberId)?.name })
  }
  await agentEvents(f.ctx, f.agent).serial('agent/turn-stopping', { signal, turn })
  const event = session.append('turn/end', { turn, reason: { kind: 'completed' } })
  f.ctx.emit('session/event', session, event)
}

test('direct @ history reaches the prepared advisor as a signed assistant message in order and is never persisted twice', async () => {
  const oldTask = '为什么示例工单 CASE-DEMO-A 没有关联附件？'
  const newTask = '再帮我看一下示例工单 CASE-DEMO-B 为什么未通过校验。'
  const publicReply = 'CASE-DEMO-A 缺少必填附件。'
  const requests: { text: string; contextId?: string }[] = []
  const f = runtimeFixture(async (name, text, options) => {
    requests.push({ text, contextId: options?.contextId })
    return answer(name, text === oldTask ? publicReply : 'CASE-DEMO-B 已核查。')
  })
  try {
    await enableDelegation(f)
    f.runtime.room(f.agent.session).add({ id: 'direct:DEMO_REVIEWER', name: 'DEMO_REVIEWER', kind: 'remote', remoteName: 'DEMO_REVIEWER', description: '审批' })
    await runTurn(f, [userMessage(`@DEMO_REVIEWER ${oldTask}`)], 1, () => assert.fail('direct @ must bypass the advisor model'))
    // Pre-step waits for the member even if the user queued their next question.
    await runTurn(f, [userMessage(newTask)], 2, history => {
      assert.deepEqual(history.map(m => m.role), ['user', 'assistant', 'user'])
      assert.deepEqual(history.map(messageText), [`@DEMO_REVIEWER ${oldTask}`, `DEMO_REVIEWER：\n${publicReply}`, newTask])
      assert.ok(memberReply(history[1]))
      assert.deepEqual(history[1].source, { kind: 'model', provider: 'dsh-a2a', model: 'member' })
      assert.equal(history[1].id, f.runtime.room(f.agent.session).messages[1].id)
      assert.deepEqual(f.agent.session.deriveMessages().map(m => m.role), ['user', 'user'], 'projection only affects the request')
      return { memberId: 'direct:DEMO_REVIEWER', task: '只查 CASE-DEMO-B 未通过校验的原因。' }
    })
    await runTurn(f, [userMessage('继续')], 3, history => {
      assert.deepEqual(history.filter(memberReply).map(messageText), [`DEMO_REVIEWER：\n${publicReply}`, 'DEMO_REVIEWER：\nCASE-DEMO-B 已核查。'])
      return '已看过两条答复。'
    }, false)
    assert.deepEqual(requests, [oldTask, '只查 CASE-DEMO-B 未通过校验的原因。'].map(text => ({ text, contextId: f.agent.session.id })))
    assert.deepEqual(f.runtime.room(f.agent.session).messages.filter(m => m.role === 'dispatch').map(m => m.author), ['用户', '顾问'])
    assert.deepEqual(f.followups, [], 'success must not wake the advisor')
  } finally { await f.dispose() }
})

test('explicit direct identity migration updates a live room without replacing its peer, pending task or history', async () => {
  const role = 'business' as const
  const direct = { name: 'demo_review', role, cardUrl: 'https://agent.example/card' }
  const client = new A2AClient(parseConfig({ agents: [direct] }))
  const sent: { address: string; text: string; taskId?: string; contextId?: string }[] = []
  const f = runtimeFixture(async (address, text, options) => {
    sent.push({ address, text, taskId: options?.taskId, contextId: options?.contextId })
    return answer(address, '已处理')
  }, undefined, client)
  try {
    const { session } = f.agent
    const room = f.runtime.room(session)
    const old = { kind: 'remote' as const, id: 'direct:demo_review', remoteName: 'direct:demo_review', name: 'demo_review', description: '', sessionId: 'original-peer' }
    room.add(old)
    const reply = room.message('member', old.id, '需要补资料', { authorName: old.name, state: 'input-required', contextId: session.id, taskId: 'same-task' })
    client.reconfigure(parseConfig({ agents: [{ ...direct, name: '审核助手', agentId: 'fixture-remote-id', legacyNames: [direct.name] }] }))
    const stable = 'direct:id:fixture-remote-id'
    assert.equal(room.members.find(m => m.id === stable)?.name, '审核助手')
    assert.equal(room.members.find(m => m.id === stable)?.sessionId, 'original-peer')
    assert.equal(room.members.some(m => m.id === old.id), false)
    assert.deepEqual(room.messages[0], reply, 'old signature and reply untouched')
    await runTurn(f, [userMessage('@审核助手 补充资料')], 1, () => assert.fail('a new name still routes directly'))
    await prepare(f, [], 2, new AbortController().signal)
    assert.deepEqual(sent, [{ address: stable, text: '补充资料', taskId: 'same-task', contextId: session.id }])
    assert.equal(room.messages.at(-1)?.authorName, '审核助手')
  } finally { await f.dispose() }
})

test('delegation rejects unknown IDs and waits for a successful parent turn; text alone cannot dispatch', async () => {
  const sent: string[] = []
  const f = runtimeFixture(async (name, text) => { sent.push(text); return answer(name, 'done') })
  try {
    await enableDelegation(f)
    await runTurn(f, [userMessage('仅显示说明')], 1, () => '@故事助手 不要把这句话发送出去')
    const signal = new AbortController().signal
    assert.deepEqual(sent, [])
    for (const args of [{ memberId: 'unjoined', task: 'task' }, { memberId: '故事助手', task: 'task' }, { memberId: 'story-assistant', task: '   ' }]) {
      assert.equal((await executeDelegation(f, args, signal)).isError, true)
    }
    const { session } = f.agent
    session.append('turn/start', { turn: 2 })
    assert.equal((await executeDelegation(f, { memberId: 'story-assistant', task: '会取消的任务' }, signal)).concludesTurn, true)
    assert.equal((await executeDelegation(f, { memberId: 'oa', task: '不能发第二单' }, signal)).isError, true)
    await agentEvents(f.ctx, f.agent).serial('agent/turn-stopping', { turn: 2, signal })
    assert.deepEqual(sent, [], 'tool result and stopping hook alone cannot execute remote work')
    const canceled = session.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    f.ctx.emit('session/event', session, canceled)
    await prepare(f, [], 3, signal)
    assert.deepEqual(sent, [])
    await runTurn(f, [userMessage('安排一下')], 3, () => ({ memberId: 'story-assistant', task: '只发送这条' }))
    await prepare(f, [], 4, signal)
    assert.deepEqual(sent, ['只发送这条'])
    for (const m of f.runtime.room(session).members) f.runtime.room(session).remove(m.id)
    assert.equal((await executeDelegation(f, { memberId: 'story-assistant', task: '已移除' }, signal)).isError, true)
  } finally { await f.dispose() }
})

test('forking at a remote reply keeps assistant history but detaches the inherited execution binding', async () => {
  const initial = runtimeFixture(async name => answer(name, 'not needed'))
  const room = initial.runtime.room(initial.agent.session)
  const source = initial.agent.session
  const bound = { ...members[0], sessionId: 'source-peer' }
  room.updateMember(bound)
  room.set({ busy: true, stage: 'member' })
  source.append('user/message', userMessage('@故事助手 写第一段'), { surfaceOp: 'append' })
  const message = room.message('member', bound.id, '尚未完成', { state: 'working', authorName: bound.name })
  const peer = { sessionId: bound.sessionId, turn: 1, seq: 5 }
  room.update(message, { text: '第一段正文', state: 'input-required', peer, contextId: source.id, taskId: 'source-task' })
  const cut = SessionSeq(source.seq - 1)
  room.set({ busy: false, stage: null })
  source.append('user/message', userMessage('分支不能带入这个问题'), { surfaceOp: 'append' })
  const seed = buildForkSeed(source.snapshotEvents(), cut)
  const inherited = SessionLogOffset(cut + 1)
  const id = SessionId(crypto.randomUUID())
  const header = { ...source.header, id, isSeeded: true }
  const child = runtimeFixture(async (name, text, options) => {
    assert.equal(text, '第二段')
    assert.equal(options?.contextId, child.agent.session.id)
    assert.equal(options?.taskId, undefined, 'a pending remote task cannot continue in a new context')
    return answer(name, text)
  }, Session.create(id, seed, header, inherited))
  try {
    const childRoom = child.runtime.room(child.agent.session)
    assert.equal(childRoom.state.busy, false)
    assert.deepEqual(childRoom.messages.map(m => m.role), ['member'], 'the inherited busy flag is not a crash')
    assert.equal(childRoom.members.find(m => m.id === bound.id)?.sessionId, undefined)
    assert.equal(room.members.find(m => m.id === bound.id)?.sessionId, 'source-peer')
    assert.deepEqual(childRoom.messages[0].peer, peer, 'existing replies still render from the original peer')
    await runTurn(child, [userMessage('继续讨论第一段')], 1, history => {
      assert.deepEqual(history.map(m => [m.role, messageText(m)]), [
        ['user', '@故事助手 写第一段'], ['assistant', '故事助手：\n第一段正文'], ['user', '继续讨论第一段'],
      ])
      return '顾问接着讨论。'
    })
    await child.runtime.delegate(child.agent, bound.id, '第二段', { callId: 'child-run' })
    childRoom.updateMember({ ...bound, sessionId: 'child-peer' })
    childRoom.set({ busy: true, stage: 'member' })
    const replay = Session.create(id, child.agent.session.snapshotEvents(), header, inherited)
    const reopened = runtimeFixture(async () => assert.fail('restore must not call the remote member'), replay)
    try {
      const reopenedRoom = reopened.runtime.room(replay)
      assert.equal(reopenedRoom.members.find(m => m.id === bound.id)?.sessionId, 'child-peer')
      assert.equal(reopenedRoom.messages.at(-1)?.role, 'notice', 'a child-owned busy run still reports interruptions')
    } finally { await reopened.dispose() }
  } finally { await child.dispose(); await initial.dispose() }
})

test('a reopened log replaces old recalls at the original position, and ignores non-final member output', async () => {
  const initial = runtimeFixture(async name => answer(name, '不应重新执行'))
  const { session } = initial.agent
  const room = initial.runtime.room(session)
  const firstUser = userMessage('第一条问题')
  session.append('user/message', firstUser, { surfaceOp: 'append' })
  const first = room.message('member', 'removed-member', '历史回复正文', { authorName: '已移除的成员' })
  const intermediate = userMessage('第二条问题')
  session.append('user/message', intermediate, { surfaceOp: 'append' })
  const legacy = createUserMessage({ source: { kind: 'dsh-a2a/member-reply', form: 'recall', replyId: first.id }, content: [{ type: 'text', text: 'old JSON recall' }] })
  session.append('user/message', legacy, { surfaceOp: 'append' })
  const advisor = createAssistantMessage({ source: { provider: 'test', model: 'advisor' }, content: [{ type: 'text', text: '顾问自己的答复' }] })
  session.append('assistant/message', { turn: 1, step: 1, message: advisor, stream: [] }, { surfaceOp: 'append' })
  room.message('member', 'oa', '请补充单据号', { state: 'input-required' })
  for (const state of ['working', 'failed', 'canceled'] as const) room.message('member', 'oa', '非最终结果', { state })
  await initial.dispose()
  const reopened = runtimeFixture(async () => assert.fail('replay must not call the remote member'), Session.create(session.id, session.snapshotEvents()))
  try {
    await runTurn(reopened, [userMessage('最新问题')], 2, history => {
      assert.deepEqual(history.map(m => [m.role, messageText(m)]), [
        ['user', '第一条问题'], ['assistant', '已移除的成员：\n历史回复正文'],
        ['user', '第二条问题'], ['assistant', '顾问自己的答复'],
        ['assistant', 'oa：\n请补充单据号'], ['user', '最新问题'],
      ])
      assert.equal(history.filter(memberReply).length, 2)
      assert.ok(reopened.agent.session.deriveMessages().some(m => m.id === legacy.id), 'upgrade never rewrites old events')
      return '普通回复'
    })
  } finally { await reopened.dispose() }
})

test('compaction of a routed input does not resurrect the associated member reply', async () => {
  const f = runtimeFixture(async () => assert.fail('only read historical replies'))
  try {
    const session = f.agent.session
    const old = session.append('user/message', userMessage('旧问题'), { surfaceOp: 'append' })
    f.runtime.room(session).message('member', 'oa', '已经被裁剪轮次的答复')
    session.append('user/message', createUserMessage({ source: { kind: 'system-prompt' }, content: [{ type: 'text', text: '历史摘要' }] }),
      { surfaceOp: { op: 'replace', startSeq: old.seq, endSeq: old.seq }, sourceEventSeqs: [old.seq] })
    const retained = userMessage('保留的问题')
    session.append('user/message', retained, { surfaceOp: 'append' })
    f.runtime.room(session).message('member', 'oa', '保留的答复')
    await runTurn(f, [userMessage('最新问题')], 1, history => {
      assert.deepEqual(history.map(messageText), ['历史摘要', '保留的问题', 'oa：\n保留的答复', '最新问题'])
      return '普通回复'
    })
  } finally { await f.dispose() }
})

test('ordered multi-member handoff shares the prior assistant reply once and retains orchestration', async () => {
  const calls: string[] = []
  const f = runtimeFixture(async (name, text) => {
    calls.push(`${name}:${text}`)
    return answer(name, name === 'oa' ? 'OA已完成' : '故事已完成')
  })
  try {
    await enableDelegation(f)
    await runTurn(f, [userMessage('请 @故事助手 写故事，@OA助手查年假，最后总结')], 1, () => ({ memberId: 'story-assistant', task: '写故事' }))
    await prepare(f, [], 2, new AbortController().signal)
    assert.equal(f.followups.length, 1)
    await runTurn(f, [f.followups[0]], 2, history => {
      assert.deepEqual(history.map(m => m.source?.kind), ['user', 'model', 'dsh-a2a/handoff'])
      assert.equal(messageText(history[1]), '故事助手：\n故事已完成')
      assert.doesNotMatch(messageText(history[2]), /故事已完成/)
      return { memberId: 'oa', task: '查年假' }
    })
    await prepare(f, [], 3, new AbortController().signal)
    assert.equal(f.followups.length, 2)
    await runTurn(f, [f.followups[1]], 3, history => {
      assert.deepEqual(history.filter(memberReply).map(messageText), ['故事助手：\n故事已完成', 'OA助手：\nOA已完成'])
      assert.match(messageText(history.at(-1)!), /已全部完成/)
      return '总结'
    })
    assert.deepEqual(calls, ['story-assistant:写故事', 'oa:查年假'])
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
    return requests.length === 1 ? { ...answer(name, '主角叫什么名字？'), contextId: options!.contextId!, state: 'TASK_STATE_INPUT_REQUIRED', taskId: 'pending-one' } : answer(name, '完成')
  })
  try {
    await f.runtime.delegate(f.agent, 'story-assistant', '写故事', { callId: 'one' })
    await f.runtime.delegate(f.agent, 'story-assistant', '叫星星', { callId: 'two' })
    assert.equal(requests[0]?.contextId, f.agent.session.id)
    assert.equal(requests[1]?.contextId, f.agent.session.id)
    assert.equal(requests[1]?.taskId, 'pending-one')
  } finally { await f.dispose() }
})

test('pending tasks in old remote contexts are not attached to the DSH context', async () => {
  let request: SendOptions | undefined
  const f = runtimeFixture(async (name, _text, options) => { request = options; return answer(name, '完成') })
  try {
    f.runtime.room(f.agent.session).message('member', 'story-assistant', '名字？', {
      state: 'input-required', contextId: 'old-remote-context', taskId: 'old-pending-task',
    })
    await f.runtime.delegate(f.agent, 'story-assistant', '叫星星', { callId: 'migrate', contextId: 'old-remote-context', taskId: 'old-pending-task' })
    assert.equal(request?.contextId, f.agent.session.id)
    assert.equal(request?.taskId, undefined)
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
