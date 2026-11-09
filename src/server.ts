import { timingSafeEqual } from 'node:crypto'
import express, { type Request } from 'express'
import { AgentCard } from '@a2a-js/sdk'
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server'
import { agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express'
import { canCall, envSecret, httpUrl, type AgentRole } from './config.js'
import { TextExecutor, type Runner } from './executor.js'

export interface Principal { id: string; role: AgentRole; tokenEnv: string }
export interface ServerOptions {
  name: string
  description: string
  role: AgentRole
  publicUrl: string
  principals?: Principal[]
  /** Only the standalone, loopback-bound demo uses this. DSH ingress requires authentication. */
  localDemo?: boolean
  timeoutMs?: number
}

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export interface A2AServer {
  app: express.Express
  card: AgentCard
  handler: DefaultRequestHandler
  executor: TextExecutor
  dispose(): Promise<void>
}

export function createA2AServer(options: ServerOptions, runner: Runner): A2AServer {
  const publicUrl = httpUrl(options.publicUrl)
  if (publicUrl.pathname !== '/') throw new Error('publicUrl must be an origin without a path')
  const principals = (options.principals ?? []).map(p => ({ ...p, token: envSecret(p.tokenEnv)! }))
  if (!options.localDemo && !principals.length) throw new Error('A2A server requires at least one authenticated principal')
  if (new Set(principals.map(p => p.id)).size !== principals.length || new Set(principals.map(p => p.token)).size !== principals.length) {
    throw new Error('A2A principal ids and tokens must be unique')
  }
  const card = AgentCard.fromJSON({
    name: options.name, description: options.description, version: '0.1.0',
    supportedInterfaces: [
      { url: `${publicUrl.origin}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url: `${publicUrl.origin}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
    ],
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    skills: [{ id: 'assist', name: options.name, description: options.description, tags: ['assistant', options.role] }],
    ...(options.localDemo ? {} : {
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'bearer' } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    }),
  })
  const executor = new TextExecutor(runner, options.timeoutMs)
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor)
  const app = express()
  app.disable('x-powered-by')
  app.get('/health', (_req, res) => { res.json({ status: 'ok', agent: options.name }) })
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: handler, legacyCompat: { enabled: true } }))

  function principalFor(req: Request) {
    if (options.localDemo) return { id: 'local-demo', role: 'personal' as const }
    const token = req.headers.authorization?.replace(/^Bearer /i, '') ?? ''
    return principals.find(p => equal(token, p.token))
  }

  app.use('/a2a', (req, res, next) => {
    const principal = principalFor(req)
    if (!principal) { res.setHeader('WWW-Authenticate', 'Bearer'); res.status(401).json({ error: 'Authentication required' }); return }
    if (!canCall(principal.role, options.role)) { res.status(403).json({ error: 'Business agents cannot initiate calls to personal agents' }); return }
    next()
  }, express.json({ limit: '64kb' }), jsonRpcHandler({
    requestHandler: handler, legacyCompat: { enabled: true },
    userBuilder: async req => ({ isAuthenticated: !options.localDemo, userName: principalFor(req)!.id }),
  }))
  return { app, card, handler, executor, dispose: () => executor.dispose() }
}
