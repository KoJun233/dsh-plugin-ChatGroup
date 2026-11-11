export const agentLabel = (name: string): string => name === 'story-assistant' ? '故事助手' : name

export interface MentionMember { id: string; name: string; aliases?: readonly string[] }
export type MemberRoute = { kind: 'main'; members: string[] }
  | { kind: 'direct'; member: string; text: string }
  | { kind: 'notice'; text: string }

export function memberMentions(text: string, members: readonly MentionMember[]) {
  const aliases = new Map<string, MentionMember>()
  for (const member of members) {
    aliases.set(member.id, member); aliases.set(member.name, member)
    for (const alias of member.aliases ?? []) aliases.set(alias, member)
  }
  const names = [...aliases.keys()].filter(Boolean).sort((a, b) => b.length - a.length)
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

/** Only an explicit leading @ dispatch from the main Agent transfers this turn. */
export function administratorDispatch(text: string, members: readonly MentionMember[]) {
  const content = text.trim()
  const first = memberMentions(content, members)[0]
  if (!first || first.start !== 0) return
  const task = content.slice(first.end).trim()
  return task ? { member: first.member.id, text: task } : undefined
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
