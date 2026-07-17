import type { Message } from './message.js'
import type { ToolCall, ToolDefinition } from './tool.js'

export interface ModelRequest {
  messages: Message[]
  tools: ToolDefinition[]
  signal?: AbortSignal
}

export interface ModelResponse {
  content: string | null
  toolCalls: ToolCall[]
  // Runtime 不解析该字段，只在下一轮原样交还给同一个 Adapter。
  providerData?: unknown
}
