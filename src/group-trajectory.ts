/** Native trajectory data at the plugin boundary, versioned with DSH 0.2.2. */
type NativeRecord = Record<string, any>
export interface TrajectoryInspection {
  eventNodes: NativeRecord[]
  eventLocations: Map<number, NativeRecord>
  requests: NativeRecord[]
  callSchemas: Map<string, unknown>
  systemPrompts?: NativeRecord[]
  partial: NativeRecord | null
  runningCalls: NativeRecord[]
}
export interface TrajectoryTransfer {
  anchorSeq: number
  message: { id: string; author: string; authorName?: string; peer?: { sessionId: string; turn: number; seq?: number } }
}
export interface TrajectoryAddress { sessionId: string; seq: number; author: string }

// These are view-only coordinates. Durable events and their original identities
// stay in their own sessions. Reserve a range per room event for its peer turn.
const SEQ_RANGE = 1_000_000
const EMPTY = { eventNodes: [], eventLocations: new Map(), requests: [], callSchemas: new Map(), partial: null, runningCalls: [] }

export function mergeGroupTrajectory(sessionId: string, main: TrajectoryInspection,
  transfers: readonly TrajectoryTransfer[], peers: ReadonlyMap<string, TrajectoryInspection>) {
  const addresses = new Map<number, TrajectoryAddress>()
  const authors = new Map<number, string>()
  const assistantAuthors = new Map<string, string>()
  const images = new WeakMap<object, string>()
  const steps = new Map<number, number>()
  const owningTurn = (transfer: TrajectoryTransfer) => {
    const node = main.eventNodes.findLast(node => node.seq < transfer.anchorSeq)
    return node?.turn ?? (node && main.eventLocations.get(node.seq)?.turn?.turn)
  }
  const ordered = transfers.filter(transfer => transfer.message.peer).toSorted((a, b) => a.anchorSeq - b.anchorSeq)
  const transferredTurns = new Set(ordered.map(owningTurn).filter(turn => turn !== undefined))
  const emptySteps = new Set(main.eventNodes.filter(node => node.kind === 'assistant' && node.blocks.length === 0 && transferredTurns.has(node.turn))
    .map(node => `${node.turn}:${node.step}`))
  const output: TrajectoryInspection = { ...EMPTY, eventNodes: [], eventLocations: new Map(), requests: [], callSchemas: new Map(), runningCalls: [], systemPrompts: [] }

  const source = (id: string, author: string, sequence: (seq: number) => number, turn: (turn: number) => number, step: (turn: number, step: number) => number) => {
    const seq = (value: number) => {
      const projected = sequence(value)
      if (!Number.isSafeInteger(projected)) throw new Error('轨迹事件超出可投影范围。')
      addresses.set(projected, { sessionId: id, seq: value, author }); authors.set(projected, author)
      return projected
    }
    const imageRefs = (value: any): void => {
      if (!value || typeof value !== 'object') return
      if (value.attachment && typeof value.attachment === 'object') images.set(value.attachment, id)
      if (value.type === 'image') {
        if (value.image && typeof value.image === 'object') images.set(value.image, id)
        if (value.ref && typeof value.ref === 'object') images.set(value.ref, id)
      }
      for (const child of Object.values(value)) if (child && typeof child === 'object') imageRefs(child)
    }
    const project = (value: NativeRecord): NativeRecord => {
      imageRefs(value)
      const result = { ...value }
      for (const key of ['seq', 'startSeq', 'resultSeq', 'endSeq']) if (typeof value[key] === 'number') result[key] = seq(value[key])
      if (typeof value.turn === 'number') result.turn = turn(value.turn)
      if (typeof value.step === 'number') result.step = step(value.turn, value.step)
      if (typeof result.turn === 'number' && typeof result.step === 'number') assistantAuthors.set(`assistant\u0000${result.turn}\u0000${result.step}`, author)
      if (value.callId !== undefined) result.callId = `${id}:${value.callId}`
      if (value.subCalls) result.subCalls = value.subCalls.map(project)
      if (value.blocks) result.blocks = value.blocks.map((block: NativeRecord) => block.callId === undefined ? block : { ...block, callId: `${id}:${block.callId}` })
      if (value.promptChange) result.promptChange = { ...value.promptChange, seq: seq(value.promptChange.seq) }
      return result
    }
    const append = (inspection: TrajectoryInspection) => {
      for (const node of inspection.eventNodes) {
        const result = project(node)
        output.eventNodes.push(result)
        const location = inspection.eventLocations.get(node.seq)
        if (location) output.eventLocations.set(result.seq, { ...location,
          ...(location.turn ? { turn: { ...location.turn, turn: turn(location.turn.turn) } } : {}),
          ...(location.step ? { step: { ...location.step, turn: turn(location.step.turn), step: step(location.step.turn, location.step.step) } } : {}),
        })
      }
      output.requests.push(...inspection.requests.map(project))
      output.systemPrompts!.push(...(inspection.systemPrompts ?? []).map(project))
      output.runningCalls.push(...inspection.runningCalls.map(project))
      for (const [callId, schema] of inspection.callSchemas) output.callSchemas.set(`${id}:${callId}`, schema)
      if (inspection.partial) output.partial = project(inspection.partial)
    }
    return { append }
  }

  const mainNodes = main.eventNodes.filter(node => !(node.kind === 'assistant' && emptySteps.has(`${node.turn}:${node.step}`)))
  for (const item of [...mainNodes, ...main.requests]) if (typeof item.turn === 'number' && typeof item.step === 'number' && !emptySteps.has(`${item.turn}:${item.step}`)) {
    steps.set(item.turn, Math.max(steps.get(item.turn) ?? 0, item.step))
  }
  source(sessionId, '主 Agent', seq => seq * SEQ_RANGE, turn => turn, (_turn, step) => step).append({ ...main, eventNodes: mainNodes,
    requests: main.requests.filter(request => !emptySteps.has(`${request.turn}:${request.step}`)) })
  const seen = new Set<string>()
  for (const transfer of ordered) {
    const peer = transfer.message.peer!
    const key = `${peer.sessionId}:${peer.turn}`
    const inspection = peers.get(peer.sessionId)
    const mainTurn = owningTurn(transfer)
    if (seen.has(key) || !inspection || mainTurn === undefined) continue
    seen.add(key)
    const belongs = (node: NativeRecord) => (node.turn ?? inspection.eventLocations.get(node.seq)?.turn?.turn) === peer.turn
    const turnNodes = inspection.eventNodes.filter(belongs)
    // The first peer input carries the room's existing question/dispatch.
    // Keep its native record in the peer session and request inspector, but
    // don't present it as another message from the person in the room.
    const forwardedInput = turnNodes.find(node => node.kind === 'user')
    const eventNodes = turnNodes.filter(node => node !== forwardedInput)
    const peerRequests = inspection.requests.filter(belongs)
    const runningCalls = inspection.runningCalls.filter(belongs)
    const partial = inspection.partial?.turn === peer.turn ? inspection.partial : null
    const firstSeq = peer.seq ?? Math.min(...turnNodes.map(node => node.seq), ...peerRequests.map(request => request.startSeq))
    // Peer initialization is an implementation detail of handoff. Real
    // prompt/tool changes during execution remain inspectable in the room.
    const requests = peerRequests.map(request => {
      if (!request.promptChange || request.promptChange.kind !== 'initial' && request.promptChange.seq >= firstSeq) return request
      const { promptChange: _initialization, ...execution } = request
      return execution
    })
    const lastSeq = Math.max(firstSeq, ...eventNodes.map(node => node.seq), ...requests.map(request => request.resultSeq ?? request.startSeq))
    const systemPrompts = (inspection.systemPrompts ?? []).filter(prompt => prompt.update && prompt.seq >= firstSeq && prompt.seq <= lastSeq)
    const base = Math.min(firstSeq, ...systemPrompts.map(prompt => prompt.seq), ...requests.flatMap(request => request.promptChange ? [request.promptChange.seq] : []))
    const offset = steps.get(mainTurn) ?? 0
    const peerStep = (_turn: number, step: number) => offset + step
    const maxStep = Math.max(0, ...eventNodes.map(node => node.step ?? 0), ...requests.map(request => request.step ?? 0), partial?.step ?? 0)
    steps.set(mainTurn, offset + maxStep)
    source(peer.sessionId, transfer.message.authorName || transfer.message.author, seq => {
      const relative = seq - base + 1
      if (relative < 0 || relative >= SEQ_RANGE) throw new Error('成员轨迹过长，无法放入当前轮次。')
      return transfer.anchorSeq * SEQ_RANGE + relative
    }, () => mainTurn, peerStep).append({ ...inspection, eventNodes, requests, runningCalls, partial, systemPrompts })
  }
  output.eventNodes.sort((a, b) => a.seq - b.seq)
  output.requests.sort((a, b) => a.startSeq - b.startSeq)
  return { inspection: output, addresses, authors, assistantAuthors, images, hasPeers: ordered.length > 0 }
}
