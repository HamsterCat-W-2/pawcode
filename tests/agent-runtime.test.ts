import { describe, expect, it } from 'vitest'
import type { ModelRequest, ModelResponse } from '../src/domain/model.js'
import type { ModelAdapter } from '../src/models/model-adapter.js'
import type { ModelEvent } from '../src/models/model-event.js'
import { AgentRuntime } from '../src/runtime/agent-runtime.js'
import type { Tool } from '../src/tools/tool.js'
import { ToolRegistry } from '../src/tools/tool-registry.js'

class ScriptedModel implements ModelAdapter {
  readonly requests: ModelRequest[] = []
  private index = 0

  constructor(private readonly responses: ModelResponse[]) {}

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    this.requests.push(request)
    const response = this.responses[this.index]
    this.index += 1
    if (!response) throw new Error('测试模型没有更多响应')

    if (response.content) {
      yield { type: 'text_delta', text: response.content }
    }
    for (const call of response.toolCalls) {
      yield { type: 'tool_call', call }
    }
    yield { type: 'completed', response }
  }
}

class FailingModel implements ModelAdapter {
  async *stream(): AsyncGenerator<ModelEvent> {
    yield { type: 'text_delta', text: '部分回答' }
    throw new Error('流连接失败')
  }
}

const echoTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'echo',
      description: '返回输入',
      parameters: { type: 'object' },
    },
  },
  async execute(argumentsJson) {
    return argumentsJson
  },
}

describe('AgentRuntime', () => {
  it('执行工具并把结果交还模型', async () => {
    const model = new ScriptedModel([
      {
        content: null,
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'echo', arguments: '{"value":"hello"}' },
          },
        ],
      },
      { content: '完成', toolCalls: [] },
    ])
    const runtime = new AgentRuntime({
      model,
      tools: new ToolRegistry([echoTool]),
      toolContext: { workspace: process.cwd(), maxOutputChars: 10_000 },
      maxTurns: 3,
    })

    const events = []
    for await (const event of runtime.run('开始')) events.push(event)

    expect(events.map((event) => event.type)).toEqual([
      'turn_started',
      'tool_started',
      'tool_finished',
      'turn_started',
      'text_delta',
      'completed',
    ])
    expect(model.requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'call-1',
      content: '{"value":"hello"}',
    })
  })

  it('达到最大轮数时产生失败事件', async () => {
    const toolCallResponse: ModelResponse = {
      content: null,
      toolCalls: [
        {
          id: 'loop',
          type: 'function',
          function: { name: 'echo', arguments: '{}' },
        },
      ],
    }
    const runtime = new AgentRuntime({
      model: new ScriptedModel([toolCallResponse]),
      tools: new ToolRegistry([echoTool]),
      toolContext: { workspace: process.cwd(), maxOutputChars: 10_000 },
      maxTurns: 1,
    })

    const events = []
    for await (const event of runtime.run('循环')) events.push(event)

    expect(events.at(-1)?.type).toBe('failed')
  })

  it('保留已产生的 delta 并把流错误转换为失败事件', async () => {
    const runtime = new AgentRuntime({
      model: new FailingModel(),
      tools: new ToolRegistry([]),
      toolContext: { workspace: process.cwd(), maxOutputChars: 10_000 },
      maxTurns: 1,
    })

    const events = []
    for await (const event of runtime.run('开始')) events.push(event)

    expect(events.map((event) => event.type)).toEqual(['turn_started', 'text_delta', 'failed'])
    expect(events.at(-1)).toMatchObject({
      type: 'failed',
      error: new Error('流连接失败'),
    })
  })

  it('累加多轮模型用量并返回最终停止原因', async () => {
    const model = new ScriptedModel([
      {
        content: null,
        toolCalls: [{ id: 'usage-call', type: 'function', function: { name: 'echo', arguments: '{}' } }],
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
          totalTokens: 13,
          cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
        },
        stopReason: 'toolUse',
      },
      {
        content: '完成',
        toolCalls: [],
        usage: {
          inputTokens: 20,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 2,
          totalTokens: 27,
          cost: { input: 0.02, output: 0.05, cacheRead: 0, cacheWrite: 0.002, total: 0.072 },
        },
        stopReason: 'stop',
      },
    ])
    const runtime = new AgentRuntime({
      model,
      tools: new ToolRegistry([echoTool]),
      toolContext: { workspace: process.cwd(), maxOutputChars: 10_000 },
      maxTurns: 2,
    })

    const events = []
    for await (const event of runtime.run('统计')) events.push(event)

    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      stopReason: 'stop',
      usage: {
        inputTokens: 30,
        outputTokens: 7,
        cacheReadTokens: 1,
        cacheWriteTokens: 2,
        totalTokens: 40,
        cost: { total: 0.103 },
      },
    })
  })
})
