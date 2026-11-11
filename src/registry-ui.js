import { CardProbe, NacosSettings, RegistryDraft, registryRemote } from './registry-contract.js'

const toDraft = value => ({
  nacosRegistries: (value?.nacosRegistries ?? []).map(source => ({ id: source.id, name: source.name, enabled: source.enabled !== false,
    serverUrl: source.serverUrl, namespaceId: source.namespaceId ?? 'public', accessTokenEnv: source.accessTokenEnv ?? '' })),
  agents: (value?.agents ?? []).map((agent, index) => ({ _key: `saved-${index}`, name: agent.name, enabled: agent.enabled !== false,
    role: agent.role, cardUrl: agent.cardUrl, description: agent.description ?? '', tokenEnv: agent.tokenEnv ?? '' })),
})
const comparable = draft => JSON.stringify({ ...draft, agents: draft.agents.map(({ _key, ...agent }) => agent) })
const probeInput = agent => CardProbe.parse({ cardUrl: agent.cardUrl,
  ...(agent.tokenEnv.trim() ? { tokenEnv: agent.tokenEnv.trim() } : {}) })
const nacosInput = source => NacosSettings.parse({ serverUrl: source.serverUrl, namespaceId: source.namespaceId,
  ...(source.accessTokenEnv.trim() ? { accessTokenEnv: source.accessTokenEnv.trim() } : {}) })
const toInput = draft => RegistryDraft.parse({
  nacosRegistries: draft.nacosRegistries.map(source => ({ ...nacosInput(source), id: source.id, name: source.name, enabled: source.enabled })),
  agents: draft.agents.map(agent => ({ ...probeInput(agent), name: agent.name, enabled: agent.enabled, role: agent.role,
    ...(agent.description.trim() ? { description: agent.description.trim() } : {}) })),
})

export function registryClient(require) {
  const { createElement: h, useEffect, useRef, useState } = require('react')
  const { Button } = require('@deepseek-ai/dsh-client-ui-primitives')

  function AgentDetails({ agent }) {
    return h('div', { className: 'a2ar-agent-detail' },
      h('dl', null, h('dt', null, 'Card / 来源地址'), h('dd', null, agent.cardUrl),
        agent.version ? [h('dt', { key: 'version-label' }, '版本'), h('dd', { key: 'version' }, agent.version)] : null,
        agent.streaming !== undefined ? [h('dt', { key: 'stream-label' }, '流式响应'), h('dd', { key: 'stream-value' }, agent.streaming ? '支持' : '未声明')] : null,
        agent.interfaces?.length ? [h('dt', { key: 'interface-label' }, '接口'), h('dd', { key: 'interfaces' }, agent.interfaces.map((item, index) => h('div', { key: index }, `${item.protocolBinding} · ${item.protocolVersion}`, h('div', { className: 'a2am-muted' }, item.url))))] : null),
      agent.skills?.length ? h('div', null, h('div', { className: 'a2am-section-title' }, '技能'), agent.skills.map(skill => h('div', { key: skill.id, className: 'a2ar-skill' }, h('strong', null, skill.name), h('p', { className: 'a2am-muted' }, skill.description)))) : null)
  }

  function RegistrySettings({ api }) {
    const [snapshot, setSnapshot] = useState(null)
    const [draft, setDraft] = useState(() => toDraft(null))
    const [registryResults, setRegistryResults] = useState({})
    const [cardResults, setCardResults] = useState({})
    const [pending, setPending] = useState('load')
    const [error, setError] = useState('')
    const [notice, setNotice] = useState('')
    const [queries, setQueries] = useState({})
    const [expanded, setExpanded] = useState(null)
    const [editing, setEditing] = useState(null)
    const [editingRegistry, setEditingRegistry] = useState(null)
    const [openedRegistry, setOpenedRegistry] = useState(null)
    const lifetime = useRef(null)
    const operation = useRef(false)
    const sequence = useRef(0)
    const errorRef = useRef(null)
    useEffect(() => { if (error) errorRef.current?.focus() }, [error])

    const load = async signal => {
      if (operation.current) return
      operation.current = true
      setPending('load'); setError(''); setNotice('')
      try {
        const value = await api('configuration', undefined, signal)
        if (signal.aborted) return
        setSnapshot(value); setDraft(toDraft(value)); setRegistryResults({}); setCardResults({}); setEditing(null); setEditingRegistry(null)
        const results = await Promise.all(value.nacosRegistries.filter(source => source.enabled !== false).map(async source =>
          [source.id, await api('inspectRegistry', nacosInput(toDraft(value).nacosRegistries.find(item => item.id === source.id)), signal)]))
        if (!signal.aborted) setRegistryResults(Object.fromEntries(results))
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
          setSnapshot(saved); setDraft(toDraft(saved)); setCardResults({}); setEditing(null); setEditingRegistry(null)
          setNotice('配置已保存，已立即用于会话 Agent 发现。')
        } else {
          const result = await api('inspect', input, signal)
          if (signal.aborted) return
          setRegistryResults(Object.fromEntries((result.sources ?? []).map(source => [source.id, source])))
          setCardResults(Object.fromEntries(draft.agents.filter(agent => agent.enabled).map(agent => {
            const value = result.agents.find(item => item.source?.kind === 'direct' && item.name === agent.name.trim())
            return [agent._key, { agent: value, error: value?.error ?? '' }]
          })))
          const failures = (result.sources ?? []).filter(source => source.error).length + result.agents.filter(agent => agent.error).length
          setNotice(failures ? `检查完成，${failures} 个来源或 Card 连接失败，请查看对应条目。其他来源可继续使用。` : '连接检查完成。测试不会发送对话或保存配置。')
        }
      } catch (e) { if (!signal.aborted) setError(e.issues?.[0]?.message ?? e.message) }
      finally { operation.current = false; if (!signal.aborted) setPending('') }
    }
    const readSource = async (kind, item) => {
      if (operation.current) return
      operation.current = true
      const signal = lifetime.current.signal
      const key = kind === 'registry' ? item.id : item._key
      setPending(`${kind}:${key}`); setError(''); setNotice('')
      try {
        const result = await api(kind === 'registry' ? 'inspectRegistry' : 'inspectCard', kind === 'registry' ? nacosInput(item) : probeInput(item), signal)
        if (signal.aborted) return
        if (kind === 'registry') { setRegistryResults(current => ({ ...current, [key]: result })); setOpenedRegistry(key) }
        else {
          setCardResults(current => ({ ...current, [key]: result }))
          if (result.agent) {
            setDraft(current => ({ ...current, agents: current.agents.map(agent => agent._key === key ? {
              ...agent, name: agent.name.trim() ? agent.name : result.agent.name,
              description: agent.description.trim() ? agent.description : result.agent.description ?? '',
            } : agent) }))
            setEditing(key)
          }
        }
      } catch (e) {
        if (!signal.aborted) (kind === 'registry' ? setRegistryResults : setCardResults)(current => ({ ...current, [key]: { error: e.issues?.[0]?.message ?? e.message } }))
      } finally { operation.current = false; if (!signal.aborted) setPending('') }
    }
    const replace = (collection, items) => {
      setDraft(current => ({ ...current, [collection]: items })); setNotice(''); setError('')
    }
    const changeItem = (collection, key, field, value) => {
      setDraft(current => ({ ...current, [collection]: current[collection].map(item => (item._key ?? item.id) === key ? { ...item, [field]: value } : item) }))
      if (collection === 'nacosRegistries' && ['serverUrl', 'namespaceId', 'accessTokenEnv'].includes(field)) setRegistryResults(current => ({ ...current, [key]: undefined }))
      if (collection === 'agents' && ['cardUrl', 'tokenEnv'].includes(field)) setCardResults(current => ({ ...current, [key]: undefined }))
      setNotice(''); setError('')
    }
    const busy = Boolean(pending)
    const dirty = snapshot && comparable(draft) !== comparable(toDraft(snapshot))
    const field = (collection, item, index, key, label, placeholder, hint) => h('label', { className: 'a2ar-field', key },
      h('span', null, label),
      h('input', { className: 'a2am-search', name: `${collection}-${index}-${key}`, value: item[key], placeholder, disabled: busy,
        autoFocus: (key === 'cardUrl' && item._key?.startsWith('new-')) || (key === 'serverUrl' && item._new),
        autoComplete: 'off', spellCheck: false, onChange: e => changeItem(collection, item._key ?? item.id, key, e.target.value) }),
      hint ? h('span', { className: 'a2am-muted' }, hint) : null)
    const toggle = (collection, item) => h('label', { className: 'a2ar-toggle' }, h('input', { type: 'checkbox', checked: item.enabled, disabled: busy,
      onChange: e => changeItem(collection, item._key ?? item.id, 'enabled', e.target.checked) }), item.enabled ? '已启用' : '已停用')

    const registryDirectory = source => {
      const result = registryResults[source.id]
      if (!result) return null
      if (result.error) return h('p', { className: 'a2am-error', role: 'alert' }, result.error)
      const query = queries[source.id] ?? ''
      const agents = (result.agents ?? []).filter(agent => `${agent.name} ${agent.description}`.toLowerCase().includes(query.trim().toLowerCase()))
      return h('div', { className: 'a2ar-directory', hidden: openedRegistry !== source.id },
        result.agents.length ? h('input', { type: 'search', className: 'a2am-search', value: query, placeholder: '搜索名称或描述', 'aria-label': `搜索 ${source.name} Agent`, onChange: e => setQueries(current => ({ ...current, [source.id]: e.target.value })) }) : null,
        agents.map(agent => {
          const key = `${source.id}:${agent.name}`
          return h('article', { key: agent.name, className: 'a2ar-agent', 'data-registry-agent': agent.name },
            h('div', { className: 'a2am-member' }, h('div', { className: 'a2am-member-info' }, h('strong', null, agent.name),
              h('span', { className: 'a2am-muted' }, agent.role === 'business' ? '业务 Agent' : '个人 Agent', agent.version ? ` · v${agent.version}` : ''),
              agent.description ? h('p', { className: 'a2am-muted' }, agent.description) : null,
              !agent.callable ? h('p', { className: 'a2am-muted' }, '当前调用角色无权添加此 Agent。') : null),
              h(Button, { size: 'sm', type: 'button', 'aria-expanded': expanded === key, 'aria-label': `查看 ${source.name} / ${agent.name} 注册信息`, onClick: () => setExpanded(expanded === key ? null : key) }, expanded === key ? '收起' : '查看信息')),
            expanded === key ? h(AgentDetails, { agent }) : null)
        }),
        !agents.length ? h('p', { className: 'a2am-muted' }, query && result.agents.length ? '没有匹配的 Agent。' : '连接成功，此命名空间下暂无可发现的 A2A Agent。') : null)
    }

    return h('section', { className: 'a2ar-settings', 'data-a2a-registry-settings': true, 'aria-busy': busy },
      h('header', { className: 'a2ar-heading' }, h('h2', null, 'A2A 配置'),
        h('p', { className: 'a2am-muted' }, 'Nacos 注册中心与直连 Card 可同时使用，所有已启用来源的 Agent 会汇总到会话成员列表。')),
      error ? h('div', { ref: errorRef, tabIndex: -1, className: 'a2am-error a2ar-feedback', role: 'alert' }, error,
        h(Button, { size: 'sm', disabled: busy, onClick: () => void load(lifetime.current.signal) }, '重新加载')) : null,
      notice ? h('p', { className: 'a2ar-feedback a2am-muted', role: 'status' }, notice) : null,
      snapshot?.legacyNaming ? h('p', { className: 'a2ar-feedback a2am-muted' }, 'Naming 已移除。请将旧服务发布到 Nacos Agent Registry。') : null,
      !snapshot ? h('p', { className: 'a2am-muted', role: 'status' }, busy ? '正在加载配置…' : '配置加载失败，请重新加载。') : h('form', {
        onSubmit: e => { e.preventDefault(); void run('save') },
      },
        h('div', { className: 'a2ar-savebar' }, h('span', { className: 'a2am-muted', role: 'status' }, dirty ? '有未保存的更改' : '配置已同步'),
          h(Button, { size: 'sm', type: 'button', disabled: busy || ![...draft.nacosRegistries, ...draft.agents].some(item => item.enabled), onClick: () => void run('inspect') }, pending === 'inspect' ? '正在检查…' : '测试所有连接'),
          h(Button, { size: 'sm', type: 'submit', variant: 'primary', disabled: busy || !dirty }, pending === 'save' ? '正在保存…' : '保存配置')),
        h('section', { className: 'a2ar-card', 'aria-label': 'Nacos 注册发现' },
          h('div', { className: 'a2ar-card-heading' }, h('div', null, h('h3', null, `Nacos 注册发现 · ${draft.nacosRegistries.length}`),
            h('p', { className: 'a2am-muted' }, '可添加多个注册中心，统一使用 Agent Registry。')),
            h(Button, { size: 'sm', type: 'button', disabled: busy || draft.nacosRegistries.length >= 20, onClick: () => {
              let number = draft.nacosRegistries.length + 1
              while (draft.nacosRegistries.some(source => source.name === `Nacos ${number}`)) number++
              const source = { id: crypto.randomUUID(), _new: true, name: `Nacos ${number}`, enabled: true, serverUrl: '', namespaceId: 'public', accessTokenEnv: '' }
              replace('nacosRegistries', [...draft.nacosRegistries, source]); setEditingRegistry(source.id)
            } }, '添加注册中心')),
          !draft.nacosRegistries.length ? h('p', { className: 'a2am-muted a2am-empty' }, '还没有注册中心。也可以在下方直接添加 Agent Card。') : null,
          draft.nacosRegistries.map((source, index) => h('article', { key: source.id, className: 'a2ar-source', 'data-nacos-source': source.id },
            h('div', { className: 'a2ar-direct-heading' }, h('div', { className: 'a2am-member-info' }, h('strong', null, source.name || '新注册中心'),
              h('span', { className: 'a2am-muted' }, source.serverUrl || '待填写服务地址', ` · ${source.namespaceId || 'public'}`)),
              h('div', { className: 'a2ar-row-actions' }, toggle('nacosRegistries', source),
                h(Button, { size: 'sm', type: 'button', disabled: busy, 'aria-expanded': editingRegistry === source.id, onClick: () => setEditingRegistry(editingRegistry === source.id ? null : source.id) }, editingRegistry === source.id ? '收起' : '编辑'),
                h(Button, { size: 'sm', type: 'button', disabled: busy, onClick: () => replace('nacosRegistries', draft.nacosRegistries.filter(item => item.id !== source.id)) }, '删除'))),
            editingRegistry === source.id ? h('div', { className: 'a2ar-fields' },
              field('nacosRegistries', source, index, 'name', '注册中心名称', '用于区分 Agent 的来源'),
              field('nacosRegistries', source, index, 'serverUrl', '服务地址', 'http://127.0.0.1:18848/nacos', '包含部署的上下文路径，如 /nacos。'),
              field('nacosRegistries', source, index, 'namespaceId', '命名空间 ID', 'public'),
              field('nacosRegistries', source, index, 'accessTokenEnv', '访问令牌环境变量（选填）', 'NACOS_ACCESS_TOKEN', '填写环境变量名称，Token 由宿主进程读取。')) : null,
            h('div', { className: 'a2ar-card-check' }, h(Button, { size: 'sm', type: 'button', disabled: busy || !source.serverUrl.trim(), onClick: () => void readSource('registry', source) }, pending === `registry:${source.id}` ? '正在连接…' : '测试连接'),
              registryResults[source.id]?.agents && !registryResults[source.id].error ? h(Button, { size: 'sm', type: 'button', disabled: busy, 'aria-expanded': openedRegistry === source.id,
                onClick: () => setOpenedRegistry(openedRegistry === source.id ? null : source.id) }, `${openedRegistry === source.id ? '收起' : '查看'} Agent · ${registryResults[source.id].agents.length}`) : null),
            registryDirectory(source)))),
        h('section', { className: 'a2ar-card', 'aria-label': '直连 Card' },
          h('div', { className: 'a2ar-card-heading' }, h('div', null, h('h3', null, `直连 Card · ${draft.agents.length}`),
            h('p', { className: 'a2am-muted' }, '可添加多个 Agent Card，与注册中心发现的 Agent 一起使用。')),
            h(Button, { size: 'sm', type: 'button', disabled: busy || draft.agents.length >= 100, onClick: () => {
              const agent = { _key: `new-${sequence.current++}`, enabled: true, name: '', cardUrl: '', description: '', role: 'personal', tokenEnv: '' }
              replace('agents', [...draft.agents, agent]); setEditing(agent._key)
            } }, '添加 Agent')),
          !draft.agents.length ? h('p', { className: 'a2am-muted a2am-empty' }, '还没有直连 Agent。点击“添加 Agent”填写 Card 地址。') : null,
          draft.agents.map((agent, index) => h('article', { key: agent._key, className: 'a2ar-direct-agent', 'data-direct-agent': true },
            h('div', { className: 'a2ar-direct-heading' }, h('div', { className: 'a2am-member-info' }, h('strong', null, agent.name || '新 Agent'),
              h('span', { className: 'a2am-muted' }, agent.cardUrl || '待填写 Agent Card 地址')),
              h('div', { className: 'a2ar-row-actions' }, toggle('agents', agent),
                h(Button, { size: 'sm', type: 'button', disabled: busy, 'aria-expanded': editing === agent._key, onClick: () => setEditing(editing === agent._key ? null : agent._key) }, editing === agent._key ? '收起' : '编辑'),
                h(Button, { size: 'sm', type: 'button', disabled: busy, onClick: () => replace('agents', draft.agents.filter(item => item._key !== agent._key)) }, '删除'))),
            editing === agent._key ? h('div', { className: 'a2ar-fields' },
              field('agents', agent, index, 'cardUrl', 'Agent Card 地址', 'https://agent.example/.well-known/agent-card.json', '读取 Card 可自动填入名称和描述。'),
              h('div', { className: 'a2ar-columns' }, field('agents', agent, index, 'name', 'Agent 名称', '用于会话中的 @名称'),
                h('label', { className: 'a2ar-field' }, h('span', null, 'Agent 类型'), h('select', { className: 'a2am-search', name: `agents-${index}-role`, value: agent.role, disabled: busy, onChange: e => changeItem('agents', agent._key, 'role', e.target.value) },
                  h('option', { value: 'personal' }, '个人 Agent'), h('option', { value: 'business' }, '业务 Agent')))),
              field('agents', agent, index, 'description', '描述（选填）', '说明这个 Agent 的专长'),
              field('agents', agent, index, 'tokenEnv', '访问令牌环境变量（选填）', 'A2A_AGENT_TOKEN', '需要 Bearer 鉴权时填写环境变量名，Token 由宿主进程读取。')) : null,
            h('div', { className: 'a2ar-card-check' }, h(Button, { size: 'sm', type: 'button', disabled: busy || !agent.cardUrl.trim(), onClick: () => void readSource('card', agent) }, pending === `card:${agent._key}` ? '正在读取…' : '读取 Card'),
              h('span', { className: 'a2am-muted' }, cardResults[agent._key]?.agent && !cardResults[agent._key].error ? 'Card 已读取' : '仅验证 Card，不发送对话')),
            cardResults[agent._key]?.error ? h('p', { className: 'a2am-error', role: 'alert' }, cardResults[agent._key].error) : null,
            cardResults[agent._key]?.agent && !cardResults[agent._key].error ? h(AgentDetails, { agent: cardResults[agent._key].agent }) : null)))),
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
