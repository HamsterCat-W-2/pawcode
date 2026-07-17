import type { ModelRequest, ModelResponse } from '../domain/types.js'

// Agent Runtime 只依赖这个小接口，不需要知道供应商的请求格式。
export interface ModelAdapter {
  complete(request: ModelRequest): Promise<ModelResponse>
}
