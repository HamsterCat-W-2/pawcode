import type { ModelUsage } from '../domain/model.js'

export type AgentEvent =
  | { type: 'turn_started'; turn: number }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_started'; name: string; argumentsJson: string }
  | { type: 'tool_finished'; name: string; result: string }
  | {
      type: 'context_compacted'
      removedMessages: number
      estimatedTokensBefore: number
      estimatedTokensAfter: number
    }
  | { type: 'context_compaction_failed'; error: Error }
  | { type: 'completed'; text: string; usage?: ModelUsage; stopReason?: string }
  | { type: 'cancelled'; text?: string }
  | { type: 'failed'; error: Error }
