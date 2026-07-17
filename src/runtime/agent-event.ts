export type AgentEvent =
  | { type: 'turn_started'; turn: number }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_started'; name: string; argumentsJson: string }
  | { type: 'tool_finished'; name: string; result: string }
  | { type: 'completed'; text: string }
  | { type: 'failed'; error: Error }
