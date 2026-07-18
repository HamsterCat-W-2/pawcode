# PawCode 后续任务上下文

这份文档用于在新的 Codex/Agent 对话中快速恢复项目状态。开始工作前先阅读本文件，再执行 `git status --short --branch`，以实际工作区状态为准。

## 项目定位

PawCode 是一个用 Node.js、TypeScript 和 pnpm 编写的终端 AI 编程 Agent。当前是 v0.2，只提供**只读**文件能力，重点用于学习：

- AI 编程 Agent 的执行循环。
- CLI 与流式输出。
- Tool Calling。
- 多模型供应商兼容。
- 后续的 MCP、权限、会话和多 Agent。

项目路径：

```text
/Users/shmiwangguoxuan/Documents/claude code cli study/pawcode
```

## Git 状态

当前分支：

```text
add_pi_ai_adapter
```

截至本文档创建时的最新提交：

```text
815f563 feat: stream model output in the CLI
```

关键提交历史：

```text
815f563 feat: stream model output in the CLI
d57bf16 docs: explain pi-ai protocol conversions
c66abe8 refactor: split domain types by concept
033fb34 feat: add pi-ai provider compatibility
360de21 feat: add PawCode read-only agent MVP
```

不要假设工作区一定干净；每次继续前检查 Git 状态。`.env` 已被忽略，绝不能提交密钥。

## 运行和验证

环境要求：Node.js `>=22.19.0`、pnpm 11。

```bash
cd "/Users/shmiwangguoxuan/Documents/claude code cli study/pawcode"
pnpm install
pnpm format:check
pnpm check
pnpm test
pnpm build
```

常用运行方式：

```bash
pnpm dev
pnpm dev "解释当前项目的架构"
```

流式请求生成期间可按 `Ctrl+C` 取消当前请求。

## 配置

PawCode 对各供应商使用统一字段：

```dotenv
MODEL_PROVIDER=供应商ID
MODEL_NAME=模型ID
MODEL_API_KEY=模型服务密钥
MAX_AGENT_TURNS=10
MAX_TOOL_OUTPUT_CHARS=20000
```

小米 MiMo Token Plan 中国区示例：

```dotenv
MODEL_PROVIDER=xiaomi-token-plan-cn
MODEL_NAME=mimo-v2.5
MODEL_API_KEY=你的密钥
```

说明：

- `MODEL_BASE_URL` 仅用于自定义 OpenAI-compatible 服务，例如 Ollama、vLLM 或代理。
- 设置了 `MODEL_BASE_URL` 时，PawCode 会走自定义 Provider 路径。
- `pi-ai` 原生环境变量仍兼容，但项目推荐统一使用 `MODEL_API_KEY`。
- 本地 `.env` 必须放在 `pawcode/.env`，不要复用或移动其他项目的密钥文件。

## 当前架构

```text
CLI
 ↓ AgentEvent
AgentRuntime
 ↓ ModelRequest / ModelResponse
ModelAdapter
 ↓ ModelEvent
PiAiModelAdapter
 ↓ pi-ai Context / Message / Tool
小米 MiMo / OpenAI / Anthropic / 其他 Provider
```

目录职责：

```text
src/
├── cli.ts                         终端交互和事件渲染
├── config/config.ts               环境变量读取与校验
├── domain/
│   ├── message.ts                 PawCode 消息协议
│   ├── model.ts                   ModelRequest / ModelResponse
│   └── tool.ts                    ToolCall / ToolDefinition
├── models/
│   ├── model-adapter.ts           Runtime 依赖的稳定接口
│   ├── model-event.ts             供应商无关的流事件
│   └── pi-ai-model-adapter.ts     pi-ai 适配、认证、超时、协议转换
├── runtime/
│   ├── agent-event.ts             CLI/TUI 可复用的运行时事件
│   └── agent-runtime.ts           多轮模型—工具编排
└── tools/
    ├── tool.ts                    本地工具接口
    ├── tool-registry.ts           查找、执行、截断工具结果
    ├── workspace-files.ts         工作区路径安全与文件访问
    ├── list-files-tool.ts
    ├── read-file-tool.ts
    └── grep-tool.ts
```

## 重要架构决策

### 保留 PawCode Domain 与 pi-ai 的 Adapter 边界

用户明确倾向于保持分层，不让 `AgentRuntime` 直接依赖 `pi-ai`。因此当前结构是：

```text
PawCode Domain
     ↓ 显式转换
PiAiModelAdapter
     ↓
pi-ai
```

不要在未讨论的情况下把 Runtime 改为直接保存 `pi-ai Context`。虽然那样代码更短，但会让第三方库类型扩散到 Runtime、工具和会话层。

当前 `PiAiModelAdapter` 中的转换函数存在是有意的：

- `toPiContext()`：PawCode 请求 → pi-ai Context。
- `toPiMessage()`：转换 user、assistant、tool 消息。
- `createFallbackAssistantMessage()`：兼容没有原始供应商消息的旧数据或测试数据。
- `fromPiResponse()`：pi-ai 完整消息 → PawCode 的简化响应。
- `toPiTool()`：PawCode OpenAI 风格工具定义 → pi-ai 工具定义。

`providerData` 保存原始 `pi-ai AssistantMessage`，使下一轮能够重放 thinking signature、response ID 等供应商连续对话所需的信息。

当前工具参数仍在两种结构间转换：PawCode 使用 OpenAI 风格 JSON 字符串，`pi-ai` 使用对象。不要在小改动中贸然删除这套兼容逻辑。

### 流式输出

详细设计见 [streaming-output.md](./streaming-output.md)。

核心接口：

```ts
interface ModelAdapter {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>
}
```

`ModelEvent`：

```ts
type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'completed'; response: ModelResponse }
```

关键行为：

- `PiAiModelAdapter` 使用 `models.stream()`，而非 `models.complete()`。
- `text_delta` 和 `thinking_delta` 经由 `AgentRuntime` 转发到 CLI。
- CLI 用 `process.stdout.write()` 输出文本，避免每个 delta 换行。
- CLI 默认不展示完整 thinking 内容，只显示“思考中...”状态。
- 工具只在完整响应到达后执行；完整响应被写入历史后才进入下一轮。
- `Ctrl+C` 由 `process.once('SIGINT', cancel)` 转成 `AbortSignal`，取消当前请求。
- Adapter 同时支持外部取消和 120 秒超时。

## 已实现能力

- 交互式 CLI、单次 prompt、`/clear`、`/status`、`/exit`。
- 多轮 Agent Runtime。
- 多供应商模型选择和自定义 OpenAI-compatible Endpoint。
- 流式文本与 thinking 状态。
- 只读工具：`list_files`、`read_file`、`grep`。
- 工作区边界检查、符号链接检查、工具输出截断。
- 工具调用循环。
- Prettier、TypeScript、Vitest。

截至流式功能提交，测试为 5 个测试文件、12 个测试；后续以实际 `pnpm test` 输出为准。

## 未完成事项与建议顺序

建议后续按下面顺序推进：

1. 为流式输出做一次真实小米 Token Plan 手工验证，确认文本在完整回答前出现。
2. 增加 Token 用量、成本和最终 stop reason 的 CLI 展示。
3. 新增 `write_file` 与补丁编辑工具。
4. 新增 Shell 命令执行工具。
5. 在执行写文件与命令前实现权限确认、允许规则和工作区安全策略。
6. 加入 Git diff、测试运行工作流。
7. 实现会话持久化、上下文压缩、JSON 输出。
8. 接入 MCP Client。
9. 最后再设计子 Agent 与多 Agent 编排。

注意：第 3、4 步会引入写入和命令执行能力，必须与第 5 步的权限机制一起设计；不要把它们作为无确认工具直接暴露给模型。

## 给新窗口的起始提示

可直接复制下面这段给新的 Agent：

```text
请阅读 docs/continuation-context.md 和 docs/streaming-output.md，
然后检查 git status --short --branch。项目是 PawCode，当前在
add_pi_ai_adapter 分支。保持 PawCode Domain 与 PiAiModelAdapter 的
协议边界，不要让 AgentRuntime 直接依赖 pi-ai。请基于文档继续实现
下一个功能，并在修改后运行 pnpm format:check、pnpm check、pnpm test、pnpm build。
```
