import { z } from 'zod'

const environmentSchema = z.object({
  MODEL_PROVIDER: z.string().min(1).optional(),
  MODEL_BASE_URL: z.url().optional(),
  MODEL_API_KEY: z.string().min(1).optional(),
  MODEL_NAME: z.string().min(1).optional(),
  MAX_AGENT_TURNS: z.coerce.number().int().positive().default(10),
  MAX_TOOL_OUTPUT_CHARS: z.coerce.number().int().positive().default(20_000),
  CONTEXT_COMPACT_THRESHOLD: z.coerce.number().positive().max(1).default(0.8),
  CONTEXT_KEEP_RECENT_TOKENS: z.coerce.number().int().positive().default(20_000),
})

export interface PawCodeConfig {
  provider: string
  baseUrl?: string
  apiKey?: string
  model: string
  maxAgentTurns: number
  maxToolOutputChars: number
  contextCompactThreshold: number
  contextKeepRecentTokens: number
}

export interface ConfigDefaults {
  provider?: string
  model?: string
}

// 配置校验集中在这里，其他模块只接收已经合法的强类型配置。
export function loadConfig(environment: NodeJS.ProcessEnv = process.env, defaults: ConfigDefaults = {}): PawCodeConfig {
  const result = environmentSchema.safeParse(environment)

  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')
    throw new Error(`PawCode 配置无效：\n${details}`)
  }

  const model = result.data.MODEL_NAME ?? defaults.model
  if (!model) throw new Error('PawCode 配置无效：\nMODEL_NAME: 未设置模型名称')

  return {
    // 配置了旧版 MODEL_BASE_URL 时使用自定义 OpenAI-compatible Provider；
    // 否则默认使用 pi-ai 内置的 OpenAI Provider。
    provider: result.data.MODEL_PROVIDER ?? defaults.provider ?? (result.data.MODEL_BASE_URL ? 'custom' : 'openai'),
    ...(result.data.MODEL_BASE_URL ? { baseUrl: result.data.MODEL_BASE_URL.replace(/\/$/, '') } : {}),
    ...(result.data.MODEL_API_KEY ? { apiKey: result.data.MODEL_API_KEY } : {}),
    model,
    maxAgentTurns: result.data.MAX_AGENT_TURNS,
    maxToolOutputChars: result.data.MAX_TOOL_OUTPUT_CHARS,
    contextCompactThreshold: result.data.CONTEXT_COMPACT_THRESHOLD,
    contextKeepRecentTokens: result.data.CONTEXT_KEEP_RECENT_TOKENS,
  }
}
