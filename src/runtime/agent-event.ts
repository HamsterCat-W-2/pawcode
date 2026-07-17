export type AgentEvent =
  | { type: 'turn_started'; turn: number }
  | { type: 'tool_started'; name: string; argumentsJson: string }
  | { type: 'tool_finished'; name: string; result: string }
  | { type: 'completed'; text: string }
  | { type: 'failed'; error: Error }
