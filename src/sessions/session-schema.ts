import { z } from 'zod'
import type { Message } from '../domain/message.js'
import type { ModelUsage } from '../domain/model.js'

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
})

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().nullable(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
  providerData: z.unknown().optional(),
})

const modelCostSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  total: z.number().nonnegative(),
})

const modelUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cost: modelCostSchema.optional(),
})

/**
 * 写入磁盘的版本化会话协议。
 *
 * 这里只保存恢复对话所需的数据；API Key、环境变量和内存中的权限规则不得进入该结构。
 */
export interface SessionRecord {
  schemaVersion: 1
  id: string
  /** 从首条用户消息生成的展示标题。 */
  title: string
  /** 用户显式设置、可供 --resume 使用的项目内唯一名称。 */
  name?: string
  /** fork 来源，仅表达会话谱系，不共享后续状态。 */
  parentSessionId?: string
  createdAt: string
  updatedAt: string
  /** 项目 realpath；恢复时用于阻止不同项目之间串会话。 */
  workspace: string
  gitBranch?: string
  /** 恢复时的默认供应商和模型；切换模型后的 providerData 兼容性由 Adapter 判断。 */
  provider: string
  model: string
  messages: Message[]
  cumulativeUsage?: ModelUsage
  lastRunStatus: 'idle' | 'running' | 'completed' | 'failed'
  compactionCount: number
}

// 磁盘内容属于不可信输入；读取后必须先通过此 schema，才能进入 SessionManager。
export const sessionRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  title: z.string().min(1).max(200),
  name: z.string().min(1).max(100).optional(),
  parentSessionId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,100}$/)
    .optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  workspace: z.string().min(1),
  gitBranch: z.string().min(1).optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  cumulativeUsage: modelUsageSchema.optional(),
  lastRunStatus: z.enum(['idle', 'running', 'completed', 'failed']),
  compactionCount: z.number().int().nonnegative(),
}) as z.ZodType<SessionRecord>

/** 列表和选择器使用的轻量投影，避免暴露完整消息历史。 */
export interface SessionSummary {
  id: string
  title: string
  name?: string
  updatedAt: string
  provider: string
  model: string
  messageCount: number
  lastRunStatus: SessionRecord['lastRunStatus']
}
