# PawCode 后续任务上下文

本文件用于在新 Codex/Agent 对话中快速恢复状态。继续工作前先阅读本文件，再执行 `git status --short --branch`；实际工作区优先于文档。

## 当前状态

- 项目：Node.js、TypeScript、pnpm 编写的终端 AI 编程 Agent。
- 版本：v0.5 开发中。
- 项目路径：`pawcode`。
- 分支：`codex/v0.5-project-context-config`。
- 当前 HEAD 为 `cdbf57b`，分支 `codex/v0.5-project-context-config`；工作区状态以实际 `git status` 为准，不得擅自删除、覆盖或提交用户文件。
- v0.4 会话持久化、恢复、历史回放、退出提示、Esc/Ctrl+C 交互、上下文压缩、NDJSON、`--verbose` 工具明细和交互 Banner，以及 v0.4.1 错误恢复加固均已合并到 `main`。
- v0.4.1 错误恢复由提交 `19b0e6d` 完成，延续上下文文档由 `986fa20` 更新。
- 公共可取消列表选择器以及 `/resume`、`pawcode --resume` 的 CLI 回归测试由提交 `b9c3848` 完成并已合并。
- `.env` 已忽略，绝不能提交密钥。

v0.5 当前提交链：

```text
cdbf57b perf: optimize startup initialization
167b29d feat: add full project initialization
f4c0e31 feat: add project init command
ae10a15 feat: add dynamic project context reload
2c157aa feat: add layered project context configuration
```

关键历史：

```text
b9c3848 feat: add cancelable session selector
986fa20 docs: refresh v0.4.1 continuation context
19b0e6d feat: harden error recovery
102bf56 feat: improve session resume interaction
83ee87b feat: add interactive terminal banner
733c05e feat: add verbose tool output
58ac023 feat: add session persistence and resume
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
- 交互会话命令：`/init`、`/init --full`、`/new`、`/sessions`、`/resume [id|name]`、`/rename [name]`、`/branch [name]`。`/init` 快速扫描项目，`/init --full` 按目录分块摘要大型项目；两者都在权限确认后生成根目录 `PAWCODE.md`，已有文件不会覆盖。
- 分层 JSON 配置：用户级 `~/.pawcode/config.json`、项目级 `.pawcode/config.json`、本地级 `.pawcode/config.local.json`；API Key 只允许用户级配置，不再读取 `.env`。
- 项目上下文：支持用户级/项目级 `PAWCODE.md`、兼容 `AGENTS.md`、`--show-context [path]` 和路径规则。
- 动态上下文：工具声明目标路径，Runtime 在工具执行前刷新对应目录上下文；上下文变化只影响后续模型请求，不写入会话历史。
- `/init` 项目初始化：通过 `ProjectInitializer` 扫描项目、应用默认忽略规则和 `.gitignore`，使用候选评分发现元数据，过滤敏感文件，经权限确认后生成根目录 `PAWCODE.md`；`/init --full` 增加完整文件索引、目录分块和逐块摘要汇总。
- 启动性能：模型与工具按需加载，动态上下文提供器延迟到首次工具调用前创建，会话恢复扫描单次读取；`--verbose-startup` 可输出启动阶段耗时。
- 交互恢复会话时回放用户、助手和压缩摘要；`/exit` 或输入提示处 `Ctrl+C` 输出恢复命令；运行中的 `Esc`/`Ctrl+C` 取消请求，普通输入态 `Esc` 清空输入。公共可取消选择器让 `/resume` 中的 `Esc` 返回原会话输入提示，也让启动参数 `pawcode --resume` 中的 `Esc` 正常返回 shell。
- 根据模型 context window 在完整用户轮次边界压缩旧历史，保留工具调用/result 对。
- `--json` 严格 NDJSON；stdout 不混入人类装饰输出，非交互副作用默认拒绝。
- 人类可读输出默认隐藏成功工具明细；`--verbose` 才显示参数和结果长度，工具失败始终显示。
- 交互 TTY 显示零依赖 `PAWCODE` Banner；窄终端自动降级，`NO_COLOR` 关闭颜色，JSON 和重定向不显示。
- v0.4.1：零输出瞬时模型错误有限重试；一旦产生流事件即停止重试，避免重复输出和副作用。
- v0.4.1：用户取消保存部分回答并标记 `cancelled`；遗留 `running` 会话在确认 PID 失效后标记 `interrupted`。
- v0.4.1：会话、`write_file` 和 `apply_patch` 使用同目录临时文件、`fsync` 和原子替换。
- v0.4.1：权限确认响应 Esc/Ctrl+C 的 AbortSignal，stdout `EPIPE` 正常退出。

设计与验收标准见 [v0.3-design.md](./v0.3-design.md)、[v0.4-design.md](./v0.4-design.md)、[v0.4.1-error-recovery-design.md](./v0.4.1-error-recovery-design.md)、[v0.5-design.md](./v0.5-design.md)、[v0.5-dynamic-context-design.md](./v0.5-dynamic-context-design.md)、[v0.5-init-design.md](./v0.5-init-design.md) 和 [v0.5-init-full-design.md](./v0.5-init-full-design.md)，流式协议见 [streaming-output.md](./streaming-output.md)。

## 必须保持的架构边界

```text
CLI
 ↓ AgentEvent
AgentRuntime
 ↓ ModelRequest / ModelResponse
ModelAdapter
 ↓ zero-output transient retry
RetryingModelAdapter
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

AgentRuntime
 ↓ target path before tool execution
RuntimeContextProvider
 ↓ resolveContext + path rules
动态 system prompt + ToolRegistry 动态禁用工具

/init
 ↓ ProjectInitializer
WorkspaceFiles + ModelAdapter + PermissionManager
 ↓ atomic write
PAWCODE.md
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
├── cli.ts                         CLI、流式渲染、交互授权、Banner 和 usage 展示
├── config/config.ts               分层配置投影与校验
├── config/config-loader.ts        用户级、项目级、本地级 JSON 配置加载
├── context/
│   ├── context-resolver.ts        PAWCODE/AGENTS、路径规则和上下文来源解析
│   └── runtime-context-provider.ts 工具目标路径触发的动态上下文刷新
├── filesystem/atomic-file.ts      fsync、原子替换与死亡进程临时文件清理
├── input/
│   ├── cancelable-selector.ts     可复用列表渲染、序号重试、Esc 取消与监听器清理
│   └── readline-errors.ts         集中识别 readline Ctrl+C rejection
├── domain/
│   ├── message.ts                 PawCode 消息协议
│   ├── model.ts                   请求、响应、usage 和 cost
│   └── tool.ts                    ToolCall / ToolDefinition
├── models/
│   ├── model-adapter.ts           Runtime 依赖的稳定接口
│   ├── model-event.ts             供应商无关流事件
│   ├── pi-ai-model-adapter.ts     唯一 pi-ai 翻译层
│   └── retrying-model-adapter.ts  仅限零输出瞬时错误的安全重试
├── output/
│   ├── banner-renderer.ts          响应式、可关闭颜色的交互启动页
│   ├── json-renderer.ts            AgentEvent → NDJSON
│   ├── output-errors.ts            EPIPE 等输出错误分类
│   ├── session-display.ts          恢复历史回放与退出续聊提示
│   └── tool-event-renderer.ts      默认安静、verbose 可见的工具事件格式
├── permissions/
│   └── permission-manager.ts      allow / ask / deny 与会话规则
├── project/
│   └── project-initializer.ts     /init 扫描、候选评分、模型生成和安全写入
├── runtime/
│   ├── agent-event.ts             CLI/TUI 可复用事件
│   ├── agent-runtime.ts           多轮模型—工具编排与保存钩子
│   ├── context-compactor.ts       Token 预算、安全切分与摘要
│   └── interactive-signal-state.ts 输入态退出与运行态取消的 SIGINT 区分
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

### v0.4.1 错误恢复

- `RetryingModelAdapter` 默认重试 2 次，退避基数 500ms；只匹配 408、429、5xx、限流、过载和明确网络错误。
- 已经向 Runtime 产生任意事件后禁止重试；认证、参数、上下文超限和用户取消禁止重试。
- Runtime 在模型流失败或取消时保存已展示的部分 assistant 文本；取消产生 `cancelled` 事件和会话状态。
- `running` 会话保存活跃 PID；启动扫描只把 PID 不存在的记录改为 `interrupted`，不修改 `updatedAt`。
- 原子文件写入使用目标同目录临时文件、文件 `fsync` 和 `rename`；已有工作区文件保留权限位。
- 临时文件包含 PID，只清理死亡进程遗留项，不能影响并发运行的 PawCode。
- 权限确认接收 run AbortSignal；命令取消/超时会警告副作用可能已经部分发生。
- 命令副作用不自动回滚，跨供应商故障转移也不在 v0.4.1 范围内。

## 配置与运行

要求 Node.js `>=22.19.0`、pnpm 11。

v0.5 不再读取 `.env` 或模型环境变量。全局模型配置位于 `~/.pawcode/config.json`，项目和本地非敏感覆盖分别位于 `.pawcode/config.json` 与 `.pawcode/config.local.json`：

```json
{
  "model": {
    "provider": "openai",
    "name": "模型ID",
    "apiKey": "模型服务密钥"
  },
  "modelMaxRetries": 2,
  "modelRetryBaseDelayMs": 500,
  "maxAgentTurns": 10,
  "maxToolOutputChars": 20000,
  "contextCompactThreshold": 0.8,
  "contextKeepRecentTokens": 20000
}
```

`model.apiKey` 只允许出现在用户级配置中；用户级目录/文件权限要求为 `0700`/`0600`。项目级配置可以声明 `provider`、`name` 或 `baseUrl`，但不能保存凭据。使用 `pawcode --show-config` 和 `pawcode --show-context [path]` 检查来源。

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

进入交互模式后输入 `/init` 或 `/init --full` 可生成项目根目录 `PAWCODE.md`；已有文件默认不覆盖。两个命令当前仅支持交互模式，不支持 JSON 或单次 prompt 模式。

交互模式会询问副作用权限。单次非交互模式必须通过 `--allow-write` 或可重复的 `--allow-command <prefix>` 显式授权。

## 当前验证基线

`cdbf57b` 完成后：

- Prettier、TypeScript 类型检查和构建通过。
- 22 个测试文件、85 个测试通过。
- 覆盖分层配置、静态/动态上下文、路径规则、快速/完整 `/init` 扫描、分块摘要、`.gitignore`、敏感文件过滤和已有 `PAWCODE.md` 保护。
- `git diff --check` 通过。
- 构建后的 CLI 已验证 `--show-config --json` 和 `--show-context [path]` 输出合法 NDJSON。

标准验证：

```bash
pnpm format:check
pnpm check
pnpm test
pnpm build
```

受限沙箱中的全局 `pnpm` 可能在启动阶段无输出卡住；可在获得执行权限后运行标准验证，或直接调用以下项目二进制完成等价验证：

```bash
./node_modules/.bin/prettier --check .
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
./node_modules/.bin/tsc
```

`tsx` 在受限沙箱中可能因无法创建 IPC 管道而报 `EPERM`，构建后的 `node dist/cli.js` 可正常运行。

## 下一步

v0.5 的配置、上下文和 `/init` 主流程已经完成。后续继续沿用现有配置、上下文刷新、结构化事件和权限 seam，避免 MCP、Hooks、Skills 和子 Agent 分别建立互不兼容的机制。

### v0.5.x：项目上下文与分层配置（当前阶段）

已完成：

1. 用户级、项目级和本地级 JSON 配置及 schema 校验。
2. `PAWCODE.md`、`AGENTS.md`、路径规则和 `--show-context [path]`。
3. 工具目标路径触发的动态上下文刷新，且不污染 Session 历史。
4. `/init` 项目上下文生成、敏感文件保护、`.gitignore` 和通用候选评分扫描。

后续补强：

1. 为快速和完整 `/init` 增加统一的可见诊断，列出截断、跳过和未读取的文件及原因（技术方案见 `docs/v0.5-init-diagnostics-design.md`）。
2. 完善 `.gitignore` 复杂语义和符号链接场景的测试；必要时复用 Git 的路径匹配能力。
3. 支持已有 `PAWCODE.md` 的安全更新模式，只修改 PawCode 管理区域，不覆盖用户手写规则。
4. 增加 `/memory` 或上下文来源检查界面，方便用户查看当前生效的指令文件。

### v0.5.1：MCP Client

1. 第一阶段支持 stdio 和 Streamable HTTP，并统一映射到现有 `Tool` 接口。
2. 支持用户级和项目级 MCP 配置、工具发现、连接超时、调用超时及输出截断。
3. MCP 副作用工具必须继续经过 `ToolRegistry` 和 `PermissionManager`，不能因来自外部服务器而绕过授权。
4. 基础调用稳定后，再增加 OAuth、resources、prompts 和更细的服务器信任策略。

### v0.5.2：公共 Hooks 事件总线

1. 先定义稳定事件和输入输出协议，再实现命令型 Hook。
2. 首批覆盖 `SessionStart`、`SessionStop`、`PreToolUse`、`PostToolUse`、`PreCompact` 和 `PostCompact`。
3. Hook 失败、超时、取消及是否允许阻断操作必须有明确语义；人类输出与 NDJSON 继续共用结构化事件。

### v0.5.3：Skills 与自定义命令

1. 使用 Markdown 和 frontmatter 描述命令、用途、允许工具及上下文策略。
2. 支持项目级和用户级发现，并采用按需加载，避免把所有 Skill 内容常驻上下文。
3. Skill 调用仍受现有权限和工作区边界约束；脚本和辅助文件需要可追踪的来源信息。

### v0.6：子 Agent 与 worktree 隔离

1. 子 Agent 使用独立上下文，并可限制模型、工具集合、最大轮数、Token 和并发数量。
2. 先实现前台委派、取消和结果汇总，再增加后台任务。
3. 对会修改代码的并行 Agent 增加 Git worktree 隔离和清理策略，防止多个 Agent 互相覆盖工作区。

### v0.7：Checkpoint、Rewind 与更强沙箱

1. 文件修改前建立可恢复 checkpoint，区分恢复代码、恢复会话和同时恢复两者。
2. 明确命令产生的外部副作用不能依靠文件 checkpoint 自动撤销。
3. 在现有应用层权限之外评估文件、进程和网络的操作系统级沙箱。

IDE 插件、插件市场、CI 集成和远程会话属于更后期的平台化工作，应在上述 Runtime 扩展协议稳定后推进。

## 新对话起始提示

```text
请先阅读 docs/continuation-context.md，并按需阅读 docs/v0.4.1-error-recovery-design.md、
docs/v0.4-design.md、docs/v0.3-design.md 和 docs/streaming-output.md，然后检查 git status --short --branch。保持 PawCode
Domain 与 PiAiModelAdapter 的边界；所有副作用必须经过 ToolRegistry 和
PermissionManager。新增或修改代码必须添加便于 review 的中文注释；修改后运行格式、
类型、测试和构建验证。当前开发基线在 `codex/v0.5-project-context-config`，下一步优先补强大型项目的 `/init` 分块分析、上下文诊断和已有文件更新策略。
```
