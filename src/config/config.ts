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
}

export interface ConfigDefaults {
  provider?: string
  model?: string
}

/**
 * 把已经过来源校验的分层配置投影为 Runtime 使用的扁平配置。
 * 配置文件读取和敏感字段来源限制由 config-loader 负责，避免 CLI 和 Runtime 各自解释 JSON。
 */
export function loadConfig(raw: PawCodeConfigFile = {}, defaults: ConfigDefaults = {}): PawCodeConfig {
  const model = raw.model?.name ?? defaults.model
  if (!model) throw new Error('PawCode 配置无效：\nmodel.name: 未设置模型名称')

  const baseUrl = raw.model?.baseUrl?.replace(/\/$/, '')
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
  }
}
