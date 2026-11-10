import { RegistryDraft, registryRemote } from './registry-contract.js'

const toDraft = nacos => ({ enabled: Boolean(nacos), serverUrl: nacos?.serverUrl ?? '', registry: nacos?.registry ?? 'agent',
  namespaceId: nacos?.namespaceId ?? 'public', groupName: nacos?.groupName ?? 'DSH_A2A',
  servicePrefix: nacos?.servicePrefix ?? 'a2a.', accessTokenEnv: nacos?.accessTokenEnv ?? '' })
const toInput = draft => RegistryDraft.parse({ nacos: draft.enabled ? {
  serverUrl: draft.serverUrl, registry: draft.registry, namespaceId: draft.namespaceId,
  groupName: draft.groupName, servicePrefix: draft.servicePrefix,
  ...(draft.accessTokenEnv.trim() ? { accessTokenEnv: draft.accessTokenEnv.trim() } : {}),
} : null })

export function registryClient(require) {
  const { createElement: h, useEffect, useRef, useState } = require('react')
  const { Button } = require('@deepseek-ai/dsh-client-ui-primitives')

  function RegistrySettings({ api }) {
    const [snapshot, setSnapshot] = useState(null)
    const [draft, setDraft] = useState(toDraft(null))
    const [listing, setListing] = useState(null)
    const [pending, setPending] = useState('load')
    const [error, setError] = useState('')
    const [notice, setNotice] = useState('')
    const [query, setQuery] = useState('')
    const [expanded, setExpanded] = useState(null)
    const lifetime = useRef(null)
    const operation = useRef(false)

    const inspect = async (input, signal) => {
      const result = await api('inspect', input, signal)
      if (!signal.aborted) { setListing(result); setExpanded(null) }
      return result
    }
    const load = async signal => {
      if (operation.current) return
      operation.current = true
      setPending('load'); setError(''); setNotice('')
      try {
        const value = await api('configuration', undefined, signal)
        if (signal.aborted) return
        setSnapshot(value); setDraft(toDraft(value.nacos)); setListing(null)
        await inspect({ nacos: value.nacos }, signal)
      } catch (e) { if (!signal.aborted) setError(e.message) }
      finally { operation.current = false; if (!signal.aborted) setPending('') }
    }
    useEffect(() => {
      const controller = new AbortController()
      lifetime.current = controller
      void load(controller.signal)
      return () => controller.abort()
    }, [])

    const run = async action => {
      if (operation.current) return
      const signal = lifetime.current.signal
      operation.current = true
      setPending(action); setError(''); setNotice('')
      try {
        const input = toInput(draft)
        if (action === 'save') {
          const saved = await api('save', { ...input, revision: snapshot.revision }, signal)
          if (signal.aborted) return
          setSnapshot(saved); setDraft(toDraft(saved.nacos))
          setNotice('配置已保存，已立即用于会话 Agent 发现。')
          setListing(null)
          await inspect({ nacos: saved.nacos }, signal)
        } else {
          const result = await inspect(input, signal)
          if (!signal.aborted && !result.error && result.enabled) setNotice('连接成功，已读取注册中心 Agent。测试不会保存配置。')
        }
      } catch (e) { if (!signal.aborted) setError(e.issues?.[0]?.message ?? e.message) }
      finally { operation.current = false; if (!signal.aborted) setPending('') }
    }
    const change = (field, value) => {
      setDraft(current => ({ ...current, [field]: value }))
      setListing(null); setExpanded(null); setNotice(''); setError('')
    }
    const busy = Boolean(pending)
    const dirty = snapshot && JSON.stringify(draft) !== JSON.stringify(toDraft(snapshot.nacos))
    const field = (key, label, placeholder, hint) => h('label', { className: 'a2ar-field', key },
      h('span', null, label),
      h('input', { className: 'a2am-search', name: key, value: draft[key], placeholder, disabled: busy,
        autoComplete: 'off', spellCheck: false, onChange: e => change(key, e.target.value) }),
      hint ? h('span', { className: 'a2am-muted' }, hint) : null)
    const agents = listing?.agents.filter(agent => `${agent.name} ${agent.description}`.toLowerCase().includes(query.trim().toLowerCase())) ?? []

    return h('section', { className: 'a2ar-settings', 'data-a2a-registry-settings': true, 'aria-busy': busy },
      h('header', { className: 'a2ar-heading' }, h('h2', null, 'A2A 配置'),
        h('p', { className: 'a2am-muted' }, '管理远端 Agent 注册中心。所有会话共用此配置，成员仍需在会话设置中添加。')),
      error ? h('div', { className: 'a2am-error a2ar-feedback', role: 'alert' }, error,
        h(Button, { size: 'sm', disabled: busy, onClick: () => void load(lifetime.current.signal) }, '重新加载')) : null,
      notice ? h('p', { className: 'a2ar-feedback a2am-muted', role: 'status' }, notice) : null,
      !snapshot ? h('p', { className: 'a2am-muted', role: 'status' }, busy ? '正在加载配置…' : '配置加载失败，请重新加载。') : h('form', {
        onSubmit: e => { e.preventDefault(); void run('save') },
      },
        h('div', { className: 'a2ar-card' },
          h('div', { className: 'a2ar-card-heading' }, h('div', null, h('h3', null, 'Nacos 注册中心'),
            h('p', { className: 'a2am-muted' }, '通过注册中心发现可加入会话的远端 Agent。')),
            h('label', { className: 'a2ar-toggle' }, h('input', { type: 'checkbox', checked: draft.enabled, disabled: busy, onChange: e => change('enabled', e.target.checked) }), '启用')),
          draft.enabled ? h('div', { className: 'a2ar-fields' },
            field('serverUrl', '服务地址', 'http://127.0.0.1:18848/nacos', '填写 Nacos 服务地址，包含部署的上下文路径，如 /nacos。'),
            h('div', { className: 'a2ar-columns' }, field('namespaceId', '命名空间 ID', 'public'),
              h('label', { className: 'a2ar-field' }, h('span', null, '注册模式'), h('select', { className: 'a2am-search', name: 'registry', value: draft.registry, disabled: busy, onChange: e => change('registry', e.target.value) },
                h('option', { value: 'agent' }, 'Agent Registry（推荐）'), h('option', { value: 'naming' }, 'Naming（兼容模式）')))),
            draft.registry === 'naming' ? h('div', { className: 'a2ar-columns' }, field('groupName', '服务分组', 'DSH_A2A'), field('servicePrefix', '服务名前缀', 'a2a.')) : null,
            field('accessTokenEnv', '访问令牌环境变量（选填）', 'NACOS_ACCESS_TOKEN', '填写保存 Token 的环境变量名称，Token 由宿主进程读取。')) : h('p', { className: 'a2am-muted' }, '启用后可配置和浏览注册中心。关闭后仍可使用配置文件中直接添加的远端 Agent。'),
          h('div', { className: 'a2ar-actions' },
            h('span', { className: 'a2am-muted', role: 'status' }, dirty ? '有未保存的更改' : '配置已同步'),
            h(Button, { size: 'sm', type: 'button', disabled: busy || !draft.enabled, onClick: () => void run('inspect') }, pending === 'inspect' ? '正在连接…' : '测试连接'),
            h(Button, { size: 'sm', type: 'submit', variant: 'primary', disabled: busy || !dirty }, pending === 'save' ? '正在保存…' : '保存配置')))),
      snapshot ? h('section', { className: 'a2ar-directory', 'aria-label': '注册中心 Agent' },
        h('div', { className: 'a2am-section-heading' }, h('h3', null, `注册中心 Agent${listing && !listing.error ? ` · ${listing.agents.length}` : ''}`),
          h(Button, { size: 'sm', disabled: busy || !draft.enabled, onClick: () => void run('inspect') }, '刷新')),
        h('p', { className: 'a2am-muted' }, dirty ? '测试连接可预览当前配置下的 Agent；保存后才用于会话发现。' : '展示当前注册中心下可发现的 A2A Agent，展开可查看注册信息。'),
        listing?.error ? h('p', { className: 'a2am-error', role: 'alert' }, listing.error) : null,
        busy ? h('p', { className: 'a2am-muted', role: 'status' }, pending === 'save' ? '正在保存配置并刷新 Agent…' : '正在读取注册中心…') : null,
        listing && !listing.error && listing.enabled ? h('div', null,
          listing.agents.length ? h('input', { type: 'search', className: 'a2am-search', value: query, placeholder: '搜索名称或描述', 'aria-label': '搜索注册中心 Agent', onChange: e => setQuery(e.target.value) }) : null,
          agents.map(agent => h('article', { key: agent.name, className: 'a2ar-agent', 'data-registry-agent': agent.name },
            h('div', { className: 'a2am-member' },
              h('div', { className: 'a2am-member-info' }, h('strong', null, agent.name),
                h('span', { className: 'a2am-muted' }, agent.role === 'business' ? '业务 Agent' : '个人 Agent', agent.version ? ` · v${agent.version}` : ''),
                agent.description ? h('p', { className: 'a2am-muted' }, agent.description) : null,
                !agent.callable ? h('p', { className: 'a2am-muted' }, '当前调用角色无权添加此 Agent。') : null),
              h(Button, { size: 'sm', 'aria-expanded': expanded === agent.name, 'aria-label': `查看 ${agent.name} 注册信息`, onClick: () => setExpanded(current => current === agent.name ? null : agent.name) }, expanded === agent.name ? '收起' : '查看信息')),
            expanded === agent.name ? h('div', { className: 'a2ar-agent-detail' },
              h('dl', null, h('dt', null, 'Card / 来源地址'), h('dd', null, agent.cardUrl),
                agent.streaming !== undefined ? [h('dt', { key: 'stream-label' }, '流式响应'), h('dd', { key: 'stream-value' }, agent.streaming ? '支持' : '未声明')] : null,
                agent.interfaces?.length ? [h('dt', { key: 'interface-label' }, '接口'), h('dd', { key: 'interfaces' }, agent.interfaces.map((item, index) => h('div', { key: index }, `${item.protocolBinding} · ${item.protocolVersion}`, h('div', { className: 'a2am-muted' }, item.url))))] : null),
              agent.skills?.length ? h('div', null, h('div', { className: 'a2am-section-title' }, '技能'), agent.skills.map(skill => h('div', { key: skill.id, className: 'a2ar-skill' }, h('strong', null, skill.name), h('p', { className: 'a2am-muted' }, skill.description)))) : null) : null)),
          !agents.length ? h('p', { className: 'a2am-muted a2am-empty' }, query && listing.agents.length ? '没有匹配的 Agent。' : '连接成功，此命名空间下暂无可发现的 A2A Agent。') : null) : null,
        !busy && !listing ? h('p', { className: 'a2am-muted a2am-empty' }, draft.enabled ? '点击“测试连接”读取 Agent 列表。' : '注册中心已停用。') : null) : null,
      snapshot ? h('p', { className: 'a2am-muted a2ar-config-path' }, '配置文件：', snapshot.configFile) : null)
  }

  return { async apply(ctx) {
    await ctx.remote.$mount(registryRemote)
    await ctx.inject(['remote.a2aRegistry'], ctx => {
      const api = async (method, input, signal) => {
        const descriptor = registryRemote.methods[`a2aRegistry/${method}`]
        const result = await descriptor.invoke(ctx.remote, input === undefined ? {} : { input }, signal)
        if (result.error) throw new Error(result.error.message || '操作未完成，请重试。')
        return result.value
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'dsh-a2a', order: 30, label: () => 'A2A 配置', inject: () => ({ api }),
      }, RegistrySettings))
    })
  } }
}
