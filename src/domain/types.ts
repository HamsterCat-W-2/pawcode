export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface Message {
  role: Role
  content: string | null
  tool_call_id?: string
  tool_calls?: ToolCall[]
  // 供应商原始消息由 Adapter 保存，避免丢失 thinking signature 等续聊信息。
  providerData?: unknown
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

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
