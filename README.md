# PawCode

PawCode 是一个使用 Node.js、TypeScript 和 pnpm 构建的终端 AI 编程 Agent。当前 v0.1 是只读版本，目标是先建立可测试、可扩展的 Agent Runtime，再逐步加入代码修改、权限、会话和 MCP。

## 当前能力

- 交互式终端对话。
- 单次命令行提问。
- OpenAI-compatible Chat Completions Tool Calling。
- `list_files`：递归查看项目文件。
- `read_file`：按行读取文本文件。
- `grep`：搜索代码并返回文件和行号。
- 工作区路径隔离和符号链接检查。
- 最大 Agent 轮数和工具输出限制。
- `/clear`、`/status`、`/exit` 命令。
- 通过事件流分离 Agent Runtime 与终端展示。

## 环境要求

- Node.js 22 或更高版本。
- pnpm 11。
- 支持 OpenAI-compatible Tool Calling 的模型服务。

## 安装

```bash
pnpm install
```

## 配置

```bash
cp .env.example .env
```

编辑 `.env`：

```dotenv
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_API_KEY=你的APIKey
MODEL_NAME=gpt-4.1-mini
MAX_AGENT_TURNS=10
MAX_TOOL_OUTPUT_CHARS=20000
```

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

指定模型和最大轮数：

```bash
pnpm dev --model mimo-v2.5 --max-turns 6 "解释 Agent Runtime"
```

## 检查、测试与构建

```bash
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
│   └── types.ts
├── models/
│   ├── model-adapter.ts
│   └── openai-compatible-adapter.ts
├── runtime/
│   ├── agent-event.ts
│   └── agent-runtime.ts
└── tools/
    ├── tool.ts
    ├── tool-registry.ts
    ├── workspace-files.ts
    ├── list-files-tool.ts
    ├── read-file-tool.ts
    └── grep-tool.ts
```

关键 seam：

- `ModelAdapter` 隔离模型供应商差异。
- `Tool` 统一内置工具和未来 MCP 工具。
- `AgentRuntime` 只负责编排消息、模型和工具。
- `AgentEvent` 让普通 CLI、TUI 和 JSON 输出复用同一运行时。

## 规划

v0.2：

- `write_file` 和补丁编辑工具。
- 命令执行工具。
- 权限确认和允许规则。
- Git diff 与测试工作流。

v0.3：

- 会话持久化与恢复。
- 上下文压缩。
- 流式模型文本。
- JSON 输出模式。

v0.4：

- MCP Client。
- Hooks 和自定义命令。
- 子 Agent。

## 安全说明

v0.1 仅包含只读文件工具，不会修改文件或执行命令。运行时仍应避免在包含不必要敏感数据的目录中启动，因为模型读取到的工具结果会发送到配置的模型服务。
# pawcode
