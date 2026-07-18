# PawCode

PawCode 是一个使用 Node.js、TypeScript 和 pnpm 构建的终端 AI 编程 Agent。当前 v0.4 可以在统一权限控制下读写项目、执行命令、持久化项目级会话、压缩长上下文并输出 NDJSON，通过 `pi-ai` 兼容多个模型供应商，同时保留自己的 Agent Runtime、工具系统和安全边界。

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
- `/clear`、`/status`、`/exit` 命令。
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

```bash
cp .env.example .env
```

编辑 `.env`。PawCode 对所有供应商使用相同字段，通过字段值选择 Provider 和模型：

```dotenv
MODEL_PROVIDER=供应商ID
MODEL_NAME=模型ID
MODEL_API_KEY=模型服务密钥
```

OpenAI：

```dotenv
MODEL_PROVIDER=openai
MODEL_NAME=gpt-4.1-mini
MODEL_API_KEY=你的APIKey
MAX_AGENT_TURNS=10
MAX_TOOL_OUTPUT_CHARS=20000
CONTEXT_COMPACT_THRESHOLD=0.8
CONTEXT_KEEP_RECENT_TOKENS=20000
```

小米 MiMo Token Plan（中国区）：

```dotenv
MODEL_PROVIDER=xiaomi-token-plan-cn
MODEL_NAME=mimo-v2.5
MODEL_API_KEY=你的APIKey
```

Anthropic：

```dotenv
MODEL_PROVIDER=anthropic
MODEL_NAME=claude-sonnet-4-5
MODEL_API_KEY=你的APIKey
```

如果使用 Ollama、代理或其他自定义 OpenAI-compatible 地址，可以沿用旧配置：

```dotenv
MODEL_BASE_URL=http://localhost:11434/v1
MODEL_API_KEY=可选
MODEL_NAME=qwen3-coder
```

存在 `MODEL_BASE_URL` 且未设置 `MODEL_PROVIDER` 时，PawCode 会自动使用名为 `custom` 的 Provider。使用内置 Provider 时不需要填写 `MODEL_BASE_URL`。

`pi-ai` 原生的 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`XIAOMI_TOKEN_PLAN_CN_API_KEY` 等变量仍然可以使用，但它们是可选的底层兼容方式；PawCode 推荐统一使用 `MODEL_API_KEY`。

启动脚本通过 `node -r dotenv/config` 在执行业务代码前加载 `.env`。

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

交互模式会在写文件或运行命令前询问。单次非交互模式默认拒绝副作用操作，可显式授权：

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

`--continue/-c` 恢复最近会话；`--resume/-r` 无参数打开编号选择器，有参数时按 ID 或 `/rename` 设置的名称恢复；`--fork-session` 复制历史并生成新会话 ID。交互模式还提供 `/new`、`/sessions`、`/resume [id|name]`、`/rename [name]` 和 `/branch [name]`。不同工作区的会话不能互相恢复；切换 Git 分支时会显示警告。

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

- MCP Client。
- Hooks 和自定义命令。
- 子 Agent。

## 安全说明

`pi-ai` 只负责模型通信，不负责 PawCode 的工具权限。PawCode 默认拒绝非交互写入和命令操作；交互授权只在当前进程内有效。文件工具会检查工作区边界和符号链接，命令工具不经过 Shell，但这些措施不等同于操作系统沙箱。仍应避免在包含不必要敏感数据的目录中启动，因为模型读取到的工具结果会发送到配置的模型服务。

详细设计见 [v0.3](docs/v0.3-design.md) 和 [v0.4](docs/v0.4-design.md) 技术文档。
