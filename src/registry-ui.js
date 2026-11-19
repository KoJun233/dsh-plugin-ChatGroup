import { CardProbe, NacosSettings, RegistryDraft, registryRemote } from './registry-contract.js'
import { settingAction, settingIcon } from './settings-ui.js'

const toDraft = value => ({
  nacosRegistries: (value?.nacosRegistries ?? []).map(source => ({ id: source.id, name: source.name, enabled: source.enabled !== false,
    serverUrl: source.serverUrl, namespaceId: source.namespaceId ?? 'public', accessTokenEnv: source.accessTokenEnv ?? '' })),
  agents: (value?.agents ?? []).map((agent, index) => ({ _key: `saved-${index}`, previousName: agent.name, legacyNames: (agent.legacyNames ?? []).join(', '), name: agent.name, enabled: agent.enabled !== false,
    role: agent.role, cardUrl: agent.cardUrl, description: agent.description ?? '', tokenEnv: agent.tokenEnv ?? '' })),
})
const comparable = draft => JSON.stringify({ ...draft, agents: draft.agents.map(({ _key, ...agent }) => agent) })
const probeInput = agent => CardProbe.parse({ cardUrl: agent.cardUrl,
  ...(agent.tokenEnv.trim() ? { tokenEnv: agent.tokenEnv.trim() } : {}) })
const nacosInput = source => NacosSettings.parse({ serverUrl: source.serverUrl, namespaceId: source.namespaceId,
  ...(source.accessTokenEnv.trim() ? { accessTokenEnv: source.accessTokenEnv.trim() } : {}) })
const toInput = draft => RegistryDraft.parse({
  nacosRegistries: draft.nacosRegistries.map(({ accessTokenEnv, ...source }) => ({ ...source,
    ...(accessTokenEnv.trim() ? { accessTokenEnv: accessTokenEnv.trim() } : {}) })),
  agents: draft.agents.map(({ _key, tokenEnv, description, legacyNames, ...agent }) => ({ ...agent,
    legacyNames: legacyNames.split(/[,，]/u).map(name => name.trim()).filter(Boolean),
    ...(tokenEnv.trim() ? { tokenEnv: tokenEnv.trim() } : {}),
    ...(description.trim() ? { description: description.trim() } : {}) })),
})

export function registryClient(require) {
  const { createElement: h, useEffect, useId, useRef, useState } = require('react')
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
    const [openedCard, setOpenedCard] = useState(null)
    const [section, setSection] = useState('nacosRegistries')
    const [sourceSearch, setSourceSearch] = useState({})
    const [removed, setRemoved] = useState(null)
    const id = useId()
    const root = useRef(null)
    const newField = useRef(null)
    const lifetime = useRef(null)
    const operation = useRef(false)
    const sequence = useRef(0)
    const errorRef = useRef(null)
    useEffect(() => { if (error) errorRef.current?.focus() }, [error])

    useEffect(() => {
      if (!newField.current) return
      const field = root.current?.querySelector(`[name="${newField.current}"]`)
      if (field) { field.focus({ preventScroll: true }); field.scrollIntoView({ block: 'nearest' }); newField.current = null }
    }, [editing, editingRegistry])

    const load = async (signal, initial = false) => {
      if (operation.current) return
      operation.current = true
      setPending('load'); setError(''); setNotice('')
      try {
        const value = await api('configuration', undefined, signal)
        if (signal.aborted) return
        const next = toDraft(value)
        setSnapshot(value); setDraft(next); setRegistryResults({}); setCardResults({}); setEditing(null); setEditingRegistry(null)
        setOpenedRegistry(null); setOpenedCard(null); setRemoved(null); setSourceSearch({})
        if (initial && !next.nacosRegistries.length && next.agents.length) setSection('agents')
        const results = await Promise.all(next.nacosRegistries.filter(source => source.enabled).map(async source => {
          try { return [source.id, await api('inspectRegistry', nacosInput(source), signal)] }
          catch (e) { return [source.id, { error: e.issues?.[0]?.message ?? e.message }] }
        }))
        if (!signal.aborted) setRegistryResults(Object.fromEntries(results))
      } catch (e) { if (!signal.aborted) setError(e.message) }
      finally { operation.current = false; if (!signal.aborted) setPending('') }
    }
    useEffect(() => {
      const controller = new AbortController()
      lifetime.current = controller
      void load(controller.signal, true)
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
          setSnapshot(saved); setDraft(toDraft(saved)); setCardResults({}); setOpenedCard(null); setEditing(null); setEditingRegistry(null); setRemoved(null)
          setNotice('配置已保存')
        } else {
          const result = await api('inspect', input, signal)
          if (signal.aborted) return
          setRegistryResults(Object.fromEntries((result.sources ?? []).map(source => [source.id, source])))
          setCardResults(Object.fromEntries(draft.agents.filter(agent => agent.enabled).map(agent => {
            const value = result.agents.find(item => item.source?.kind === 'direct' && item.name === agent.name.trim())
            return [agent._key, { agent: value, error: value?.error ?? '' }]
          })))
          const failures = (result.sources ?? []).filter(source => source.error).length + result.agents.filter(agent => agent.error).length
          setNotice(failures ? `${failures} 项连接失败，查看对应条目。` : '连接测试通过')
        }
      } catch (e) {
        if (!signal.aborted) {
          const issue = e.issues?.[0]
          // Parse the full draft so invalid fields can be revealed in the right section.
          const [collection, index] = issue?.path ?? []
          if (collection === 'nacosRegistries' || collection === 'agents') {
            setSection(collection); setSourceSearch(current => ({ ...current, [collection]: '' }))
            if (collection === 'nacosRegistries') setEditingRegistry(draft.nacosRegistries[index]?.id ?? null)
            else setEditing(draft.agents[index]?._key ?? null)
          }
          setError(issue?.message ?? e.message)
        }
      }
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
            setOpenedCard(key)
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
    const field = (collection, item, index, key, label, placeholder, title) => h('label', { className: 'a2ar-field', key, title },
      h('span', null, label),
      h('input', { className: 'a2am-search', name: `${collection}-${index}-${key}`, value: item[key], placeholder, disabled: busy,
        autoComplete: 'off', spellCheck: false, onChange: e => changeItem(collection, item._key ?? item.id, key, e.target.value) }))
    const icon = (name, size) => settingIcon(h, name, size)
    const action = (label, name, props, suffix) => settingAction(h, label, name, props, suffix)
    const toggle = (collection, item) => h('label', { key: 'toggle', className: 'a2ar-switch', title: item.enabled ? '停用此来源' : '启用此来源' },
      h('input', { className: 'a2ar-toggle', type: 'checkbox', role: 'switch', checked: item.enabled, disabled: busy,
        'aria-label': `启用 ${item.name || '此来源'}`, onChange: e => changeItem(collection, item._key ?? item.id, 'enabled', e.target.checked) }))
    const status = (result, loading) => {
      const badge = loading ? ['pending', 'wait', '检查中'] : result?.error ? ['error', 'warn', '连接失败'] :
        (result?.agents || result?.agent) ? ['ok', 'check', '测试通过'] : null
      return badge ? h('span', { className: 'a2a-status', 'data-tone': badge[0], title: badge[2], role: 'img', 'aria-label': badge[2] }, icon(badge[1], 14)) : null
    }
    const remove = (collection, item, index) => {
      replace(collection, draft[collection].filter(entry => entry !== item))
      setRemoved({ collection, item, index })
    }
    const undo = () => {
      const items = [...draft[removed.collection]]
      items.splice(removed.index, 0, removed.item)
      replace(removed.collection, items)
      setSourceSearch(current => ({ ...current, [removed.collection]: '' }))
      setSection(removed.collection); setRemoved(null)
    }
    const matchSource = (collection, item) => (collection === 'agents' ? item._key === editing : item.id === editingRegistry) ||
      [item.name, item.serverUrl, item.cardUrl, item.namespaceId, item.description].some(value => value?.toLowerCase().includes((sourceSearch[collection] ?? '').trim().toLowerCase()))
    const sourceFilter = (collection, label) => draft[collection].length > 5 || sourceSearch[collection] ? h('label', { className: 'a2a-search-wrap' },
      icon('search'), h('input', { type: 'search', className: 'a2am-search', value: sourceSearch[collection] ?? '',
        placeholder: `搜索${label}`, 'aria-label': `搜索${label}`, onChange: e => setSourceSearch(current => ({ ...current, [collection]: e.target.value })) })) : null
    const sourceHeading = (name, address, badge, kind, actions) => h('div', { className: 'a2ar-source-heading' },
      h('span', { className: 'a2a-tile', 'data-kind': kind }, icon(kind, 16)),
      h('div', { className: 'a2am-member-info' }, h('div', { className: 'a2ar-source-title' }, h('strong', { title: name }, name), badge),
        address ? h('span', { className: 'a2ar-address', title: address }, address) : null),
      h('div', { className: 'a2ar-row-actions' }, actions))
    const empty = label => h('p', { className: 'a2am-muted a2a-empty', role: 'status' }, label)

    const registryDirectory = source => {
      const result = registryResults[source.id]
      if (!result) return null
      if (result.error) return h('p', { className: 'a2am-error a2ar-source-error', role: 'alert' }, result.error)
      const query = queries[source.id] ?? ''
      const agents = (result.agents ?? []).filter(agent => `${agent.name} ${agent.description}`.toLowerCase().includes(query.trim().toLowerCase()))
      return h('div', { className: 'a2ar-directory', hidden: openedRegistry !== source.id },
        result.agents.length ? h('label', { className: 'a2a-search-wrap' }, icon('search'), h('input', { type: 'search', className: 'a2am-search', value: query, placeholder: '搜索名称或描述', 'aria-label': `搜索 ${source.name} Agent`, onChange: e => setQueries(current => ({ ...current, [source.id]: e.target.value })) })) : null,
        agents.map(agent => {
          const key = `${source.id}:${agent.name}`
          return h('article', { key: agent.name, className: 'a2ar-agent', 'data-registry-agent': agent.name },
            h('div', { className: 'a2am-member' }, h('div', { className: 'a2am-member-info' }, h('strong', null, agent.name),
              h('p', { className: 'a2am-muted' }, [agent.role === 'business' ? '业务' : '个人', agent.version ? `v${agent.version}` : '', agent.description].filter(Boolean).join(' · ')),
              !agent.callable ? h('p', { className: 'a2am-muted' }, '当前调用角色无权添加此 Agent。') : null),
              action(`查看 ${source.name} / ${agent.name} 注册信息`, expanded === key ? 'collapse' : 'expand', { 'aria-expanded': expanded === key, onClick: () => setExpanded(expanded === key ? null : key) })),
            expanded === key ? h(AgentDetails, { agent }) : null)
        }),
        !agents.length ? h('p', { className: 'a2am-muted' }, query && result.agents.length ? '没有匹配的 Agent。' : '此命名空间暂无 Agent') : null)
    }

    const addSource = () => {
      if (section === 'nacosRegistries') {
        let number = draft.nacosRegistries.length + 1
        while (draft.nacosRegistries.some(source => source.name === `Nacos ${number}`)) number++
        const source = { id: crypto.randomUUID(), name: `Nacos ${number}`, enabled: true, serverUrl: '', namespaceId: 'public', accessTokenEnv: '' }
        newField.current = `nacosRegistries-${draft.nacosRegistries.length}-serverUrl`
        replace('nacosRegistries', [...draft.nacosRegistries, source]); setEditingRegistry(source.id)
      } else {
        const agent = { _key: `new-${sequence.current++}`, previousName: null, legacyNames: '', enabled: true, name: '', cardUrl: '', description: '', role: 'personal', tokenEnv: '' }
        newField.current = `agents-${draft.agents.length}-cardUrl`
        replace('agents', [...draft.agents, agent]); setEditing(agent._key)
      }
      setSourceSearch(current => ({ ...current, [section]: '' }))
    }
    const totals = [...draft.nacosRegistries, ...draft.agents]
    const visibleCount = draft[section].filter(item => matchSource(section, item)).length
    const selectSection = collection => h('button', { type: 'button', 'aria-pressed': section === collection,
      'aria-controls': `${id}-${collection}`, onClick: () => {
        if (section !== collection) { setSection(collection); root.current?.scrollIntoView({ block: 'start' }) }
      } },
      collection === 'nacosRegistries' ? 'Nacos' : '直连 Card',
      h('span', { className: 'a2a-count' }, draft[collection].length))

    return h('section', { ref: root, className: 'a2ar-settings a2a-surface', 'data-a2a-registry-settings': true, 'aria-label': 'A2A 配置', 'aria-busy': busy },
      !snapshot ? h('h2', null, 'A2A 配置') : null,
      !snapshot && !error ? empty('正在加载…') : null,
      h('form', { onSubmit: e => { e.preventDefault(); if (dirty && !busy) void run('save') } },
        h('div', { className: 'a2ar-savebar' },
          snapshot ? h('div', { className: 'a2ar-toolbar' },
            h('div', { className: 'a2a-segment', role: 'group', 'aria-label': 'Agent 来源类型' }, selectSection('nacosRegistries'), selectSection('agents')),
            h('div', { className: 'a2ar-toolbar-actions' },
              h(Button, { size: 'sm', className: 'a2a-outline', type: 'button', disabled: busy || draft[section].length >= (section === 'agents' ? 100 : 20),
                onClick: addSource }, icon('plus', 14), section === 'agents' ? '添加 Agent' : '添加注册中心'),
              action(pending === 'inspect' ? '正在测试所有连接' : '测试所有连接', pending === 'inspect' ? 'wait' : 'radar', {
                disabled: busy || !totals.some(item => item.enabled), 'aria-busy': pending === 'inspect', onClick: () => void run('inspect'),
              }),
              h(Button, { size: 'sm', type: 'submit', variant: 'primary', disabled: busy || !dirty },
                dirty ? h('span', { className: 'a2ar-dirty', title: '有未保存的修改', 'aria-label': '有未保存的修改', role: 'img' }) : null,
                pending === 'save' ? '正在保存…' : '保存配置'))) : null,
          error ? h('div', { ref: errorRef, tabIndex: -1, className: 'a2am-error a2ar-feedback', role: 'alert' }, error,
            (!snapshot || /冲突|重新加载/.test(error)) ? h(Button, { size: 'sm', type: 'button', disabled: busy, onClick: () => void load(lifetime.current.signal) }, dirty ? '放弃更改并重载' : '重新加载') : null) : null,
          notice ? h('p', { className: 'a2ar-feedback', role: 'status' }, notice) : null,
          removed ? h('div', { className: 'a2ar-feedback' }, h('span', { role: 'status' }, `已移除 ${removed.item.name || '未命名来源'}`),
            h(Button, { size: 'sm', type: 'button', disabled: busy, onClick: undo }, '撤销')) : null),
        snapshot ? h('div', { className: 'a2ar-workspace' },
          snapshot.legacyNaming ? h('p', { className: 'a2ar-feedback a2am-muted' }, 'Naming 已移除。请将旧服务发布到 Nacos Agent Registry。') : null,
          h('section', { className: 'a2ar-card', id: `${id}-nacosRegistries`, hidden: section !== 'nacosRegistries', 'aria-label': 'Nacos 注册发现' },
            sourceFilter('nacosRegistries', '注册中心'),
            !draft.nacosRegistries.length ? empty('暂无注册中心') : null,
            section === 'nacosRegistries' && draft.nacosRegistries.length > 0 && !visibleCount ? empty('没有匹配的注册中心') : null,
            draft.nacosRegistries.map((source, index) => h('article', { key: source.id, className: 'a2ar-source', hidden: !matchSource('nacosRegistries', source), 'data-nacos-source': true, 'data-editing': editingRegistry === source.id || undefined },
              sourceHeading(source.name || '新注册中心', source.serverUrl ? `${source.serverUrl} · ${source.namespaceId || 'public'}` : '',
                status(registryResults[source.id], pending === `registry:${source.id}` || (source.enabled && (pending === 'load' || pending === 'inspect'))), 'network', [
                  registryResults[source.id]?.agents ? action(`${openedRegistry === source.id ? '收起' : '查看'} ${source.name} 的 Agent（${registryResults[source.id].agents.length}）`,
                    openedRegistry === source.id ? 'collapse' : 'expand', { key: 'agents', 'data-action': 'details', 'aria-expanded': openedRegistry === source.id,
                      onClick: () => setOpenedRegistry(openedRegistry === source.id ? null : source.id) }, h('span', { className: 'a2ar-details-count' }, registryResults[source.id].agents.length)) : null,
                  action(`测试连接：${source.name}`, 'radar', { key: 'test', 'data-action': 'probe', disabled: busy || !source.serverUrl.trim(), onClick: () => void readSource('registry', source) }),
                  action(`${editingRegistry === source.id ? '收起编辑' : '编辑'} ${source.name}`, 'edit', { key: 'edit', 'data-action': 'edit', disabled: busy, 'aria-expanded': editingRegistry === source.id,
                    onClick: () => setEditingRegistry(editingRegistry === source.id ? null : source.id) }),
                  toggle('nacosRegistries', source),
                  action(`删除 ${source.name}`, 'remove', { key: 'remove', className: 'a2a-remove', 'data-action': 'remove', disabled: busy, onClick: () => remove('nacosRegistries', source, index) }),
                ]),
              editingRegistry === source.id ? h('div', { className: 'a2ar-fields' },
                field('nacosRegistries', source, index, 'serverUrl', '服务地址', 'http://127.0.0.1:18848/nacos', '包含部署的上下文路径，如 /nacos。'),
                h('div', { className: 'a2ar-columns' }, field('nacosRegistries', source, index, 'name', '注册中心名称'),
                  field('nacosRegistries', source, index, 'namespaceId', '命名空间 ID', 'public')),
                field('nacosRegistries', source, index, 'accessTokenEnv', '访问令牌环境变量（选填）', 'NACOS_ACCESS_TOKEN', '只填写变量名，Token 由宿主进程读取。')) : null,
              registryDirectory(source)))),
          h('section', { className: 'a2ar-card', id: `${id}-agents`, hidden: section !== 'agents', 'aria-label': '直连 Card' },
            sourceFilter('agents', '直连 Card'),
            !draft.agents.length ? empty('暂无直连 Card') : null,
            section === 'agents' && draft.agents.length > 0 && !visibleCount ? empty('没有匹配的 Card') : null,
            draft.agents.map((agent, index) => h('article', { key: agent._key, className: 'a2ar-direct-agent', hidden: !matchSource('agents', agent), 'data-direct-agent': true, 'data-editing': editing === agent._key || undefined },
              sourceHeading(agent.name || '新 Agent', agent.cardUrl,
                status(cardResults[agent._key], pending === `card:${agent._key}` || (agent.enabled && pending === 'inspect')), 'card', [
                  cardResults[agent._key]?.agent && !cardResults[agent._key].error ? action(`${openedCard === agent._key ? '收起' : '查看'} ${agent.name} 的 Card 信息`,
                    openedCard === agent._key ? 'collapse' : 'expand', { key: 'details', 'data-action': 'details', 'aria-expanded': openedCard === agent._key,
                      onClick: () => setOpenedCard(openedCard === agent._key ? null : agent._key) }) : null,
                  action(`读取 Card：${agent.name || '新 Agent'}`, 'radar', { key: 'probe', 'data-action': 'probe', disabled: busy || !agent.cardUrl.trim(), onClick: () => void readSource('card', agent) }),
                  action(`${editing === agent._key ? '收起编辑' : '编辑'} ${agent.name || '新 Agent'}`, 'edit', { key: 'edit', 'data-action': 'edit', disabled: busy, 'aria-expanded': editing === agent._key,
                    onClick: () => setEditing(editing === agent._key ? null : agent._key) }),
                  toggle('agents', agent),
                  action(`删除 ${agent.name || '新 Agent'}`, 'remove', { key: 'remove', className: 'a2a-remove', 'data-action': 'remove', disabled: busy, onClick: () => remove('agents', agent, index) }),
                ]),
              editing === agent._key ? h('div', { className: 'a2ar-fields' },
                field('agents', agent, index, 'cardUrl', 'Agent Card 地址', 'https://…', '读取 Card 可自动填入名称和描述。'),
                h('div', { className: 'a2ar-columns' }, field('agents', agent, index, 'name', 'Agent 名称'),
                  h('label', { className: 'a2ar-field' }, h('span', null, 'Agent 类型'), h('select', { className: 'a2am-search', name: `agents-${index}-role`, value: agent.role, disabled: busy, onChange: e => changeItem('agents', agent._key, 'role', e.target.value) },
                    h('option', { value: 'personal' }, '个人 Agent'), h('option', { value: 'business' }, '业务 Agent')))),
                field('agents', agent, index, 'description', '描述（选填）'),
                field('agents', agent, index, 'legacyNames', '旧名称（迁移用）', '多个旧名称用逗号分隔', '仅为同一个 Agent 填写它曾用的名称，以恢复旧会话绑定。'),
                field('agents', agent, index, 'tokenEnv', '访问令牌环境变量（选填）', 'A2A_AGENT_TOKEN', '只填写变量名，Token 由宿主进程读取。')) : null,
              cardResults[agent._key]?.error ? h('p', { className: 'a2am-error a2ar-source-error', role: 'alert' }, cardResults[agent._key].error) : null,
              openedCard === agent._key && cardResults[agent._key]?.agent && !cardResults[agent._key].error ? h(AgentDetails, { agent: cardResults[agent._key].agent }) : null))),
          h('details', { className: 'a2ar-config-path' }, h('summary', null, icon('file', 13), '配置路径'), h('code', null, snapshot.configFile))) : null))

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
