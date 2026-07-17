import type { ToolCall } from './tool.js'

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface Message {
  role: Role
  content: string | null
  tool_call_id?: string
  tool_calls?: ToolCall[]
  // 供应商原始消息由 Adapter 保存，避免丢失 thinking signature 等续聊信息。
  providerData?: unknown
}
