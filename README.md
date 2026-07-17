# PawCode

PawCode 是一个使用 Node.js、TypeScript 和 pnpm 构建的终端 AI 编程 Agent。当前 v0.2 是只读版本，通过 `pi-ai` 兼容多个模型供应商，同时保留自己的 Agent Runtime、工具系统和安全边界。

## 当前能力

- 交互式终端对话。
- 单次命令行提问。
- 通过 `pi-ai` 支持 OpenAI、Anthropic、Google、OpenRouter、小米 MiMo 等供应商。
- 支持自定义 OpenAI-compatible 服务，例如 Ollama、vLLM 和 LM Studio。
- 统一不同供应商的 Tool Calling 消息格式。
- `list_files`：递归查看项目文件。
- `read_file`：按行读取文本文件。
- `grep`：搜索代码并返回文件和行号。
- 工作区路径隔离和符号链接检查。
- 最大 Agent 轮数和工具输出限制。
- `/clear`、`/status`、`/exit` 命令。
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

指定模型和最大轮数：

```bash
pnpm dev --provider xiaomi-token-plan-cn --model mimo-v2.5 --max-turns 6 "解释 Agent Runtime"
```

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
│   └── pi-ai-model-adapter.ts
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

- `ModelAdapter` 是 PawCode 自己的稳定模型接口。
- `PiAiModelAdapter` 将 PawCode 消息、工具和响应转换为 `pi-ai` 类型。
- Runtime 会保存 Adapter 返回的供应商原始消息，确保多轮工具调用不丢失 thinking signature。
- `Tool` 统一内置工具和未来 MCP 工具。
- `AgentRuntime` 只负责编排消息、模型和工具。
- `AgentEvent` 让普通 CLI、TUI 和 JSON 输出复用同一运行时。

## 规划

v0.3：

- `write_file` 和补丁编辑工具。
- 命令执行工具。
- 权限确认和允许规则。
- Git diff 与测试工作流。
- 流式模型文本、thinking 和 Token 用量事件。

v0.4：

- 会话持久化与恢复。
- 上下文压缩。
- JSON 输出模式。

v0.5：

- MCP Client。
- Hooks 和自定义命令。
- 子 Agent。

## 安全说明

v0.2 仅包含只读文件工具，不会修改文件或执行命令。`pi-ai` 只负责模型通信，不负责 PawCode 的工具权限。运行时仍应避免在包含不必要敏感数据的目录中启动，因为模型读取到的工具结果会发送到配置的模型服务。
