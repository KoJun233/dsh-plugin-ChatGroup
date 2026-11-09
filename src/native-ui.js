// Use the same public renderer as DSH's AssistantMarkdown, including its CSS,
// incremental parser, code highlighting, tables, math, and code-copy controls.
export const markdownLabels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }

export function nativeUi(require) {
  const { createElement: h } = require('react')
  const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives')
  return { Markdown: ({ text, streaming = false }) => h(MarkdownText, { text, streaming, labels: markdownLabels }) }
}
