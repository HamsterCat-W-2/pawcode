import type { Message } from './message.js'
import type { ToolCall, ToolDefinition } from './tool.js'

export interface ModelRequest {
  messages: Message[]
  tools: ToolDefinition[]
  signal?: AbortSignal
}

export interface ModelCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/** PawCode 自己的用量协议；字段命名不跟随任何单一模型供应商。 */
export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  cost?: ModelCost
}

export interface ModelResponse {
  content: string | null
  toolCalls: ToolCall[]
  // Adapter 负责把供应商统计投影到 Domain，Runtime 只做跨轮累加。
  usage?: ModelUsage
  stopReason?: string
  // Runtime 不解析该字段，只在下一轮原样交还给同一个 Adapter。
  providerData?: unknown
}
