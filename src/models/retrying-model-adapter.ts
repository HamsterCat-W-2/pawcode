import type { ModelRequest } from '../domain/model.js'
import type { ModelAdapter } from './model-adapter.js'
import type { ModelEvent } from './model-event.js'

export interface RetryingModelAdapterOptions {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs?: number
  random?: () => number
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
}

/**
 * 只在底层尚未产生任何流事件时重试瞬时错误。
 *
 * 一旦 delta 或 tool call 已经向 Runtime 可见，重放请求可能重复文本甚至重复后续副作用，
 * 因此宁可把错误交给上层，也不能自动重试。
 */
export class RetryingModelAdapter implements ModelAdapter {
  readonly contextWindow?: number
  private readonly maxDelayMs: number
  private readonly random: () => number
  private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>

  constructor(
    private readonly model: ModelAdapter,
    private readonly options: RetryingModelAdapterOptions,
  ) {
    if (model.contextWindow !== undefined) this.contextWindow = model.contextWindow
    this.maxDelayMs = options.maxDelayMs ?? 10_000
    this.random = options.random ?? Math.random
    this.sleep = options.sleep ?? abortableSleep
  }

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    for (let attempt = 0; ; attempt += 1) {
      let emitted = false
      try {
        for await (const event of this.model.stream(request)) {
          emitted = true
          yield event
        }
        return
      } catch (error) {
        const canRetry =
          !request.signal?.aborted && !emitted && attempt < this.options.maxRetries && isTransientModelError(error)
        if (!canRetry) throw error

        const exponential = Math.min(this.maxDelayMs, this.options.baseDelayMs * 2 ** attempt)
        const jittered = Math.round(exponential * (0.8 + this.random() * 0.4))
        const retryAfter = parseRetryAfterMs(error)
        // Retry-After 也受客户端上限约束，避免异常响应让 CLI 看似永久卡住。
        await this.sleep(Math.min(this.maxDelayMs, Math.max(jittered, retryAfter ?? 0)), request.signal)
      }
    }
  }
}

export function isTransientModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (
    /cancel|取消|abort|401|403|unauthori[sz]ed|forbidden|api key|invalid request|context.{0,12}(long|length|limit)/i.test(
      message,
    )
  ) {
    return false
  }
  return /\b(408|409|425|429|500|502|503|504|529)\b|rate.?limit|overload|temporar|timeout|timed out|模型请求超过|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|fetch failed|network/i.test(
    message,
  )
}

function parseRetryAfterMs(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error)
  const match = /retry[- ]after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|s|seconds?)?/i.exec(message)
  const value = match?.[1] ? Number(match[1]) : undefined
  if (value === undefined || !Number.isFinite(value)) return undefined
  return match?.[2]?.toLowerCase() === 'ms' ? value : value * 1_000
}

function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('模型请求已取消'))
      return
    }
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const timeout = setTimeout(() => {
      cleanup()
      resolve()
    }, delayMs)
    const abort = () => {
      clearTimeout(timeout)
      cleanup()
      reject(new Error('模型请求已取消'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
