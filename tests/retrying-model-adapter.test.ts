import { describe, expect, it, vi } from 'vitest'
import type { ModelRequest } from '../src/domain/model.js'
import type { ModelAdapter } from '../src/models/model-adapter.js'
import type { ModelEvent } from '../src/models/model-event.js'
import { isTransientModelError, RetryingModelAdapter } from '../src/models/retrying-model-adapter.js'

const request: ModelRequest = { messages: [{ role: 'user', content: '测试' }], tools: [] }

describe('RetryingModelAdapter', () => {
  it('零输出的瞬时错误按上限重试并最终成功', async () => {
    const base = new ScriptedAdapter([new Error('429 rate limit'), new Error('503 overloaded'), completedEvent])
    const sleep = vi.fn(async () => undefined)
    const adapter = new RetryingModelAdapter(base, { maxRetries: 2, baseDelayMs: 100, random: () => 0.5, sleep })

    const events = []
    for await (const event of adapter.stream(request)) events.push(event)

    expect(events).toEqual([completedEvent])
    expect(base.calls).toBe(3)
    expect(sleep).toHaveBeenNthCalledWith(1, 100, undefined)
    expect(sleep).toHaveBeenNthCalledWith(2, 200, undefined)
  })

  it('产生任何流事件后不重试，避免重复输出', async () => {
    const base: ModelAdapter = {
      async *stream() {
        yield { type: 'text_delta', text: '部分' }
        throw new Error('503 overloaded')
      },
    }
    const adapter = new RetryingModelAdapter(base, { maxRetries: 2, baseDelayMs: 1, sleep: vi.fn() })
    const events = []

    await expect(async () => {
      for await (const event of adapter.stream(request)) events.push(event)
    }).rejects.toThrow('503 overloaded')
    expect(events).toEqual([{ type: 'text_delta', text: '部分' }])
  })

  it('认证、参数和用户取消错误不重试', () => {
    expect(isTransientModelError(new Error('401 invalid API key'))).toBe(false)
    expect(isTransientModelError(new Error('模型请求已取消'))).toBe(false)
    expect(isTransientModelError(new Error('context length limit exceeded'))).toBe(false)
    expect(isTransientModelError(new Error('ECONNRESET'))).toBe(true)
    expect(isTransientModelError(new Error('模型请求超过 120000ms'))).toBe(true)
  })

  it('退避等待响应 AbortSignal', async () => {
    const controller = new AbortController()
    const adapter = new RetryingModelAdapter(new ScriptedAdapter([new Error('503 overloaded')]), {
      maxRetries: 2,
      baseDelayMs: 10_000,
    })
    const pending = (async () => {
      for await (const _event of adapter.stream({ ...request, signal: controller.signal })) {
        // 该测试在重试等待期间取消，不会产生事件。
      }
    })()
    setTimeout(() => controller.abort(), 5)

    await expect(pending).rejects.toThrow('模型请求已取消')
  })

  it('Retry-After 不得突破客户端最大等待时间', async () => {
    const sleep = vi.fn(async () => undefined)
    const adapter = new RetryingModelAdapter(new ScriptedAdapter([new Error('429 retry-after: 60s'), completedEvent]), {
      maxRetries: 1,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      sleep,
    })

    for await (const _event of adapter.stream(request)) {
      // 消费最终成功事件。
    }
    expect(sleep).toHaveBeenCalledWith(1_000, undefined)
  })
})

const completedEvent: ModelEvent = {
  type: 'completed',
  response: { content: '完成', toolCalls: [] },
}

class ScriptedAdapter implements ModelAdapter {
  calls = 0

  constructor(private readonly outcomes: Array<Error | ModelEvent>) {}

  async *stream(): AsyncGenerator<ModelEvent> {
    const outcome = this.outcomes[this.calls]
    this.calls += 1
    if (outcome instanceof Error) throw outcome
    if (!outcome) throw new Error('缺少测试结果')
    yield outcome
  }
}
