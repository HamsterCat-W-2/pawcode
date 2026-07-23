import type { PawCodeConfigFile } from './config-schema.js'

const defaultConfig = {
  maxAgentTurns: 10,
  maxToolOutputChars: 20_000,
  contextCompactThreshold: 0.8,
  contextKeepRecentTokens: 20_000,
  modelMaxRetries: 2,
  modelRetryBaseDelayMs: 500,
  instructions: {
    includeAgentsMd: true,
    maxFileBytes: 128 * 1024,
  },
  display: {
    verboseTools: false,
  },
} as const

export interface PawCodeConfig {
  provider: string
  baseUrl?: string
  apiKey?: string
  model: string
  maxAgentTurns: number
  maxToolOutputChars: number
  contextCompactThreshold: number
  contextKeepRecentTokens: number
  modelMaxRetries: number
  modelRetryBaseDelayMs: number
  instructions: {
    files: string[]
    includeAgentsMd: boolean
    maxFileBytes: number
  }
  context: {
    appendSystemPrompt: string
    pathRules: Array<{
      pattern: string
      instructions?: string
      disabledTools: string[]
    }>
  }
  display: {
    verboseTools: boolean
  }
  mcp: {
    servers: Record<string, McpServerConfig>
  }
}

export interface ConfigDefaults {
  provider?: string
  model?: string
}

export interface McpServerConfig {
  /** 要启动的 MCP Server 可执行文件；由 spawn(command, args) 启动而不是交给 shell 解析。 */
  command: string
  /** 传给 command 的参数数组，保留参数边界，避免路径中的空格被错误拆分。 */
  args: string[]
  /** Server 的额外环境变量；只能来自用户级配置，避免凭据进入项目文件。 */
  env: Record<string, string>
  /** 是否在本次 Runtime 中启动和发现工具，false 可保留配置但暂时停用 Server。 */
  enabled: boolean
  /** initialize、tools/list、tools/call 的单次超时时间，防止 Server 无限阻塞 Agent。 */
  timeoutMs: number
}

/**
 * 把已经过来源校验的分层配置投影为 Runtime 使用的扁平配置。
 * 配置文件读取和敏感字段来源限制由 config-loader 负责，避免 CLI 和 Runtime 各自解释 JSON。
 */
export function loadConfig(raw: PawCodeConfigFile = {}, defaults: ConfigDefaults = {}): PawCodeConfig {
  const model = raw.model?.name ?? defaults.model
  if (!model) throw new Error('PawCode 配置无效：\nmodel.name: 未设置模型名称')

  const baseUrl = raw.model?.baseUrl?.replace(/\/$/, '')
  // Runtime 只消费这个规范化结果，不再关心字段来自用户级、项目级还是本地级文件。
  // 同时在这里补齐默认值，让业务代码不必反复判断 undefined。
  return {
    provider: raw.model?.provider ?? defaults.provider ?? (baseUrl ? 'custom' : 'openai'),
    ...(baseUrl ? { baseUrl } : {}),
    ...(raw.model?.apiKey ? { apiKey: raw.model.apiKey } : {}),
    model,
    maxAgentTurns: raw.maxAgentTurns ?? defaultConfig.maxAgentTurns,
    maxToolOutputChars: raw.maxToolOutputChars ?? defaultConfig.maxToolOutputChars,
    contextCompactThreshold: raw.contextCompactThreshold ?? defaultConfig.contextCompactThreshold,
    contextKeepRecentTokens: raw.contextKeepRecentTokens ?? defaultConfig.contextKeepRecentTokens,
    modelMaxRetries: raw.modelMaxRetries ?? defaultConfig.modelMaxRetries,
    modelRetryBaseDelayMs: raw.modelRetryBaseDelayMs ?? defaultConfig.modelRetryBaseDelayMs,
    instructions: {
      files: raw.instructions?.files ?? [],
      includeAgentsMd: raw.instructions?.includeAgentsMd ?? defaultConfig.instructions.includeAgentsMd,
      maxFileBytes: raw.instructions?.maxFileBytes ?? defaultConfig.instructions.maxFileBytes,
    },
    context: {
      appendSystemPrompt: raw.context?.appendSystemPrompt ?? '',
      pathRules: (raw.context?.pathRules ?? []).map((rule) => ({
        pattern: rule.pattern,
        ...(rule.instructions !== undefined ? { instructions: rule.instructions } : {}),
        disabledTools: rule.disabledTools ?? [],
      })),
    },
    display: {
      verboseTools: raw.display?.verboseTools ?? defaultConfig.display.verboseTools,
    },
    mcp: {
      servers: Object.fromEntries(
        Object.entries(raw.mcp?.servers ?? {}).map(([name, server]) => [
          name,
          {
            command: server.command,
            args: server.args ?? [],
            env: server.env ?? {},
            enabled: server.enabled ?? true,
            timeoutMs: server.timeoutMs ?? 30_000,
          },
        ]),
      ),
    },
  }
}
