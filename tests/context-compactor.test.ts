import { describe, expect, it } from 'vitest'
import type { Message } from '../src/domain/message.js'
import type { ModelRequest, ModelResponse } from '../src/domain/model.js'
import type { ModelAdapter } from '../src/models/model-adapter.js'
import type { ModelEvent } from '../src/models/model-event.js'
import { ContextCompactor } from '../src/runtime/context-compactor.js'

class SummaryModel implements ModelAdapter {
  readonly contextWindow = 200
  readonly requests: ModelRequest[] = []

  constructor(private readonly response: ModelResponse | Error) {}

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    this.requests.push(request)
    if (this.response instanceof Error) throw this.response
    yield { type: 'completed', response: this.response }
  }
}

const toolPair: Message[] = [
  {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"old.ts"}' } }],
  },
  { role: 'tool', tool_call_id: 'call-1', content: '旧工具结果'.repeat(20) },
]

describe('ContextCompactor', () => {
  it('按完整用户轮次压缩并保留最近消息', async () => {
    const model = new SummaryModel({
      content: '保留用户目标、旧工具结果和已完成修改。',
      toolCalls: [],
      usage: {
        inputTokens: 30,
        outputTokens: 8,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 38,
      },
    })
    const messages: Message[] = [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '旧任务'.repeat(30) },
      ...toolPair,
      { role: 'user', content: '最近任务' },
      { role: 'assistant', content: '最近回答' },
    ]
    const compactor = new ContextCompactor({ model, threshold: 0.5, keepRecentTokens: 40 })

    const result = await compactor.compactIfNeeded(messages)

    expect(result.changed).toBe(true)
    expect(result.messages[1]?.content).toContain('[PawCode 历史摘要]')
    expect(result.messages.slice(-2)).toEqual(messages.slice(-2))
    expect(result.usage?.totalTokens).toBe(38)
    const summaryInput = model.requests[0]?.messages.at(-1)?.content
    expect(summaryInput).toContain('read_file')
    expect(summaryInput).toContain('旧工具结果')
  })

  it('摘要失败时保留全部原消息', async () => {
    const model = new SummaryModel(new Error('摘要服务失败'))
    const messages: Message[] = [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '旧消息'.repeat(100) },
      { role: 'assistant', content: '旧回答' },
      { role: 'user', content: '新消息' },
    ]
    const result = await new ContextCompactor({ model, threshold: 0.1, keepRecentTokens: 20 }).compactIfNeeded(messages)

    expect(result.changed).toBe(false)
    expect(result.messages).toEqual(messages)
    expect(result.error?.message).toBe('摘要服务失败')
  })
})
