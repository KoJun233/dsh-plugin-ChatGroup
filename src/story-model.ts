import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { Runner } from './executor.js'
import { httpUrl } from './config.js'
import { sseData } from './sse.js'

const ModelConfig = z.object({
  baseUrl: z.string(), apiKey: z.string().min(1),
  model: z.string().default('qwen/qwen-plus'), maxTokens: z.number().int().min(32).max(8192).default(2000),
})
export async function storyRunner(configFile: string): Promise<{ run: Runner; model: string }> {
  const config = ModelConfig.parse(JSON.parse(await readFile(configFile, 'utf8')))
  const base = httpUrl(config.baseUrl)
  if (base.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
    throw new Error('Model credentials require HTTPS outside loopback')
  }
  const prefix = base.href.replace(/\/$/, '')
  const endpoint = `${prefix}${base.pathname.replace(/\/$/, '').endsWith('/v1') ? '' : '/v1'}/chat/completions`
  return { model: config.model, run: async (text, signal, emitText) => {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model, stream: true, max_tokens: config.maxTokens,
        messages: [
          { role: 'system', content: '你是故事生成助手。按照用户要求创作故事，默认使用中文。直接输出标题与故事正文，不添加开场解释。用户未指定长度时写约600字，明确要求短故事时遵循要求。' },
          { role: 'user', content: text },
        ],
      }),
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Story model HTTP ${response.status}`) }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel()
      throw new Error('Story model did not return SSE')
    }
    let answer = ''
    let finished = false
    for await (const data of sseData(response.body)) {
      if (data.trim() === '[DONE]') { finished = true; break }
      const event = JSON.parse(data) as { error?: unknown; choices?: { delta?: { content?: string }; finish_reason?: string | null }[] }
      if (event.error) throw new Error('Story model returned a stream error')
      const choice = event.choices?.[0]
      if (choice?.finish_reason === 'length') throw new Error('Story exceeded model output limit; request a shorter story')
      const delta = choice?.delta?.content
      if (typeof delta === 'string' && delta) { answer += delta; emitText(delta) }
    }
    signal.throwIfAborted()
    if (!finished) throw new Error('Story model stream ended before [DONE]')
    if (!answer.trim()) throw new Error('Story model returned no story text')
    return answer
  } }
}
