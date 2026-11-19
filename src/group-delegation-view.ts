import { memberDelegationTool } from './group-contract.js'

function jsonObject(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || raw[0] !== '{') return
  try {
    const value: unknown = JSON.parse(raw)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch { /* An incomplete or malformed tool call is not a chat message. */ }
}

export function readDelegationRequest(name: unknown, raw: unknown) {
  if (name !== memberDelegationTool) return
  const value = jsonObject(typeof raw === 'string' ? raw.trimStart() : raw)
  if (typeof value?.memberId !== 'string' || !value.memberId || typeof value.task !== 'string') return
  const task = value.task.trim()
  if (!task) return
  return { memberId: value.memberId, task }
}

export function readDelegationReceipt(result: { isError?: boolean; content: readonly { type: string; text?: string }[] }) {
  if (result.isError || result.content.length !== 1 || result.content[0].type !== 'text') return
  // Most result events are unrelated. Don't parse large arbitrary tool bodies.
  const raw = result.content[0].text
  if (typeof raw !== 'string' || !raw.startsWith('{"status":"queued",')) return
  const value = jsonObject(raw)
  if (value?.status !== 'queued' || typeof value.memberId !== 'string' || typeof value.memberName !== 'string' || !value.memberName.trim()) return
  return { memberId: value.memberId, memberName: value.memberName }
}

/** Share the same rule for projecting the chat message and suppressing the raw tool card. */
export function delegationMessage(request: ReturnType<typeof readDelegationRequest>, receipt: ReturnType<typeof readDelegationReceipt>) {
  if (!request || !receipt || request.memberId !== receipt.memberId) return
  return { memberId: request.memberId, memberName: receipt.memberName, task: request.task }
}
