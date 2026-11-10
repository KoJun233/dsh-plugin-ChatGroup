import { groupClient } from './group-ui.js'
import { registryClient } from './registry-ui.js'
import css from './group-ui.css'

window.__ModuleLoader__.load({
  id: 'dsh-a2a',
  factory: require => {
    const group = groupClient(require)
    const registry = registryClient(require)
    const { createElement: h } = require('react')
    function ToolStatus({ block, phase }) {
      let result
      try { result = JSON.parse(block.content?.filter(p => p.type === 'text').map(p => p.text).join('\n') ?? '') } catch {}
      if (phase !== 'result' || result?.memberReply) return null
      return h('span', { className: 'a2am-muted' }, block.isError ? '调用未完成' : result?.text || result?.state || '已完成')
    }
    return {
      inject: ['slots', 'uiConversation', ...group.inject],
      async apply(ctx) {
        const style = document.createElement('style')
        style.textContent = css
        ctx.effect(() => { document.head.append(style); return () => style.remove() })
        for (const name of ['session_call_agent', 'a2a_send_message']) ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: name }, ToolStatus))
        await registry.apply(ctx)
        await group.apply(ctx)
      },
    }
  },
})
