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
  })
  .strict()

export type PawCodeConfigFile = z.infer<typeof pawCodeConfigFileSchema>
