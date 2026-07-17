import { describe, expect, it } from 'vitest'
import type { ModelRequest, ModelResponse } from '../src/domain/model.js'
import type { ModelAdapter } from '../src/models/model-adapter.js'
import { AgentRuntime } from '../src/runtime/agent-runtime.js'
import type { Tool } from '../src/tools/tool.js'
import { ToolRegistry } from '../src/tools/tool-registry.js'

class ScriptedModel implements ModelAdapter {
  readonly requests: ModelRequest[] = []
  private index = 0

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request)
    const response = this.responses[this.index]
    this.index += 1
    if (!response) throw new Error('测试模型没有更多响应')
    return response
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
})
