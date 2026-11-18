# A2A 推送心跳约定 v1

这是本项目约定，不是新增 A2A RPC，也不把 `HEARTBEAT` 冒充官方 A2A 事件类型。接入的远端按本文发送，DSH 不主动 Ping、不增加 `GetTask` 保活、不重发用户输入、不自动重连或重新执行任务。

## 唯一数据格式

复用现有 A2A 流的 `artifactUpdate`，产物名称固定为 `a2a.heartbeat`，扩展标识固定为 `urn:raycloud:a2a:heartbeat:v1`。只有一个 DataPart，data 内容为：

```json
{
  "type": "HEARTBEAT",
  "sequence": 1,
  "timestamp": 1794993600000
}
```

- `sequence`：本次 task 内从 1 开始递增的正安全整数。重复或倒序心跳被忽略且不续期；不要求连续，丢掉某次心跳不影响后续。
- `timestamp`：发送方 Unix 毫秒时间戳，正安全整数。接收方按本地收到事件的时刻续期，不依赖两端时钟同步。
- 不接受额外 data 字段、其他类型、纯文本 `pong`、SSE 注释或空帧作为心跳。

## A2A 1.0 JSON-RPC SSE 完整样例

下例中的 `id` 必须是当前 `SendStreamingMessage` 请求的 JSON-RPC id；`taskId`、`contextId` 必须对应当前执行，不能另建 task/context。每个任务先发 Task，再发进度或心跳。

```text
data: {"jsonrpc":"2.0","id":1,"result":{"artifactUpdate":{"taskId":"task-123","contextId":"session-456","artifact":{"artifactId":"task-123:heartbeat","name":"a2a.heartbeat","metadata":{"extension":"urn:raycloud:a2a:heartbeat:v1"},"parts":[{"data":{"type":"HEARTBEAT","sequence":1,"timestamp":1794993600000}}]},"append":false,"lastChunk":false}}}

```

`artifactId` 在同一任务内固定，例如 `${taskId}:heartbeat`，每次 `append:false` 替换上次心跳，避免 Task 快照无限累积。`lastChunk:false`，心跳不是最终结果，不能完成任务。A2A 0.3 接入仍由既有 SDK 使用该版本的 artifact-update 信封承载，DataPart 和产物约定完全相同；不另定义心跳兼容格式。

此心跳独立于 AG-UI，不使用 AG-UI 的序号、不要求客户端启用 AG-UI。可以在 Card 的 `capabilities.extensions` 声明该 URI 及 `params.intervalMs:15000`；无需新增 Ping/Pong 协商或客户端请求来触发心跳。

## 发送时机与生命周期

1. 任务进入执行后启动独立调度器，每 15 秒发送一次；在没有业务输出时也必须工作。
2. 先发送 Task，绑定当前 taskId/contextId，随后发送心跳。不要每次心跳创建新任务或新 artifactId。
3. 正常文本、工具进度与心跳可以共享 A2A 连接，但心跳不得成为 TextPart、回答正文、工具调用或工具结果。
4. 心跳发送必须走 SDK 的 emitter/event bus，而不是绕过 SDK 直接并发写网络流。不要占用执行模型/工具的同一阻塞线程；要确保发送器不会在最终状态之后继续发心跳。
5. 在发出最终成功、失败或取消状态**之前**停止并等待正在发送的心跳退出；`finally` 兜底释放调度器。客户端断开/任务销毁也应清理，避免任务泄漏。
6. 不要用心跳宣称任务已完成、已成功或已取消；这些仍由正常 A2A 状态事件表达。

## Java AgentEmitter 单次发送示例

沿用现有服务端 `AgentEmitter.addArtifact` API，调度与清理由远端实现：

```java
String uri = "urn:raycloud:a2a:heartbeat:v1";
Map<String, Object> data = Map.of(
        "type", "HEARTBEAT",
        "sequence", sequence.incrementAndGet(),
        "timestamp", System.currentTimeMillis());
emitter.addArtifact(
        List.of(new DataPart(data, Map.of())),
        emitter.getTaskId() + ":heartbeat",
        "a2a.heartbeat",
        Map.of("extension", uri),
        false,
        false);
```

`sequence` 是本次执行独有的 `AtomicLong(0)`。不要全局共享；不要在每次定时触发时重新归零。这段只是单次发包代码，仍需按上述生命周期管理定时任务。

## 接收方行为

- 进度或有效的新心跳刷新 `timeoutMs` 空闲期限；默认连续 60 秒未收到才中断。不是运行满 60 秒就取消。
- 心跳单独消费，不调用正文更新，不输出到 DSH 对话、不生成工具记录；不影响已有正文、AG-UI 步骤或任务状态。
- 固定心跳名称下的错误 schema、错误扩展标识、其他 task/context 的心跳属于协议错误，不当成保活，也不转为正文。
- SSE 注释、任意网络字节、重复心跳均不续期，DSH 不为其增加兼容分支。
- `maxDurationMs:0` 默认无总时长限制；设置正值可独立限制整次调用。主动停止始终生效。
- 中断只取消已有任务，不重新发送输入。`remoteCancellation=unknown` 表示远端取消尚未确认，不能据此断言任务已停止。

## 远端验收

1. 空闲超时设为 60 秒、执行 90 秒、每 15 秒发心跳：任务应正常完成，只执行一次。
2. 运行期间持续输出正常文本/工具进度但不发心跳：只要没有 60 秒空窗，也应正常完成。
3. 停止所有进度和心跳：在最后有效事件约 60 秒后中断，并尝试取消同一任务。
4. 只重复发送相同 sequence、SSE 注释或文本 pong：不能保活。
5. 持续发送心跳时点击停止，或达到配置的总时长上限：仍应中断。
6. 心跳不出现在正文、工具记录或最终答案中；原 AG-UI 事件序号保持不变。
