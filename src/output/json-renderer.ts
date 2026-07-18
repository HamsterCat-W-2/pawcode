import type { AgentEvent } from '../runtime/agent-event.js'

/**
 * NDJSON 事件信封版本。每行都独立携带版本，消费者可逐行解析和进行协议迁移；
 * 它与应用版本、Session schema 版本互不绑定。
 */
export interface JsonEvent {
  version: 1
  type: string
  [key: string]: unknown
}

export function toJsonEvent(event: AgentEvent): JsonEvent {
  if (event.type === 'failed' || event.type === 'context_compaction_failed') {
    // Error 的 message 默认不可枚举，必须显式投影，否则 JSON.stringify 会得到空对象。
    return { version: 1, type: event.type, error: { message: event.error.message } }
  }
  return { version: 1, ...event }
}

export function encodeJsonLine(value: unknown): string {
  // 换行是 NDJSON 的记录分隔符；此层禁止追加颜色、Emoji 或交互提示。
  return `${JSON.stringify(value)}\n`
}
