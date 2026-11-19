import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset, appendPluginRecord } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { remotePeerProjection } from '../src/peer-visibility-projection.js'
import { remotePeerFlag, remotePeerProjectionKey as key, visiblePeerSessions } from '../src/peer-visibility.js'

test('visibility projection folds existing and new remote histories without changing Session metadata', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionProjections)
  const main = Session.create(SessionId('main'))
  const remote = Session.create(SessionId('old-peer'))
  appendPluginRecord(remote, 'plugin:dsh-a2a/remote', { agent: 'direct:DEMO_REVIEWER', contextId: main.id })
  const header = structuredClone(remote.header)
  const history = remote.snapshotEvents()
  const handle = await ctx.sessionProjections.register(remotePeerProjection)
  try {
    assert.equal(handle.stateOf(main).hidden, false)
    assert.equal(handle.stateOf(remote).hidden, true, 'old marker is recognized without migration')
    assert.ok(ctx.sessionProjections.summaryKeys().has(key))
    assert.equal(ctx.sessionProjections.snapshot(remote).values[key], true)
    assert.deepEqual(remote.header, header)
    assert.deepEqual(remote.snapshotEvents(), history)
    assert.equal(remote.header.origin, undefined, 'ordinary follow and activation APIs keep working')
    const fresh = Session.create(SessionId('fresh-peer'))
    assert.equal(handle.stateOf(fresh).hidden, false)
    appendPluginRecord(fresh, 'plugin:dsh-a2a/remote', { agent: 'backend', contextId: main.id })
    assert.equal(handle.stateOf(fresh).hidden, true)
    const local = Session.create(SessionId('local-member'))
    appendPluginRecord(local, 'plugin:dsh-a2a/group', { kind: 'members', id: '@members', revision: 1, members: [] })
    assert.equal(handle.stateOf(local).hidden, false)
  } finally { await handle.dispose(); await ctx.fiber.dispose() }
})

test('a user fork stays visible even after inheriting and appending remote descriptors', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionProjections)
  const source = Session.create(SessionId('peer'))
  appendPluginRecord(source, 'plugin:dsh-a2a/remote', { agent: 'backend' })
  const seed = source.snapshotEvents()
  const id = SessionId('user-fork')
  const branch = Session.create(id, seed, { ...source.header, id, isSeeded: true }, SessionLogOffset(seed.length))
  const handle = await ctx.sessionProjections.register(remotePeerProjection)
  try {
    assert.equal(handle.stateOf(branch).hidden, false)
    appendPluginRecord(branch, 'plugin:dsh-a2a/remote', { agent: 'backend', contextId: id })
    assert.equal(handle.stateOf(branch).hidden, false)
  } finally { await handle.dispose(); await ctx.fiber.dispose() }
})

test('only derived browser rows are filtered, including grouped, pinned and cached historical peers', () => {
  const list = {
    ids: ['main', 'peer', 'same-title', 'local', 'fork', 'unknown'], phase: 'ready',
    byId: {
      main: { title: 'direct:DEMO_REVIEWER', projectionValues: { [key]: false } },
      peer: { title: '任意标题', projectionValues: { [key]: true } },
      'same-title': { title: 'direct:DEMO_REVIEWER' },
      local: {}, fork: { projectionValues: { [key]: false } }, unknown: {},
    },
    projectionsBySession: {},
  }
  const filtered = visiblePeerSessions(list)
  assert.deepEqual(filtered.ids, ['main', 'same-title', 'local', 'fork', 'unknown'])
  assert.equal('peer' in filtered.byId, false, 'workspace/pinned membership cannot bring an internal row back')
  assert.ok('peer' in list.byId, 'retain, native chat, trajectory and global sessions service retain the original row')
  assert.equal(filtered.byId.main, list.byId.main)
  assert.equal(filtered.phase, 'ready')
  assert.equal(visiblePeerSessions(list), filtered, 'snapshot identity is stable for React')
  assert.equal(remotePeerFlag(list, 'unknown'), undefined, 'do not guess from a title or hide unknown metadata')
  const refreshed = { ...list, projectionsBySession: { peer: { values: { [key]: false } }, unknown: { values: { [key]: true } } } }
  assert.equal(remotePeerFlag(refreshed, 'peer'), false, 'live projection overrides a stale summary')
  assert.ok(visiblePeerSessions(refreshed).ids.includes('peer'))
  assert.ok(!visiblePeerSessions(refreshed).ids.includes('unknown'))
})
