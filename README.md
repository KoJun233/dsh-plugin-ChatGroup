# DSH ChatGroup 插件

把 DSH 原生会话扩展成多 Agent 群聊：保留官方输入框、消息流、执行过程与导航，通过 `@成员` 协调本地 Agent 和远端 A2A Agent。

包名为 `dsh-a2a`，当前版本 **0.11.1**，实际验证的 DSH 运行时为 **0.2.2-rc.1**。本仓库仅包含源码、测试、必要脚本和项目配置，不包含最小演示 Agent、编译产物或本机运行数据。

## 会话行为

- 点击会话右上角 **⋯ → 会话设置**，在原生右侧栏添加自定义本地 Agent 预设或远端 A2A 成员。内容超出高度时可滚动；内置的 standard、ptc、minimal、cordis 不出现在添加列表，已加入的成员保留。
- 没有 `@` 的消息交给当前会话原本的顾问；顾问沿用其模型、提示词、工具和权限，按成员专长决定自己处理或发出 `@成员 具体任务`。
- 用户在消息任意位置 `@` 一个成员时直接转接；多个成员由顾问按出现顺序协调。未加入会话的可发现成员会提示先添加。
- 成员成功后直接答复，顾问不重复转述；失败或需要汇总时由顾问接回。下一条未 `@` 的消息仍交给顾问。
- 本地和远端成员均拥有独立的原生根会话，与顾问同级。成员获得本次任务及自己的既往上下文，不自动获得整个群的历史。
- 署名、正文、复制、反馈、分支、用量、用时和停止操作复用原生消息流；轨迹关联成员自身的执行记录，隐藏重复转接输入与初始化记录，完整请求仍可在详情查看。
- 回复署名使用轻量圆角标签与图标，顾问与成员分别标识；宽窗口显示在左侧，窄窗口移至正文上方。长名称显示省略号，悬停可查看全称，并适配明暗主题。成员历史回复始终沿用外层成员署名，即使成员会话配置了自己的成员，也不会在内部重复标成顾问。
- 转接通过官方事件钩子与插槽完成，不修改官方源码或应用包，不生成 `session_call_agent` 等转接工具调用。

轨迹署名和部分界面适配依赖原生组件结构，升级 DSH 后需要做兼容回归。

## 构建与安装

需要 Node.js **22.19+** 和 npm。官方宿主依赖仍处于预发布版本，安装依赖时使用：

```sh
git clone git@github.com:KoJun233/dsh-plugin-ChatGroup.git
cd dsh-plugin-ChatGroup
npm ci --legacy-peer-deps
npm run typecheck
npm test
npm run build
npm pack
```

构建生成 `dist/`，打包生成 `dsh-a2a-0.11.1.tgz`；两者均不提交 Git。

macOS DMG 版使用应用自带的 CLI 安装到 `desktop` profile：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add "$PWD/dsh-a2a-0.11.1.tgz"
```

Web 版安装到实际使用的 profile：

```sh
dsh plugin --profile web add "$PWD/dsh-a2a-0.11.1.tgz"
```

安装后重新打开 DSH。卸载使用 `dsh plugin --profile desktop remove dsh-a2a`，Web 版将 profile 改为 `web`。

## A2A 配置页面

打开左下角 **更多 → 设置 → A2A 配置**，入口与通用设置、模型、Agent 预设同级，不依赖当前选中的会话。

- **Nacos 注册发现**与**直连 Card**可同时使用，各自支持多个条目，所有启用来源的 Agent 会汇总到会话成员列表。
- **Nacos 注册发现**：为每个注册中心配置名称、服务地址（含部署上下文路径，如 `/nacos`）、命名空间 ID 和可选的令牌环境变量名。各中心可独立启停、编辑、删除、测试连接；展开目录后可搜索、查看 Agent 的版本、接口、流式能力及技能。统一使用 Agent Registry，移除 Naming 模式、服务分组和服务名前缀。
- **直连 Card**：添加、编辑、启停或删除多个 Agent，配置 Card 地址、会话中的名称、类型、描述及可选的 Bearer Token 环境变量名。**读取 Card**验证连接并自动填写空白的名称和描述，展示版本、接口、流式能力和技能，不发送对话。
- **测试所有连接**使用当前表单预览启用的注册中心和 Card，不保存配置、不改变运行中的发现源。单个来源失败会单独提示，其他来源仍可用。
- **保存配置**写入页面底部所示的 `a2a.config.json`，立即更新会话发现，无需重启。首次使用没有配置文件时也可从此页创建；调用角色、超时和其他无关字段保留。配置被其他窗口或外部文件修改时，需要重新加载后再保存。
- Token 从宿主进程环境读取，页面只填写环境变量名；每个注册中心和每个直连 Agent 的凭证独立配置。
- 所有远端 Agent 仍需在各会话设置中显式添加。不同来源的同名 Agent 会保留并标明来源；选择后的调用绑定来源，不会在来源失效时转接到其他同名 Agent。

## 连接配置

默认读取 `~/.dsh/a2a.config.json`；设置 `DSH_HOME` 时改读该目录。`DSH_A2A_CONFIG` 可以指定其他文件。真实配置不提交仓库；已有配置应按需合并。

在同一份配置中设置多个 Nacos 和直连 Card：

```json
{
  "role": "personal",
  "timeoutMs": 180000,
  "pollIntervalMs": 500,
  "nacosRegistries": [
    {
      "id": "team-a",
      "name": "团队 A 注册中心",
      "enabled": true,
      "serverUrl": "http://127.0.0.1:18848/nacos",
      "namespaceId": "public",
      "accessTokenEnv": "NACOS_TEAM_A_TOKEN"
    },
    {
      "id": "team-b",
      "name": "团队 B 注册中心",
      "enabled": true,
      "serverUrl": "https://registry.example.com/nacos",
      "namespaceId": "public"
    }
  ],
  "agents": [
    {
      "name": "backend",
      "role": "business",
      "enabled": true,
      "cardUrl": "https://backend.example.com/card.json",
      "tokenEnv": "A2A_BACKEND_TOKEN"
    },
    {
      "name": "advisor",
      "role": "business",
      "enabled": true,
      "cardUrl": "https://advisor.example.com/card.json"
    }
  ]
}
```

只使用直连 Card 时，将 `nacosRegistries` 设为空数组；只使用 Nacos 时，将 `agents` 设为空数组。两个列表均支持独立的 `enabled` 开关。直连项还可设置 `description`；`tokenEnv` 和 `accessTokenEnv` 保存环境变量名称，不保存实际凭证。

兼容旧单个 `nacos` 对象；没有 `nacosRegistries` 时按一个注册中心读取，设置页面保存时迁移为数组并清除旧模式字段。显式的 `nacosRegistries: []` 会关闭旧单项发现。旧 Naming 服务需重新发布到 Agent Registry。

每个来源的 Agent 拥有稳定 ID，例如 `nacos:team-a:backend`、`direct:advisor`。列表工具返回 ID、名称、显示名称与来源；调用工具应使用返回的 ID。同名来源互不覆盖，旧的裸名称仅在名称唯一时继续解析；已选择的来源不可用时会报错。

受保护的 Nacos 使用每项的 `accessTokenEnv` 指向 token 环境变量；当前不自动登录或续期。凭证仅发往同源端点，禁止带用户名或密码的 URL，不跟随携带凭证的重定向。

统一使用 **Nacos 原生 Agent Registry**（Nacos 3.1+，本地验证 3.2.0）。Agent 显示在「Agent 管理 → Agent 列表」，默认命名空间为 `public`；通过 `/v3/admin/ai/a2a/list` 和 `/v3/admin/ai/a2a` 列表与详情接口发现。

发布使用官方 **URL** 模式，`url` 保存真正的 A2A 调用地址。Card 持久保留，无需注册进程或 Naming 心跳，停止 Agent 不会自动删除目录条目；本模式不做实例健康检查或动态端点租约。相同命名空间内名称唯一，目录名称需为 1–64 个 ASCII 可见字符。

Nacos 3.2 的 Card 模型使用 `url` / `preferredTransport`，不能完整保存 A2A 1.0 的逐接口信息。插件发布兼容的目录字段并保留真实协议版本及 AG-UI 扩展，通过 `urn:dsh:a2a:registry:v1` 扩展记录 `role` 与原始 `cardUrl`。实际调用读取原始 Card，保留其完整接口和安全声明；源地址可以与本地目录名称不同。凭证和 `tokenEnv` 不写入目录，不覆盖来源地址不同的同名条目。

通过控制台或其他客户端导入、没有上述扩展的 Card，也可直接按 Nacos 返回的 Card 连接。缺少角色分类时按 `personal` 处理，防止业务身份因分类缺失而调用个人助理；供业务身份调用的成员应以 `business` 角色发布。远端仍需独立校验调用者身份。

## 必要脚本

`npm run register:agent` 读取已有服务的 Agent Card 并发布到选定的 Agent Registry。命令完成后即可退出；重复发布同源条目会更新并选择其默认发布版本。

```sh
npm run register:agent -- \
  --config ./a2a.config.json \
  --registry team-a \
  --name backend \
  --card-url https://backend.example.com/card.json \
  --role business
```

`--config` 默认使用 `DSH_A2A_CONFIG`，未设置时读取当前目录的 `a2a.config.json`。`--registry` 接受注册中心 ID 或名称；仅有一个启用的中心时可省略。`--name`、`--card-url` 必填，`--role` 为 `personal` 或 `business`，默认 `business`。注册中心的访问令牌按该项的 `accessTokenEnv` 从环境读取。

`npm run smoke` 验证原生工具、Agent 发现及 A2A 调用。通过 `DSH_A2A_CONFIG` 指定本机配置，设置 `A2A_AGENT_NAME` 和 `A2A_MESSAGE` 后执行。脚本只报告完成状态和回复长度，不打印回复正文；这会实际调用指定服务。

`compose.yaml` 仅提供可选的本机 Nacos，不包含演示 Agent。使用前在本机生成 token：

```sh
export NACOS_AUTH_TOKEN="$(openssl rand -base64 32)"
docker compose up -d --wait nacos
```

该 Compose 仅监听 `127.0.0.1`，关闭认证，用于本机开发；线上应连接已有的受保护 Nacos。服务端数据保存在 Docker 数据卷，不提交 Git。

## 协议与入站

使用官方 `@a2a-js/sdk`，支持 JSON-RPC 的 A2A **1.0 / 0.3**。声明 streaming 能力的服务默认通过 SSE 返回，其他服务使用轮询；保留任务状态、contextId、取消与待补充输入的处理。

`dsh-a2a/server` 是可选入站插件，默认客户端包配置不会启用它。在自己的 Cordis 配置中显式启用时，需要设置 `publicUrl`、已有模型路由，以及通过 `tokenEnv` 绑定可信身份的 `principals`。`allowedTools` 默认空；可通过 `registryConfigFile` 将 Card 发布到所有启用的 Nacos 注册中心。每个入站任务使用独立会话，结束后释放。

个人身份可调用个人或业务 Agent；业务身份不能主动调用个人 Agent。Nacos 负责发现，不提供 NAT 穿透；跨网络连接仍需已有网络通道。

## 远端 AG-UI 转换与原生展示

远端 Agent Card 声明 `urn:raycloud:a2a:ag-ui:v1` 时，会话适配器通过 `A2A-Extensions` 请求该扩展，从 `ag-ui.events` 产物的 `parts[].data` 提取事件。扩展 metadata 必须包含 `schemaVersion: 1`、`runId`、`threadId` 和从 1 开始递增的 `sequence`。这是本项目的 A2A 扩展绑定；其他 A2A 服务需要实现相同约定。事件体使用 `@ag-ui/core@1.0.4` 官方 schema 校验，Task 快照和轮询中的已读事件按序号去重。缺失首帧、序号断档、标识冲突及流截断会报告错误。未声明或未实际返回该扩展的服务继续按普通 A2A 正文显示。

转换器仅接收数据，不创建新消息卡片。`TEXT_MESSAGE_*` 转为原生正文流，`REASONING_MESSAGE_*` 转为原生思考块，`TOOL_CALL_START/ARGS/END/RESULT` 转为原生工具调用和结果记录。工具参数结束不代表执行结束，界面会等待真实结果；一次远端 HTTP 执行可以形成多个原生模型步骤，并保留在该成员自己的会话中，供官方对话组件与轨迹组件实时显示和历史重放。顾问 @成员与用户直接 @成员使用相同转换路径。

远端会话使用独立的工具记录消费者，工具名显示为 `a2a.<远端工具名>`。消费者只匹配本次远端声明的调用并记录远端结果，不进入本地工具查找、授权或执行流程，也不会因工具同名而使用本地工具的专用渲染。真正的业务工具及权限由远端服务管理。AG-UI 正文已经用于显示时，A2A 的 `conversation_result` 仅作为兼容结果，不再输出第二份正文。

首版转换上述显式 start/content/end 生命周期事件。状态快照、自定义事件、activity、嵌套子 Agent 及加密推理暂不映射；chunk 简写事件需要服务端展开为对应生命周期事件。工具结果中的非文本结构按 JSON 文本保留，不自动加载媒体。未提供的 token 用量不补造。远端取消能否真正停止执行仍取决于服务端的 `CancelTask` 实现。

## 开发与凭证

- `src/`：群聊路由、同级会话、原生界面适配、A2A 客户端/服务端与 Nacos 发现。
- `tests/`：离线回归测试，使用本机服务和测试凭证，不需要真实模型密钥。
- `scripts/`：前端构建、已有 Agent 注册及调用验证。
- `cordis.patch.yml`：插件安装声明；`package-lock.json` 用于固定依赖。

`.gitignore` 排除本机配置、环境文件、私钥、日志、截图所在的 `.local/`、依赖、覆盖率、构建与打包产物。实际 token 和模型凭证通过本机环境或受限配置文件提供，不写入源码。

MIT License。
