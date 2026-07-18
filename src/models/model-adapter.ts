import type { ModelRequest } from '../domain/model.js'
import type { ModelEvent } from './model-event.js'

// Agent Runtime 只依赖这个小接口，不需要知道供应商的请求格式。
export interface ModelAdapter {
  /** 仅用于上下文预算；Adapter 不提供时 Runtime 使用保守默认值。 */
  readonly contextWindow?: number
  stream(request: ModelRequest): AsyncIterable<ModelEvent>
}
