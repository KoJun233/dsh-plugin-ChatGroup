# DSH ChatGroup 插件

把 DSH 原生会话扩展成多 Agent 群聊：保留官方输入框、消息流、执行过程与导航，通过 `@成员` 协调本地 Agent 和远端 A2A Agent。

包名为 `dsh-a2a`，当前版本 **0.8.2**，实际验证的 DSH 运行时为 **0.2.2-rc.1**。本仓库仅包含源码、测试、必要脚本和项目配置，不包含最小演示 Agent、编译产物或本机运行数据。

## 会话行为

- 点击会话右上角 **⋯ → 会话设置**，在原生右侧栏添加已有本地 Agent 预设或远端 A2A 成员。
- 没有 `@` 的消息交给当前会话原本的主 Agent；主 Agent 沿用其模型、提示词、工具和权限，按成员专长决定自己处理或发出 `@成员 具体任务`。
- 用户在消息任意位置 `@` 一个成员时直接转接；多个成员由主 Agent 按出现顺序协调。未加入会话的可发现成员会提示先添加。
- 成员成功后直接答复，主 Agent 不重复转述；失败或需要汇总时由主 Agent 接回。下一条未 `@` 的消息仍交给主 Agent。
- 本地和远端成员均拥有独立的原生根会话，与主 Agent 同级。成员获得本次任务及自己的既往上下文，不自动获得整个群的历史。
- 署名、正文、复制、反馈、分支、用量、用时和停止操作复用原生消息流；轨迹关联成员自身的执行记录，隐藏重复转接输入与初始化记录，完整请求仍可在详情查看。
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

构建生成 `dist/`，打包生成 `dsh-a2a-0.8.2.tgz`；两者均不提交 Git。

macOS DMG 版使用应用自带的 CLI 安装到 `desktop` profile：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add "$PWD/dsh-a2a-0.8.2.tgz"
```

Web 版安装到实际使用的 profile：

```sh
dsh plugin --profile web add "$PWD/dsh-a2a-0.8.2.tgz"
```

安装后重新打开 DSH。卸载使用 `dsh plugin --profile desktop remove dsh-a2a`，Web 版将 profile 改为 `web`。

## 连接配置

默认读取 `~/.dsh/a2a.config.json`；设置 `DSH_HOME` 时改读该目录。`DSH_A2A_CONFIG` 可以指定其他文件。真实配置不提交仓库；已有配置应按需合并。

可在本机配置文件中设置 Nacos 发现：

```json
{
  "role": "personal",
  "timeoutMs": 180000,
  "pollIntervalMs": 500,
  "agents": [],
  "nacos": {
    "serverUrl": "http://127.0.0.1:18848/nacos",
    "namespaceId": "",
    "groupName": "DSH_A2A",
    "servicePrefix": "a2a."
  }
}
```

也可在 `agents` 中配置已有服务，不启用 Nacos。每项包含 `name`、`role`（`personal` 或 `business`）、`cardUrl`，以及可选的 `description`、`tokenEnv`。`tokenEnv` 保存环境变量名称，不保存实际凭证。

受保护的 Nacos 使用 `nacos.accessTokenEnv` 指向 token 环境变量；当前不自动登录或续期。静态配置覆盖同名发现记录。凭证仅发往同源端点，禁止带用户名或密码的 URL，不跟随携带凭证的重定向。

Nacos 适配使用 **3.2 Naming HTTP v3**，在实例元数据中保存 `a2aCardUrl`、`a2aRole` 和 `a2aDescription`。不使用 Nacos 原生 AI Agent Registry；两种注册模型需要分别适配。

## 必要脚本

`npm run register:agent` 将已有 A2A 服务注册到 Nacos，持续发送心跳，正常退出时注销。运行前通过环境变量提供：

| 环境变量 | 用途 |
|---|---|
| `NACOS_URL` | Nacos API 地址，必填 |
| `A2A_AGENT_NAME` | 服务名称，必填 |
| `A2A_AGENT_CARD_URL` | 已有服务的 Agent Card 地址，必填 |
| `A2A_AGENT_ROLE` | `personal` 或 `business`，默认 `business` |
| `A2A_AGENT_DESCRIPTION` | 成员职责说明，可选 |
| `NACOS_NAMESPACE_ID` / `NACOS_GROUP_NAME` | namespace 与服务分组，可选 |
| `NACOS_SERVICE_PREFIX` | 服务名前缀，可选 |
| `NACOS_ACCESS_TOKEN` | Nacos 访问 token，可选，仅通过本机环境提供 |

`npm run smoke` 验证原生工具、Agent 发现及 A2A 调用。通过 `DSH_A2A_CONFIG` 指定本机配置，设置 `A2A_AGENT_NAME` 和 `A2A_MESSAGE` 后执行。脚本只报告完成状态和回复长度，不打印回复正文；这会实际调用指定服务。

`compose.yaml` 仅提供可选的本机 Nacos，不包含演示 Agent。使用前在本机生成 token：

```sh
export NACOS_AUTH_TOKEN="$(openssl rand -base64 32)"
docker compose up -d --wait nacos
```

该 Compose 仅监听 `127.0.0.1`，关闭认证，用于本机开发；线上应连接已有的受保护 Nacos。服务端数据保存在 Docker 数据卷，不提交 Git。

## 协议与入站

使用官方 `@a2a-js/sdk`，支持 JSON-RPC 的 A2A **1.0 / 0.3**。声明 streaming 能力的服务默认通过 SSE 返回，其他服务使用轮询；保留任务状态、contextId、取消与待补充输入的处理。

`dsh-a2a/server` 是可选入站插件，默认客户端包配置不会启用它。在自己的 Cordis 配置中显式启用时，需要设置 `publicUrl`、已有模型路由，以及通过 `tokenEnv` 绑定可信身份的 `principals`。`allowedTools` 默认空；可通过 `registryConfigFile` 注册到 Nacos。每个入站任务使用独立会话，结束后释放。

个人身份可调用个人或业务 Agent；业务身份不能主动调用个人 Agent。Nacos 负责发现，不提供 NAT 穿透；跨网络连接仍需已有网络通道。

## 开发与凭证

- `src/`：群聊路由、同级会话、原生界面适配、A2A 客户端/服务端与 Nacos 发现。
- `tests/`：离线回归测试，使用本机服务和测试凭证，不需要真实模型密钥。
- `scripts/`：前端构建、已有 Agent 注册及调用验证。
- `cordis.patch.yml`：插件安装声明；`package-lock.json` 用于固定依赖。

`.gitignore` 排除本机配置、环境文件、私钥、日志、截图所在的 `.local/`、依赖、覆盖率、构建与打包产物。实际 token 和模型凭证通过本机环境或受限配置文件提供，不写入源码。

MIT License。
