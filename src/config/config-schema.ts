import { z } from 'zod'

const modelConfigSchema = z
  .object({
    provider: z.string().min(1).optional(),
    baseUrl: z.url().optional(),
    name: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
  })
  .strict()

const pathRuleSchema = z
  .object({
    pattern: z.string().min(1),
    instructions: z.string().optional(),
    disabledTools: z.array(z.string().min(1)).optional(),
  })
  .strict()

const mcpServerSchema = z
  .object({
    // command 与 args 分开校验并传给 spawn，明确禁止把整段字符串当 shell 命令执行。
    command: z.string().min(1),
    // 限制参数数量，避免配置错误生成过大的启动参数列表。
    args: z.array(z.string()).max(100).optional(),
    // 值必须是字符串；“只能用户级配置”由 config-loader 做来源校验。
    env: z.record(z.string(), z.string()).optional(),
    // 默认启用，false 用于保留配置但跳过启动。
    enabled: z.boolean().optional(),
    // 整数且有上限，防止 Server 无限占用 Runtime。
    timeoutMs: z.number().int().positive().max(600_000).optional(),
  })
  .strict()

export const pawCodeConfigFileSchema = z
  .object({
    model: modelConfigSchema.optional(),
    maxAgentTurns: z.number().int().positive().optional(),
    maxToolOutputChars: z.number().int().positive().optional(),
    contextCompactThreshold: z.number().positive().max(1).optional(),
    contextKeepRecentTokens: z.number().int().positive().optional(),
    modelMaxRetries: z.number().int().min(0).max(10).optional(),
    modelRetryBaseDelayMs: z.number().int().positive().max(60_000).optional(),
    instructions: z
      .object({
        files: z.array(z.string().min(1)).optional(),
        includeAgentsMd: z.boolean().optional(),
        maxFileBytes: z.number().int().positive().max(1_048_576).optional(),
      })
      .strict()
      .optional(),
    context: z
      .object({
        appendSystemPrompt: z.string().optional(),
        pathRules: z.array(pathRuleSchema).optional(),
      })
      .strict()
      .optional(),
    display: z
      .object({
        verboseTools: z.boolean().optional(),
      })
      .strict()
      .optional(),
    mcp: z
      .object({
        // 使用对象便于按 Server 名称做三层配置的覆盖和合并。
        servers: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), mcpServerSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export type PawCodeConfigFile = z.infer<typeof pawCodeConfigFileSchema>
