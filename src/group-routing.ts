export const agentLabel = (name: string): string => name === 'story-assistant' ? '故事助手' : name

/** Resolve display names by bound identity, never by a reused display name. */
export function currentMemberName(members: readonly { id: string; name: string; previousIds?: readonly string[] }[] | undefined, id: string): string | undefined {
  const exact = members?.find(member => member.id === id)
  if (exact) return exact.name
  let match: string | undefined
  for (const member of members ?? []) {
    if (!member.previousIds?.includes(id)) continue
    if (match !== undefined) return undefined // Conflicting old bindings: retain the recorded label.
    match = member.name
  }
  return match
}

export interface MentionMember { id: string; name: string; aliases?: readonly string[] }
export type MemberRoute = { kind: 'main'; members: string[] }
  | { kind: 'direct'; member: string; text: string }
  | { kind: 'notice'; text: string }

export function memberMentions(text: string, members: readonly MentionMember[]) {
  const aliases = new Map<string, MentionMember | null>()
  for (const member of members) {
    for (const alias of member.aliases ?? []) {
      const prior = aliases.get(alias)
      if (prior === undefined) aliases.set(alias, member)
      else if (prior?.id !== member.id) aliases.set(alias, null)
    }
  }
  // A currently configured display name/ID beats a historical alias.
  const display = new Map<string, MentionMember | null>()
  for (const member of members) {
    const prior = display.get(member.name)
    display.set(member.name, prior === undefined || prior?.id === member.id ? member : null)
  }
  for (const [name, member] of display) aliases.set(name, member)
  for (const member of members) aliases.set(member.id, member)
  const names = [...aliases.keys()].filter(name => Boolean(name && aliases.get(name))).sort((a, b) => b.length - a.length)
  const found: { member: MentionMember; start: number; end: number }[] = []
  for (const match of text.matchAll(/@/gu)) {
    const start = match.index
    if (start && /[A-Za-z0-9._%+\-]/u.test(text[start - 1])) continue
    const tail = text.slice(start + 1)
    const name = names.find(name => tail.startsWith(name) && !/^[./\\]/u.test(tail.slice(name.length)) &&
      !(/[A-Za-z0-9_\-]$/u.test(name) && /^[A-Za-z0-9_\-/\.]/u.test(tail.slice(name.length))))
    if (name) found.push({ member: aliases.get(name)!, start, end: start + name.length + 1 })
  }
  return found
}

/** Member names work anywhere; native file/session references keep their meaning. */
export function routeMemberMessage(text: string, joined: readonly MentionMember[], available: readonly MentionMember[] = joined): MemberRoute {
  const mentions = memberMentions(text, [...available, ...joined])
  for (const { member } of mentions) {
    if (!joined.some(m => m.id === member.id)) return { kind: 'notice', text: `@${member.name} 尚未加入当前会话，请在“⋯ → 会话设置”中先添加成员。` }
  }
  const ids = [...new Set(mentions.map(m => m.member.id))]
  if (ids.length !== 1) return { kind: 'main', members: ids }
  let task = text
  for (const mention of mentions.toReversed()) task = task.slice(0, mention.start) + task.slice(mention.end)
  task = task.trim()
  return task ? { kind: 'direct', member: ids[0], text: task } : { kind: 'notice', text: '请在 @成员 的消息中写下需要完成的任务。' }
}
