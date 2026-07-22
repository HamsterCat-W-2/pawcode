# PawCode

PawCode 是一个使用 Node.js、TypeScript 和 pnpm 构建的终端 AI 编程 Agent。当前 v0.5.0 可以在统一权限控制下读写项目、执行命令、持久化项目级会话和跨会话记忆、加载分层项目上下文、生成与安全更新 `PAWCODE.md`、压缩长上下文并输出 NDJSON，通过 `pi-ai` 兼容多个模型供应商，同时提供模型重试、原子写入和异常中断恢复。

## 当前能力

- 交互式终端对话。
- 单次命令行提问。
- 通过 `pi-ai` 支持 OpenAI、Anthropic、Google、OpenRouter、小米 MiMo 等供应商。
- 支持自定义 OpenAI-compatible 服务，例如 Ollama、vLLM 和 LM Studio。
- 统一不同供应商的 Tool Calling 消息格式。
- 模型文本流式输出，并提供 thinking 状态提示。
- `list_files`：递归查看项目文件。
- `read_file`：按行读取文本文件。
- `grep`：搜索代码并返回文件和行号。
- `write_file`：创建或完整覆盖工作区文件。
- `apply_patch`：通过精确文本替换修改文件。
- `run_command`：经授权后以无 Shell 方式执行程序和参数。
- `git_diff`：查看工作区状态和未提交差异。
- 工作区路径隔离和符号链接检查。
- 写入和命令的 allow、ask、deny 权限决策。
- 最大 Agent 轮数和工具输出限制。
- `/init`、`/clear`、`/status`、`/exit` 命令。
- 项目内 `.pawcode/sessions` 会话保存、列表与恢复。
- 长上下文按完整用户轮次压缩，不拆分工具调用与结果。
- 严格 NDJSON 输出模式。
- 通过事件流分离 Agent Runtime 与终端展示。

## 环境要求

- Node.js 至少为 22.19.0（`pi-ai` 的运行时要求）。
- pnpm 11。

## 安装

```bash
pnpm install
```

## 配置

PawCode 使用分层 JSON 配置，不再读取 `.env` 或 `MODEL_*` 环境变量。用户级配置位于 `~/.pawcode/config.json`，适合保存个人默认模型和 API Key：

```json
{
  "model": {
    "provider": "openai",
    "name": "gpt-4.1-mini",
    "apiKey": "你的APIKey"
  },
  "maxAgentTurns": 10,
  "maxToolOutputChars": 20000,
  "contextCompactThreshold": 0.8,
  "contextKeepRecentTokens": 20000,
  "modelMaxRetries": 2,
  "modelRetryBaseDelayMs": 500
}
```

配置目录权限为 `0700`，配置文件权限为 `0600`。项目级和本地级配置分别位于 `.pawcode/config.json` 和 `.pawcode/config.local.json`，可以覆盖非敏感设置，但不能保存 API Key。

自定义 OpenAI-compatible 服务示例：

```json
{
  "model": {
    "baseUrl": "http://localhost:11434/v1",
    "name": "qwen3-coder"
  }
}
```

未设置 `provider` 且存在 `baseUrl` 时自动使用 `custom` Provider。使用 `--provider`、`--model` 或其他 CLI 参数可以临时覆盖配置文件。

查看当前生效配置和上下文来源：

```bash
pawcode --show-config
pawcode --show-config --json
pawcode --show-context
pawcode --show-context src/tools/example.ts
```

## 使用

进入交互模式：

```bash
pnpm dev
```

直接提问：

```bash
pnpm dev "查看当前项目并解释目录结构"
```

模型生成时会逐段显示文本；生成过程中按 `Ctrl+C` 可以取消当前请求。

交互模式会根据终端宽度显示 `PAWCODE` 启动 Banner；窄终端自动使用紧凑标题。Banner 只写入 TTY，设置 `NO_COLOR` 可关闭颜色，不会影响单次 prompt、管道或 JSON 输出。

交互模式支持 `/init` 和 `/init --full`：前者快速分析项目，后者按目录分块摘要大型项目并生成根目录 `PAWCODE.md`；已有文件不会被覆盖，生成文件写入前仍会经过权限确认。交互模式会在写文件或运行命令前询问。单次非交互模式默认拒绝副作用操作，可显式授权：

```bash
pnpm dev --allow-write --allow-command "pnpm test" "修复问题并运行测试"
```

`--allow-command` 可重复设置，按规范化后的命令前缀匹配。`rm`、`sudo`、Shell `-c` 和破坏性 Git 子命令始终拒绝。

普通交互默认隐藏成功工具的调用参数和结果字符数，工具失败仍会显示。调试时可恢复完整明细：

```bash
pnpm dev --verbose
```

指定模型和最大轮数：

```bash
pnpm dev --provider xiaomi-token-plan-cn --model mimo-v2.5 --max-turns 6 "解释 Agent Runtime"
```

会话默认保存在当前项目的 `.pawcode/sessions`。恢复最近或指定会话：

```bash
pnpm dev --continue
pnpm dev --resume
pnpm dev --resume <session-id-or-name>
pnpm dev --resume auth-refactor --fork-session
pnpm dev --list-sessions
```

`--continue/-c` 恢复最近会话；`--resume/-r` 无参数打开编号选择器，有参数时按 ID 或 `/rename` 设置的名称恢复；`--fork-session` 复制历史并生成新会话 ID。交互模式还提供 `/init`、`/new`、`/sessions`、`/resume [id|name]`、`/rename [name]` 和 `/branch [name]`。不同工作区的会话不能互相恢复；切换 Git 分支时会显示警告。

交互恢复会话时会回放用户、助手和压缩摘要，不展示内部 system prompt、工具结果或供应商私有数据。在输入提示处执行 `/exit` 或按 `Ctrl+C` 后，都会显示可复制的 `pawcode --resume <name-or-id>` 和 `pawcode --continue` 命令；模型生成期间按 `Esc` 或 `Ctrl+C` 只取消当前请求，普通输入态按 `Esc` 清空当前输入。`/resume` 会话选择器中按 `Esc` 会取消选择并返回输入提示；启动时执行 `pawcode --resume` 打开选择器后按 `Esc`，则正常返回 shell。PawCode 暂不实现 Claude Code 的双击 `Esc` rewind。

### 错误恢复

- 408、429、5xx 和明确网络瞬时错误在尚未输出任何流事件时自动重试，默认最多 2 次。
- 已经产生文本或工具事件后不自动重试，避免重复输出或副作用。
- `write_file`、`apply_patch` 和会话保存使用临时文件、`fsync` 与原子替换。
- 用户取消保存已产生的部分回答并记录为 `cancelled`；异常退出遗留的 `running` 会话在下次启动时标记为 `interrupted`。
- 命令取消或超时不能回滚已经产生的副作用，PawCode 会提示使用 `git_diff` 检查。

机器调用使用 NDJSON：

```bash
pnpm dev --json "检查当前项目"
pnpm dev --list-sessions --json
```

JSON 模式 stdout 每行都是可解析事件，不输出颜色、Emoji 或权限询问。副作用默认拒绝，需要通过 `--allow-write` 或 `--allow-command` 预授权。
`--verbose` 只控制人类可读输出，不改变 JSON 事件内容。

## 检查、测试与构建

```bash
pnpm format
pnpm format:check
pnpm check
pnpm test
pnpm build
pnpm start
```

构建后可以链接为全局命令：

```bash
pnpm link --global
paw --help
pawcode --help
```

## 架构

```text
src/
├── cli.ts
├── config/
│   └── config.ts
├── domain/
│   ├── message.ts
│   ├── model.ts
│   └── tool.ts
├── models/
│   ├── model-adapter.ts
│   ├── model-event.ts
│   └── pi-ai-model-adapter.ts
├── input/
│   ├── cancelable-selector.ts
│   └── readline-errors.ts
├── output/
│   └── json-renderer.ts
├── permissions/
│   └── permission-manager.ts
├── runtime/
│   ├── agent-event.ts
│   ├── agent-runtime.ts
│   └── context-compactor.ts
├── sessions/
│   ├── session-schema.ts
│   ├── session-store.ts
│   └── session-manager.ts
└── tools/
    ├── tool.ts
    ├── tool-registry.ts
    ├── workspace-files.ts
    ├── list-files-tool.ts
    ├── read-file-tool.ts
    ├── grep-tool.ts
    ├── write-file-tool.ts
    ├── apply-patch-tool.ts
    ├── process-runner.ts
    ├── run-command-tool.ts
    └── git-diff-tool.ts
```

关键 seam：

- `ModelAdapter` 是 PawCode 自己的稳定模型接口。
- `ModelEvent` 将第三方流事件隔离为 PawCode 的文本、thinking、工具和完成事件。
- `PiAiModelAdapter` 将 PawCode 消息、工具和响应转换为 `pi-ai` 类型。
- Runtime 会保存 Adapter 返回的供应商原始消息，确保多轮工具调用不丢失 thinking signature。
- `Tool` 统一内置工具和未来 MCP 工具。
- `PermissionManager` 是所有副作用工具的统一 allow、ask、deny 决策点。
- `AgentRuntime` 只负责编排消息、模型和工具。
- `AgentEvent` 让普通 CLI、TUI 和 JSON 输出复用同一运行时。
- `SessionStore` 只管理当前项目、版本化 schema 校验和原子文件写入。
- `ContextCompactor` 按完整用户轮次切分，并通过 `ModelAdapter` 摘要旧历史。

流式输出的事件约束和验收标准见 [docs/streaming-output.md](docs/streaming-output.md)。

## 规划

v0.5：

- 项目上下文文件与 `AGENTS.md` 兼容读取。
- 用户级、项目级和本地级 JSON 配置。
- 配置来源诊断、路径规则和上下文按需注入。
- 持久化用户级/项目级记忆，以及安全生成和更新 `PAWCODE.md`。
- MCP Client、Hooks、Skills 和子 Agent 将在 v0.5.1 及后续版本实现。

## 安全说明

`pi-ai` 只负责模型通信，不负责 PawCode 的工具权限。PawCode 默认拒绝非交互写入和命令操作；交互授权只在当前进程内有效。文件工具会检查工作区边界和符号链接，命令工具不经过 Shell，但这些措施不等同于操作系统沙箱。仍应避免在包含不必要敏感数据的目录中启动，因为模型读取到的工具结果会发送到配置的模型服务。

详细设计见 [v0.3](docs/v0.3-design.md)、[v0.4](docs/v0.4-design.md)、[v0.4.1 错误恢复](docs/v0.4.1-error-recovery-design.md) 和 [v0.5 项目上下文与分层配置](docs/v0.5-design.md) 技术文档。
