import type { ModelResponse } from '../domain/model.js'
import type { ToolCall } from '../domain/tool.js'

/** 模型流的供应商无关事件；pi-ai 事件只能在具体 Adapter 内部出现。 */
export type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'completed'; response: ModelResponse }
