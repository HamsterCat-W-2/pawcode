# PawCode 后续任务上下文

本文件用于在新 Codex/Agent 对话中快速恢复状态。继续工作前先阅读本文件，再执行 `git status --short --branch`；实际工作区优先于文档。

## 当前状态

- 项目：Node.js、TypeScript、pnpm 编写的终端 AI 编程 Agent。
- 版本：v0.4。
- 路径：`/Users/guoxuanloveweiyan/Documents/guoxuan/programe/pawcode`。
- 分支：`codex/session-persistence-resume`。
- 当前分支 HEAD 包含 v0.4 会话持久化、恢复、上下文压缩和 NDJSON 输出；具体提交号及工作区状态继续以 `git log -1` 和 `git status` 为准。
- `.env` 已忽略，绝不能提交密钥。

关键历史：

```text
9e5d599 docs: refresh continuation context
2053e6c feat: add safe write and command workflows
995ab48 chore: chore
25c8787 docs: add docs
815f563 feat: stream model output in the CLI
d57bf16 docs: explain pi-ai protocol conversions
c66abe8 refactor: split domain types by concept
033fb34 feat: add pi-ai provider compatibility
360de21 feat: add PawCode read-only agent MVP
```

## 已实现能力

- 交互式 CLI、单次 prompt、`/clear`、`/status`、`/exit`。
- 多轮 Agent Runtime、多供应商 `pi-ai` Adapter、自定义 OpenAI-compatible Endpoint。
- 文本流、thinking 状态、`Ctrl+C` 取消和 120 秒模型超时。
- 只读工具：`list_files`、`read_file`、`grep`。
- v0.3 工具：`write_file`、`apply_patch`、`run_command`、`git_diff`。
- Token、成本和最终 stop reason 的跨轮汇总与 CLI 展示。
- `allow`、`ask`、`deny` 权限决策；非交互副作用默认拒绝。
- 工作区、符号链接和 `.git` 元数据保护。
- 命令使用 `spawn(command, args, { shell: false })`，支持 cwd、超时、取消和输出截断。
- 危险程序、Shell command 选项和破坏性 Git 子命令硬拒绝。
- 项目级 `.pawcode/sessions` 会话保存、列表、恢复和工作区校验。
- Session schema v1、Zod 磁盘校验、`0600` 权限和临时文件原子替换。
- Claude Code 风格会话入口：`--continue/-c`、`--resume/-r [id|name]`、`--fork-session`、`--name/-n` 和 `--list-sessions`。
- 交互会话命令：`/new`、`/sessions`、`/resume [id|name]`、`/rename [name]`、`/branch [name]`。
- 根据模型 context window 在完整用户轮次边界压缩旧历史，保留工具调用/result 对。
- `--json` 严格 NDJSON；stdout 不混入人类装饰输出，非交互副作用默认拒绝。
- 人类可读输出默认隐藏成功工具明细；`--verbose` 才显示参数和结果长度，工具失败始终显示。
- 交互 TTY 显示零依赖 `PAWCODE` Banner；窄终端自动降级，`NO_COLOR` 关闭颜色，JSON 和重定向不显示。

设计与验收标准见 [v0.3-design.md](./v0.3-design.md)、[v0.4-design.md](./v0.4-design.md)，流式协议见 [streaming-output.md](./streaming-output.md)。

## 必须保持的架构边界

```text
CLI
 ↓ AgentEvent
AgentRuntime
 ↓ ModelRequest / ModelResponse
ModelAdapter
 ↓ ModelEvent
PiAiModelAdapter
 ↓ pi-ai

AgentRuntime
 ↓ ToolCall
ToolRegistry
 ↓ PermissionRequest
PermissionManager
 ↓ allow
文件、命令与 Git 工具

CLI / Runtime
 ↓ messages snapshot
SessionManager
 ↓ schema validation + atomic rename
.pawcode/sessions/<id>.json

AgentRuntime
 ↓ estimated context budget
ContextCompactor
 ↓ ModelAdapter summary
历史摘要 + 最近完整轮次
```

1. `AgentRuntime` 不得直接依赖 `pi-ai` 类型或保存 `pi-ai Context`。
2. `PiAiModelAdapter` 负责所有 PawCode ↔ `pi-ai` 显式转换。
3. `providerData` 必须保留原始 `pi-ai AssistantMessage`，以重放 thinking signature、response ID 等供应商连续对话信息。
4. PawCode 工具参数仍使用 OpenAI 风格 JSON 字符串；`pi-ai` 对象参数只在 Adapter 中转换。
5. 副作用工具必须通过 `ToolRegistry` 和 `PermissionManager`，不能直接执行或绕过授权。
6. 写工具只接受工作区相对路径；命令不经过 Shell；未经用户明确要求不提交或推送。

## 协作与代码审查约定

- 后续新增或修改代码必须补充便于 review 的中文注释。
- 注释重点说明设计原因、协议或安全边界、非显然控制流，以及失败与兼容策略。
- 不给显而易见的赋值和语法逐行加注释，避免注释噪声掩盖关键逻辑。
- 修改实现行为时同步更新相关注释，不能保留与代码不一致的过时说明。
- 关键模块和公共接口应有职责说明；复杂分支应解释“为什么这样处理”。

关键目录：

```text
src/
├── cli.ts                         CLI、流式渲染、交互授权、usage 展示
├── config/config.ts               环境变量读取与校验
├── domain/
│   ├── message.ts                 PawCode 消息协议
│   ├── model.ts                   请求、响应、usage 和 cost
│   └── tool.ts                    ToolCall / ToolDefinition
├── models/
│   ├── model-adapter.ts           Runtime 依赖的稳定接口
│   ├── model-event.ts             供应商无关流事件
│   └── pi-ai-model-adapter.ts     唯一 pi-ai 翻译层
├── output/
│   └── json-renderer.ts            AgentEvent → NDJSON
├── permissions/
│   └── permission-manager.ts      allow / ask / deny 与会话规则
├── runtime/
│   ├── agent-event.ts             CLI/TUI 可复用事件
│   ├── agent-runtime.ts           多轮模型—工具编排与保存钩子
│   └── context-compactor.ts       Token 预算、安全切分与摘要
├── sessions/
│   ├── session-schema.ts          版本化磁盘 schema
│   ├── session-store.ts           项目隔离、校验与原子存储
│   └── session-manager.ts         活跃会话状态与累计 usage
└── tools/
    ├── tool-registry.ts           工具查找、权限入口、错误与截断
    ├── workspace-files.ts         路径、符号链接和文件安全
    ├── list-files-tool.ts         列目录
    ├── read-file-tool.ts          按行读文件
    ├── grep-tool.ts               搜索文本
    ├── write-file-tool.ts         创建或覆盖文件
    ├── apply-patch-tool.ts        精确文本替换
    ├── process-runner.ts           无 Shell 子进程封装
    ├── run-command-tool.ts        经授权执行命令
    └── git-diff-tool.ts           只读 Git 状态与 diff
```

## 关键实现细节

### 模型 Adapter 与消息连续性

`PiAiModelAdapter` 中的显式转换不是冗余代码，而是第三方协议隔离层：

- `toPiContext()`：提取 system prompt，并转换消息和工具。
- `toPiMessage()`：转换 user、assistant、tool result。
- `createFallbackAssistantMessage()`：兼容缺少原始供应商消息的旧数据和测试。
- `fromPiResponse()`：把 `pi-ai AssistantMessage` 投影为 PawCode `ModelResponse`。
- `fromPiUsage()`：显式转换 token 和成本字段。
- `toPiTool()`：把 PawCode OpenAI 风格工具定义转换为 `pi-ai Tool`。

正常在线响应会把完整 `pi-ai AssistantMessage` 放入 `providerData`。下一轮必须优先重放它，不能只根据简化文本重建，否则 Anthropic、OpenAI 等供应商可能丢失 thinking signature、response ID 或工具调用连续性。

### 流式执行生命周期

```text
pi-ai stream event
  ↓ PiAiModelAdapter
ModelEvent
  ↓ AgentRuntime
AgentEvent
  ↓ CLI
```

`ModelEvent` 包括 `text_delta`、`thinking_delta`、完整 `tool_call` 和 `completed`。重要约束：

- delta 只负责实时显示，不能在最终完成事件中重复打印。
- 工具只在参数完整且收到完整响应后执行。
- Runtime 先把 assistant 完整响应写入历史，再追加工具结果并进入下一轮。
- CLI 默认只显示“思考中...”，不直接展示完整 thinking。
- 外部 `AbortSignal` 与 Adapter 的 120 秒超时都会终止流，并在 `finally` 清理监听器和定时器。
- 一次用户请求可能包含多轮模型调用；Runtime 汇总所有轮次的 usage/cost，最终 stop reason 使用最后一轮结果。

### 权限模型

副作用调用统一走：

```text
ToolCall
  ↓ Tool.permissionRequest()
ToolRegistry
  ↓
PermissionManager.evaluate()/authorize()
  ↓ allow
Tool.execute()
```

`PermissionRequest` 包含 capability、tool、description、resource，可带 `forbiddenReason`。判断顺序必须保持：

1. `forbiddenReason` 硬拒绝，任何 allow 规则都不能覆盖。
2. 命中当前会话精确规则则允许。
3. 命中 `--allow-write` 或 `--allow-command <prefix>` 则允许。
4. 交互模式询问用户：允许一次、允许本会话同一操作或拒绝。
5. 非交互模式无法询问时默认拒绝。

“本会话允许”只保存在内存，并精确到 capability、tool、resource；退出后不持久化。不要把权限判断散落到 Runtime 或 CLI，`ToolRegistry` 是唯一执行入口。

### 文件编辑协议与安全

`write_file` 参数是工作区相对路径与完整内容，用于新建或完整覆盖，单次最多 1 MiB。

`apply_patch` 使用确定性文本替换：

```json
{
  "path": "src/example.ts",
  "old_text": "唯一旧文本",
  "new_text": "新文本",
  "replace_all": false
}
```

默认要求 `old_text` 只出现一次；零次或多次都拒绝，除非明确设置 `replace_all`。路径安全规则：

- 只接受相对路径，词法路径必须在工作区内。
- 已存在目标通过 `realpath` 再次检查，阻止符号链接逃逸。
- 新目标向上寻找最近的已存在父目录并检查真实路径。
- 禁止文件工具修改 `.git` 元数据。
- 拒绝目录目标、超大文件和超过写入限制的内容。

### 命令执行与 Git 检查

`run_command` 不接收一整段 Shell 字符串：

```json
{
  "command": "pnpm",
  "args": ["test"],
  "cwd": ".",
  "timeout_ms": 120000
}
```

实现使用 `spawn(command, args, { shell: false })`，模型参数不会被解释为管道、重定向或命令替换。`cwd` 必须经过工作区 `realpath` 校验。stdout/stderr 有内存上限，ToolRegistry 再做最终输出截断。

取消或超时时先发送 `SIGTERM`，1 秒后仍未退出则发送 `SIGKILL`。当前硬拒绝包括：

- `rm`、`sudo`、`shutdown`、`reboot`、`mkfs`、`dd`。
- `sh`、`bash`、`zsh` 等的 `-c`/`--command`。
- Git `reset`、`clean`、`restore`、`checkout`。

这些规则不是操作系统沙箱；允许 Node、Python 等解释器仍代表真实代码执行权限，所以默认拒绝与用户确认不可移除。

`git_diff` 是只读工具，并行读取 `git status --short` 与 `git diff --no-ext-diff`。系统提示要求 Agent 修改前读文件，修改后检查 diff，再按项目脚本运行格式、类型、测试和构建；未经明确要求不得提交或推送。

### v0.4 会话、压缩与 JSON

- 会话只存当前项目 `.pawcode/sessions`；记录并校验 workspace `realpath`，不同项目不能恢复。
- 会话保存 provider/model、PawCode messages、`providerData`、累计 usage 和运行状态，但绝不保存 API Key、环境变量或权限规则。
- 保存使用同目录临时文件后 `rename`，文件权限为 `0600`；损坏会话在列表中跳过，显式恢复时报告错误。
- 恢复默认沿用会话 provider/model；显式覆盖会警告兼容风险。只有 `api + provider + model` 完全一致时才重放 `providerData`，否则根据 PawCode `content + tool_calls` 重建消息；Git 分支变化只警告不拒绝。
- `ContextCompactor` 只在完整用户轮次边界切分，摘要失败则保留全部原消息继续运行。
- 摘要 usage 计入当前 run；压缩只处理下一请求的输入，不截断当前模型输出。
- `--json` stdout 每行都是 schema version 1 的 JSON 事件；错误对象显式转换，诊断和恢复警告写 stderr。
- JSON 模式不询问权限，只接受 `--allow-write` 和 `--allow-command` 预授权。

## 配置与运行

要求 Node.js `>=22.19.0`、pnpm 11。

```dotenv
MODEL_PROVIDER=供应商ID
MODEL_NAME=模型ID
MODEL_API_KEY=模型服务密钥
MAX_AGENT_TURNS=10
MAX_TOOL_OUTPUT_CHARS=20000
CONTEXT_COMPACT_THRESHOLD=0.8
CONTEXT_KEEP_RECENT_TOKENS=20000
```

`MODEL_BASE_URL` 仅用于 Ollama、vLLM、代理等自定义 OpenAI-compatible 服务。项目推荐统一使用 `MODEL_API_KEY`，但仍兼容 `pi-ai` 原生供应商环境变量。

```bash
pnpm dev
pnpm dev "解释当前项目架构"
pnpm dev --allow-write --allow-command "pnpm test" "修复问题并验证"
pnpm dev --continue
pnpm dev --resume
pnpm dev --resume auth-refactor --fork-session
pnpm dev --list-sessions
pnpm dev --json "检查项目"
```

交互模式会询问副作用权限。单次非交互模式必须通过 `--allow-write` 或可重复的 `--allow-command <prefix>` 显式授权。

## 验证基线

提交 `2053e6c` 完成时：

- Prettier 通过。
- TypeScript 类型检查通过。
- 7 个测试文件、22 个测试通过。
- 构建通过。
- `node dist/cli.js --version` 输出 `0.3.0`。
- `git diff --check` 通过。

标准验证：

```bash
pnpm format:check
pnpm check
pnpm test
pnpm build
```

本轮环境中的全局 `pnpm` 曾在启动阶段无输出卡住；当时直接调用以下项目二进制完成了等价验证：

```bash
./node_modules/.bin/prettier --check .
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
./node_modules/.bin/tsc
```

`tsx` 在受限沙箱中可能因无法创建 IPC 管道而报 `EPERM`，构建后的 `node dist/cli.js` 可正常运行。

当前 v0.4 工作区验证：

- Prettier、TypeScript 和构建通过。
- 12 个测试文件、38 个测试通过。
- `node dist/cli.js --version` 输出 `0.4.0`。
- 构建后 `--list-sessions --json` 输出可解析的空 sessions 事件。
- JSON 启动错误和缺少 prompt 错误均只输出合法 JSON 行。
- `git diff --check` 通过。

## 下一步

1. 使用真实模型创建并 `/rename` 会话，退出后分别用 `--continue`、`--resume` 选择器、`--resume <id|name>` 和 `/resume` 验证连续对话。
2. 验证 `--fork-session` 与 `/branch` 产生新 ID、保留原历史且不继承会话权限规则。
3. 将压缩阈值临时调低，人工确认 `context_compacted`、摘要质量、usage 累加和恢复后的压缩历史。
4. 验证 `--json` 长回答、工具调用、权限拒绝与显式 allow 的每行 JSON。
5. 人工验收通过后提交 v0.4，并按需要合并/推送。
6. v0.5：MCP Client、Hooks、自定义命令和子 Agent。

## 新对话起始提示

```text
请先阅读 docs/continuation-context.md，并按需阅读 docs/v0.4-design.md、
docs/v0.3-design.md 和 docs/streaming-output.md，然后检查 git status --short --branch。保持 PawCode
Domain 与 PiAiModelAdapter 的边界；所有副作用必须经过 ToolRegistry 和
PermissionManager。修改后运行格式、类型、测试和构建验证。
```
