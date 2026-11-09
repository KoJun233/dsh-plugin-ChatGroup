import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeGroupTrajectory, type TrajectoryInspection, type TrajectoryTransfer } from '../src/group-trajectory.js'

const inspection = (eventNodes: TrajectoryInspection['eventNodes'], rest: Partial<TrajectoryInspection> = {}): TrajectoryInspection => ({
  eventNodes, eventLocations: new Map(), requests: [], callSchemas: new Map(), partial: null, runningCalls: [], ...rest,
})
const member = (anchorSeq: number, sessionId: string, turn: number): TrajectoryTransfer => ({ anchorSeq,
  message: { id: `${anchorSeq}`, author: sessionId, authorName: `${sessionId}助手`, peer: { sessionId, turn, seq: 4 } },
})

test('trajectory merges delegated and direct peers into their originating room turns without blank routing replies', () => {
  const main = inspection([
    { kind: 'assistant', seq: 10, turn: 2, step: 1, blocks: [{ kind: 'text', text: '@故事助手 写故事' }] },
    { kind: 'assistant', seq: 20, turn: 3, step: 1, blocks: [{ kind: 'text', text: '@故事助手 续写' }] },
    { kind: 'assistant', seq: 30, turn: 4, step: 1, blocks: [] },
  ])
  const story = inspection([
    { kind: 'assistant', seq: 10, turn: 1, step: 1, blocks: [{ kind: 'text', text: '第一篇故事' }] },
    { kind: 'assistant', seq: 20, turn: 2, step: 1, blocks: [{ kind: 'text', text: '第二篇故事' }] },
    { kind: 'assistant', seq: 30, turn: 3, step: 1, blocks: [{ kind: 'text', text: '其他会话的任务' }] },
  ])
  const english = inspection([{ kind: 'assistant', seq: 10, turn: 1, step: 1, blocks: [{ kind: 'text', text: 'Hello' }] }])
  const result = mergeGroupTrajectory('room', main, [member(12, 'story', 1), member(22, 'story', 2), member(32, 'english', 1)], new Map([['story', story], ['english', english]]))
  assert.deepEqual(result.inspection.eventNodes.map(node => [node.turn, node.step, node.blocks[0]?.text]), [
    [2, 1, '@故事助手 写故事'], [2, 2, '第一篇故事'], [3, 1, '@故事助手 续写'], [3, 2, '第二篇故事'], [4, 1, 'Hello'],
  ])
  assert.equal(result.inspection.eventNodes.some(node => node.blocks.length === 0), false)
  assert.equal(new Set(result.inspection.eventNodes.map(node => node.seq)).size, 5)
  assert.deepEqual(result.inspection.eventNodes.map(node => result.authors.get(node.seq)), ['主 Agent', 'story助手', '主 Agent', 'story助手', 'english助手'])
  assert.equal(story.eventNodes[0].turn, 1, 'peer records are not rewritten')
  assert.equal(main.eventNodes[2].blocks.length, 0, 'historical main records are not rewritten')
})

test('trajectory preserves independent timing, request detail, schemas and addressable tool results across colliding ids', () => {
  const main = inspection([{ kind: 'assistant', seq: 3, turn: 1, step: 1, blocks: [{ kind: 'tool-call', callId: 'same', name: 'mainTool' }] }])
  const peer = inspection([
    { kind: 'assistant', seq: 9, turn: 1, step: 1, time: 1234, timing: { stepStartTime: 1000, firstTokenTime: 1100 }, usage: { outputTokens: 23 },
      blocks: [{ kind: 'tool-call', callId: 'same', name: 'peerTool' }] },
    { kind: 'tool-result', seq: 10, turn: 1, step: 1, callId: 'same', content: [{ type: 'text', text: '{"seq":42}' }], subCalls: [] },
  ], { requests: [{ purpose: 'assistant', turn: 1, step: 1, startSeq: 5, resultSeq: 9, prompt: { system: 'peer system prompt' }, promptChange: { seq: 4, kind: 'initial' }, startedAt: 1000, completedAt: 1234 }],
    systemPrompts: [{ seq: 1, text: 'peer system prompt' }], callSchemas: new Map([['same', { name: 'peerTool' }]]) })
  const result = mergeGroupTrajectory('room', main, [member(6, 'peer', 1)], new Map([['peer', peer]]))
  const node = result.inspection.eventNodes[1], tool = result.inspection.eventNodes[2], request = result.inspection.requests[0]
  assert.equal(node.blocks[0].callId, 'peer:same'); assert.equal(tool.callId, 'peer:same')
  assert.deepEqual(result.addresses.get(tool.seq), { sessionId: 'peer', seq: 10, author: 'peer助手' })
  assert.equal(request.resultSeq, node.seq); assert.equal(request.step, 2)
  assert.equal(request.completedAt, 1234); assert.equal(node.timing.stepStartTime, 1000)
  assert.equal(node.usage.outputTokens, 23); assert.equal(tool.content[0].text, '{"seq":42}')
  assert.deepEqual(result.inspection.callSchemas.get('peer:same'), { name: 'peerTool' })
  assert.equal(request.promptChange, undefined, 'peer initialization does not introduce a room system message')
  assert.deepEqual(request.prompt, { system: 'peer system prompt' }, 'native request detail retains the actual prompt')
  assert.deepEqual(result.inspection.systemPrompts, [])
  assert.equal(peer.requests[0].promptChange.kind, 'initial', 'the peer session retains its original prompt identity')
  assert.equal(peer.systemPrompts?.[0].update, undefined)
})

test('live peer partials keep their author and only expose the referenced peer turn', () => {
  const main = inspection([{ kind: 'assistant', seq: 3, turn: 7, step: 1, blocks: [] }])
  const peer = inspection([], { partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text: '生成中' }], timing: { stepStartTime: 123 } } })
  const result = mergeGroupTrajectory('room', main, [member(6, 'peer', 2)], new Map([['peer', peer]]))
  assert.equal(result.inspection.partial?.turn, 7); assert.equal(result.inspection.partial?.step, 1)
  assert.equal(result.assistantAuthors.get('assistant\u00007\u00001'), 'peer助手')
  assert.equal(result.inspection.eventNodes.length, 0)
})

test('peer request initialization before turn start is hidden without changing its execution', () => {
  const main = inspection([{ kind: 'assistant', seq: 3, turn: 1, step: 1, blocks: [] }])
  const peer = inspection([{ kind: 'assistant', seq: 9, turn: 1, step: 1, blocks: [{ kind: 'text', text: 'done' }] }], {
    requests: [{ purpose: 'assistant', turn: 1, step: 1, startSeq: 5, resultSeq: 9, promptChange: { seq: 1, kind: 'initial' } }],
  })
  const result = mergeGroupTrajectory('room', main, [member(6, 'peer', 1)], new Map([['peer', peer]]))
  assert.equal(result.inspection.requests[0].promptChange, undefined)
  assert.ok(result.inspection.requests[0].startSeq > 6_000_000)
  assert.equal(peer.requests[0].promptChange.kind, 'initial')
})

test('room shows one user input per handoff while retaining peer context and replies across delegated and direct turns', () => {
  const main = inspection([
    { kind: 'user', seq: 10, turn: 3, content: ['写故事'] },
    { kind: 'assistant', seq: 11, turn: 3, step: 1, blocks: [{ kind: 'text', text: '@story 写故事' }] },
    { kind: 'user', seq: 20, turn: 4, content: ['@english hello'] },
    { kind: 'assistant', seq: 21, turn: 4, step: 1, blocks: [] },
  ], { systemPrompts: [{ seq: 1, text: 'room system' }] })
  const peer = inspection([
    { kind: 'user', seq: 5, turn: 1, content: ['forwarded request'] },
    { kind: 'context', seq: 6, turn: 1, content: ['peer context'] },
    { kind: 'assistant', seq: 10, turn: 1, step: 1, blocks: [{ kind: 'text', text: 'member reply' }] },
  ], { requests: [{ purpose: 'assistant', turn: 1, step: 1, startSeq: 7, resultSeq: 10,
    prompt: { system: 'peer system', messages: ['forwarded request'] }, promptChange: { seq: 3, kind: 'initial' } }],
    systemPrompts: [{ seq: 1, text: 'peer system' }] })
  const before = structuredClone(peer)
  const result = mergeGroupTrajectory('room', main, [member(12, 'story', 1), member(22, 'english', 1)], new Map([['story', peer], ['english', peer]]))
  assert.deepEqual(result.inspection.eventNodes.map(node => [node.turn, node.kind]), [
    [3, 'user'], [3, 'assistant'], [3, 'context'], [3, 'assistant'],
    [4, 'user'], [4, 'context'], [4, 'assistant'],
  ])
  assert.equal(result.inspection.eventNodes.filter(node => node.kind === 'user').length, 2)
  assert.deepEqual(result.inspection.systemPrompts?.map(prompt => prompt.text), ['room system'])
  assert.ok(result.inspection.requests.every(request => !request.promptChange && request.prompt.messages[0] === 'forwarded request'))
  assert.deepEqual(peer, before, 'handoff input remains available in the independent peer session')
})

test('peer steering, tool changes and system updates during execution remain in group trajectory', () => {
  const main = inspection([{ kind: 'assistant', seq: 3, turn: 2, step: 1, blocks: [{ kind: 'text', text: '@peer work' }] }])
  const peer = inspection([
    { kind: 'user', seq: 5, turn: 1, content: ['forwarded request'] },
    { kind: 'assistant', seq: 8, turn: 1, step: 1, blocks: [{ kind: 'text', text: 'working' }] },
    { kind: 'steering', seq: 9, turn: 1, content: ['additional instructions'] },
    { kind: 'user', seq: 10, turn: 1, content: ['another real input'] },
    { kind: 'assistant', seq: 14, turn: 1, step: 2, blocks: [{ kind: 'text', text: 'done' }] },
  ], { requests: [
    { purpose: 'assistant', turn: 1, step: 1, startSeq: 6, resultSeq: 8, promptChange: { seq: 3, kind: 'initial' } },
    { purpose: 'assistant', turn: 1, step: 2, startSeq: 12, resultSeq: 14, promptChange: { seq: 11, kind: 'tools' } },
  ], systemPrompts: [{ seq: 1, text: 'initial prompt' }, { seq: 11, update: true, text: 'updated while working' }] })
  const result = mergeGroupTrajectory('room', main, [member(6, 'peer', 1)], new Map([['peer', peer]]))
  assert.deepEqual(result.inspection.eventNodes.map(node => node.kind), ['assistant', 'assistant', 'steering', 'user', 'assistant'])
  assert.deepEqual(result.inspection.systemPrompts?.map(prompt => prompt.text), ['updated while working'])
  assert.equal(result.inspection.requests[1].promptChange.kind, 'tools')
})
