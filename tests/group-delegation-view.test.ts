import assert from 'node:assert/strict'
import { test } from 'node:test'
import { delegationMessage, readDelegationReceipt, readDelegationRequest } from '../src/group-delegation-view.js'
import { memberDelegationTool } from '../src/group-contract.js'
import { currentMemberName } from '../src/group-routing.js'

const memberId = 'direct:id:original-id'
const args = JSON.stringify({ memberId, task: ' 查 CASE-DEMO-B。\n只读核查。 ' })
const receipt = (value: unknown, isError = false) => ({ isError, content: [{ type: 'text', text: JSON.stringify(value) }] })
const queue = { status: 'queued', memberId, memberName: '审核助手' }

test('an accepted delegation projects only the actual task and the original receipt display name', () => {
  assert.deepEqual(delegationMessage(readDelegationRequest(memberDelegationTool, args), readDelegationReceipt(receipt(queue))), {
    memberId, memberName: '审核助手', task: '查 CASE-DEMO-B。\n只读核查。',
  })
})

test('unrelated, incomplete, rejected or mismatched calls are not projected as adviser messages', () => {
  const request = readDelegationRequest(memberDelegationTool, args)
  const result = readDelegationReceipt(receipt(queue))
  assert.ok(request && result)
  assert.equal(readDelegationRequest('another_tool', args), undefined)
  assert.equal(readDelegationRequest(memberDelegationTool, '{"memberId":'), undefined)
  assert.equal(readDelegationRequest(memberDelegationTool, JSON.stringify({ memberId, task: ' ' })), undefined)
  assert.equal(delegationMessage(request, undefined), undefined)
  assert.equal(delegationMessage(undefined, result), undefined)
  assert.equal(delegationMessage(request, readDelegationReceipt(receipt(queue, true))), undefined)
  assert.equal(delegationMessage(request, readDelegationReceipt(receipt({ ...queue, memberId: 'different-id' }))), undefined)
  assert.equal(readDelegationReceipt(receipt({ ...queue, memberName: '' })), undefined)
  assert.equal(readDelegationReceipt(receipt({ ...queue, status: 'blocked' })), undefined)
})


test('chat labels prefer the current stable ID and follow an unambiguous migrated ID', () => {
  const legacyId = 'direct:DEMO_REVIEWER'
  const member = { id: memberId, name: '审核助手', previousIds: [legacyId] }
  const different = { id: 'direct:id:different-id', name: 'DEMO_REVIEWER' }
  assert.equal(currentMemberName([member, different], memberId), '审核助手')
  assert.equal(currentMemberName([member, different], legacyId), '审核助手')
  assert.equal(currentMemberName([{ ...member, name: '项目小助手' }], memberId), '项目小助手')
  assert.equal(currentMemberName([different], legacyId), undefined, 'no name-based reassignment')
  assert.equal(currentMemberName([member, { ...different, previousIds: [legacyId] }], legacyId), undefined)
  assert.equal(currentMemberName([member, { ...different, id: legacyId }], legacyId), 'DEMO_REVIEWER', 'exact identity comes first')
  assert.equal(currentMemberName([], memberId), undefined, 'caller falls back to recorded label on removal')
})
