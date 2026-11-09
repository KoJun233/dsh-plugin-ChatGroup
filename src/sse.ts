/** Parse UTF-8 SSE events independently of network chunk and CRLF boundaries. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  let size = 0
  const lines = function* (flush = false) {
    while (true) {
      const match = /\r\n|\r|\n/.exec(buffer)
      if (!match || (!flush && match[0] === '\r' && match.index === buffer.length - 1)) break
      const line = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      yield line
    }
    if (flush && buffer) { const line = buffer; buffer = ''; yield line }
  }
  try {
    while (true) {
      const chunk = await reader.read()
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
      if (buffer.length > 1024 * 1024) throw new Error('SSE frame exceeds limit')
      for (const line of lines(chunk.done)) {
        if (line === '') {
          if (data.length) yield data.join('\n')
          data = []; size = 0
        } else if (line.startsWith('data:')) {
          const value = line.slice(5).replace(/^ /, '')
          size += value.length
          if (size > 1024 * 1024) throw new Error('SSE event exceeds limit')
          data.push(value)
        }
      }
      if (chunk.done) break
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
