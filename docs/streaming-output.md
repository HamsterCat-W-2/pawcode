# PawCode 流式输出设计

## 目标

PawCode 应在模型生成过程中持续向终端发送文本，而不是等待完整响应后一次性显示。同时必须保证：

- AgentRuntime 不直接依赖 `pi-ai` 事件类型。
- 工具参数完整后才执行工具。
- 流结束后仍能保存完整 Assistant 消息，用于后续工具轮次。
- thinking、文本、工具调用、错误和取消具有明确事件。
- CLI 只负责渲染，不参与模型协议处理。

## 当前问题

当前 `ModelAdapter.complete()` 返回完整 `ModelResponse`：

```text
模型生成完整响应
        ↓
ModelResponse
        ↓
AgentRuntime
        ↓
CLI 一次性输出
```

生成期间终端没有反馈。回答越长，用户等待空白界面的时间越长。

## 目标链路

```text
pi-ai stream event
        ↓
PiAiModelAdapter
        ↓ PawCode ModelEvent
AgentRuntime
        ↓ PawCode AgentEvent
CLI
```

Adapter 负责把第三方流事件转换为 PawCode 事件；Runtime 负责编排模型和工具；CLI 负责实时显示。

## ModelEvent

模型层提供以下稳定事件：

```ts
type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'completed'; response: ModelResponse }
```

约束：

- `text_delta` 只包含本次新增文本，不能重复发送累计内容。
- `thinking_delta` 与最终回答分开，避免把推理内容混入回答。
- `tool_call` 只在工具名称和参数完整后发出。
- `completed` 必须携带完整响应，Runtime 用它更新会话历史。
- 模型失败通过 async generator 抛出异常，由 Runtime 转换为 `failed`。

## AgentEvent

Runtime 在原有事件基础上增加：

```ts
type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | ...
```

Runtime 将模型 delta 原样向上转发。工具调用仍由 Runtime 执行，CLI 不接触 ToolRegistry。

## 单轮生命周期

```text
turn_started
    ↓
thinking_delta × N（可选）
    ↓
text_delta × N（可选）
    ↓
tool_call × N（可选）
    ↓
completed（模型层完整响应）
    ↓
无工具：Agent completed
有工具：执行工具并进入下一轮
```

模型可能同时返回文本和工具调用。已经通过 `text_delta` 展示的文本不能在 Agent `completed` 时再次打印。

## CLI 渲染

文本 delta 使用：

```ts
process.stdout.write(event.text)
```

不能使用 `console.log()`，否则每个 delta 都会换行。CLI 在第一次文本 delta 前输出 `PawCode > `，在本轮文本结束或工具开始前补换行。

thinking 默认只显示状态，不直接暴露完整推理内容。当前 MVP 可以显示简短 `思考中...` 提示，同时保留 `thinking_delta` 事件供未来 TUI 使用。

## 取消和超时

- 用户传入的 `AbortSignal` 转发给 `pi-ai stream()`。
- Adapter 自己创建超时 `AbortController`。
- 任一信号触发都终止流。
- `pi-ai` 的 error/aborted 终止事件转换为异常。
- Adapter 必须在 `finally` 中移除监听器并清理定时器。

## 验收标准

- 长回答在完整生成结束前开始显示。
- 每个文本片段只显示一次。
- 工具参数完整后才调用 ToolRegistry。
- 工具执行后，下一轮模型仍能继续流式输出。
- 最终完整消息被写入会话历史。
- Ctrl+C 或超时能够中止请求。
- 流错误产生 Agent `failed` 事件。
- 单元测试覆盖文本流、工具流、多轮继续和错误。
