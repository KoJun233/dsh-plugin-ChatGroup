import { z } from 'zod'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { remotePeerProjectionKey } from './peer-visibility.js'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { dshA2aRemotePeer: boolean }
}

interface State { seeded: boolean; hidden: boolean }

/** Fold old and new remote markers without rewriting or opening their histories. */
export const remotePeerProjection = {
  key: remotePeerProjectionKey,
  stateSchema: z.object({ seeded: z.boolean(), hidden: z.boolean() }),
  init: header => ({ seeded: header.isSeeded, hidden: false }),
  apply: (state, event) => {
    // A user-created ordinary fork inherits the remote descriptor and may append
    // newer ones. It is still a real conversation, not an internal peer.
    if (state.seeded || state.hidden || pluginRecordOf(event)?.type !== 'plugin:dsh-a2a/remote') return state
    return { ...state, hidden: true }
  },
  wire: { viewSchema: z.boolean(), view: state => state.hidden },
  stateVersion: 1,
} satisfies ProjectionDefinition<typeof remotePeerProjectionKey, State>
