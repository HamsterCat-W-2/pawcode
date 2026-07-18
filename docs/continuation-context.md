# PawCode 后续任务上下文

这份文档用于在新的 Codex/Agent 对话中快速恢复项目状态。开始工作前先阅读本文件，再执行 `git status --short --branch`，以实际工作区状态为准。

## 项目定位

PawCode 是一个用 Node.js、TypeScript 和 pnpm 编写的终端 AI 编程 Agent。当前 v0.3 已实现：在原有只读分析能力上加入统一权限控制、文件编辑、命令执行和 Git 验证工作流。

- AI 编程 Agent 的执行循环。
- CLI 与流式输出。
- Tool Calling。
- 多模型供应商兼容。
- 权限控制，以及后续的 MCP、会话和多 Agent。

项目路径：

```text
/Users/guoxuanloveweiyan/Documents/guoxuan/programe/pawcode
```

## Git 状态

当前分支：

```text
add_pi_ai_adapter
```

截至 v0.3 开发开始前的最新提交：

```text
995ab48 chore: chore
```

关键提交历史：

```text
995ab48 chore: chore
25c8787 docs: add docs
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
cd "/Users/guoxuanloveweiyan/Documents/guoxuan/programe/pawcode"
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

AgentRuntime
 ↓ ToolCall
ToolRegistry
 ↓ PermissionRequest
PermissionManager
 ↓ allow
文件、命令与 Git 工具
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
├── permissions/
│   └── permission-manager.ts      allow、ask、deny 与会话规则
├── runtime/
│   ├── agent-event.ts             CLI/TUI 可复用的运行时事件
│   └── agent-runtime.ts           多轮模型—工具编排
└── tools/
    ├── tool.ts                    本地工具接口
    ├── tool-registry.ts           查找、执行、截断工具结果
    ├── workspace-files.ts         工作区路径安全与文件访问
    ├── list-files-tool.ts
    ├── read-file-tool.ts
    ├── grep-tool.ts
    ├── write-file-tool.ts
    ├── apply-patch-tool.ts
    ├── process-runner.ts
    ├── run-command-tool.ts
    └── git-diff-tool.ts
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
- Token 用量、成本和 stop reason 的 Domain 转换与 CLI 汇总展示。
- `allow`、`ask`、`deny` 权限管理；非交互副作用默认拒绝。
- `write_file`、`apply_patch`、`run_command` 和 `git_diff`。
- 命令参数不经过 Shell，支持工作区 cwd、超时、取消和输出截断。

截至本次实现，共有 7 个测试文件、22 个测试；格式、类型、测试和构建均通过。继续任务前仍须重新运行完整验证。

## 未完成事项与建议顺序

1. 使用真实小米 Token Plan 手工验证流式输出、用量和 stop reason。
2. 对 v0.3 权限提示、文件修改和命令取消做一次真实 CLI 手工验收。
3. v0.4：会话持久化与恢复、上下文压缩、JSON 输出。
4. v0.5：MCP Client、Hooks、自定义命令和子 Agent。

v0.3 的设计、安全边界和验收标准见 [v0.3-design.md](./v0.3-design.md)。副作用工具必须经过 `ToolRegistry` 和 `PermissionManager`，不能直接暴露给模型。

## 给新窗口的起始提示

可直接复制下面这段给新的 Agent：

```text
请阅读 docs/continuation-context.md、docs/streaming-output.md 和 docs/v0.3-design.md，
然后检查 git status --short --branch。项目是 PawCode，当前在
add_pi_ai_adapter 分支。保持 PawCode Domain 与 PiAiModelAdapter 的
协议边界，不要让 AgentRuntime 直接依赖 pi-ai。所有写入和命令必须经过
PermissionManager。请基于文档继续实现下一个功能，并在修改后运行
pnpm format:check、pnpm check、pnpm test、pnpm build。
```
