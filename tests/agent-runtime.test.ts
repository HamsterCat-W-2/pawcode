import { describe, expect, it, vi } from 'vitest'
import type { ModelRequest, ModelResponse } from '../src/domain/model.js'
import type { ModelAdapter } from '../src/models/model-adapter.js'
import type { ModelEvent } from '../src/models/model-event.js'
import { AgentRuntime } from '../src/runtime/agent-runtime.js'
import { ContextCompactor } from '../src/runtime/context-compactor.js'
import { SkillRegistry } from '../src/skills/skill-registry.js'
import type { SkillCatalog } from '../src/skills/skill-types.js'
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

class CompactingModel extends ScriptedModel {
  readonly contextWindow = 120
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

  it('只在模型请求中注入项目上下文，不把上下文写入会话消息', async () => {
    const model = new ScriptedModel([{ content: '完成', toolCalls: [] }])
    const runtime = new AgentRuntime({
      model,
      tools: new ToolRegistry([]),
      toolContext: { workspace: process.cwd(), maxOutputChars: 10_000 },
      maxTurns: 1,
      systemPrompt: '内置规则\n\n项目私有规则',
    })

    for await (const _event of runtime.run('检查')) {
      // 只消费事件，断言集中在模型请求和持久化快照。
    }

    expect(model.requests[0]?.messages[0]).toMatchObject({ role: 'system', content: '内置规则\n\n项目私有规则' })
    expect(runtime.messagesSnapshot()[0]).toMatchObject({
      role: 'system',
      content: expect.not.stringContaining('项目私有规则'),
    })
  })

  it('激活 Skill 后同时限制模型可见工具与实际工具执行，并且不写入会话消息', async () => {
    const model = new ScriptedModel([
      {
        content: null,
        toolCalls: [
          {
            id: 'blocked-call',
            type: 'function',
            function: { name: 'write_file', arguments: '{}' },
          },
        ],
      },
      { content: '完成', toolCalls: [] },
    ])
    const writeTool: Tool = {
      definition: {
        type: 'function',
        function: { name: 'write_file', description: '写入', parameters: { type: 'object' } },
      },
      async execute() {
        return '不应执行'
      },
    }
    const skills: SkillCatalog = {
      skills: [
        {
          name: 'read-only',
          description: '仅允许读取',
          allowedTools: ['echo'],
          instructions: '只能读取，不得写入。',
          source: 'project',
          path: '/workspace/.pawcode/skills/read-only.md',
        },
      ],
      overridden: [],
      diagnostics: [],
    }
    const registry = new SkillRegistry(skills)
    registry.activate('read-only', ['echo', 'write_file'])
    const runtime = new AgentRuntime({
      model,
      tools: new ToolRegistry([echoTool, writeTool]),
      toolContext: { workspace: process.cwd(), maxOutputChars: 10_000 },
      maxTurns: 2,
      systemPrompt: '基础规则',
      skillRegistry: registry,
    })

    for await (const _event of runtime.run('开始')) {
      // 消费完整 run，断言模型请求和执行结果是否共用同一禁用集合。
    }

    expect(model.requests[0]?.tools.map((tool) => tool.function.name)).toEqual(['echo'])
    expect(model.requests[0]?.messages[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('<pawcode-skill name="read-only" source="project">'),
    })
    expect(model.requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'blocked-call',
      content: '工具执行失败：工具已被当前路径规则禁用：write_file',
    })
    expect(runtime.messagesSnapshot()[0]).toMatchObject({
      role: 'system',
      content: expect.not.stringContaining('只能读取'),
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
    expect(runtime.messagesSnapshot().at(-1)).toEqual({ role: 'assistant', content: '部分回答' })
  })

  it('用户取消时保存部分回答并产生 cancelled 事件', async () => {
    const controller = new AbortController()
    const runtime = new AgentRuntime({
      model: new FailingModel(),
      tools: new ToolRegistry([]),
      toolContext: { workspace: process.cwd(), maxOutputChars: 10_000 },
      maxTurns: 1,
    })
    controller.abort()

    const events = []
    for await (const event of runtime.run('开始', controller.signal)) events.push(event)

    expect(events.at(-1)).toMatchObject({ type: 'cancelled', text: '部分回答' })
    expect(runtime.messagesSnapshot().at(-1)).toEqual({ role: 'assistant', content: '部分回答' })
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

  it('压缩旧历史、保存新消息并把摘要用量计入本轮', async () => {
    const model = new CompactingModel([
      {
        content: '旧历史摘要',
        toolCalls: [],
        usage: {
          inputTokens: 20,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 25,
        },
      },
      {
        content: '当前回答',
        toolCalls: [],
        usage: {
          inputTokens: 10,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 13,
        },
        stopReason: 'stop',
      },
    ])
    const onMessagesChanged = vi.fn(async () => undefined)
    const onContextCompacted = vi.fn(async () => undefined)
    const runtime = new AgentRuntime({
      model,
      tools: new ToolRegistry([]),
      toolContext: { workspace: process.cwd(), maxOutputChars: 10_000 },
      maxTurns: 1,
      initialMessages: [
        { role: 'system', content: '系统提示' },
        { role: 'user', content: '很长的旧问题'.repeat(30) },
        { role: 'assistant', content: '旧回答' },
        { role: 'user', content: '最近问题' },
        { role: 'assistant', content: '最近回答' },
      ],
      compactor: new ContextCompactor({ model, threshold: 0.5, keepRecentTokens: 30 }),
      onMessagesChanged,
      onContextCompacted,
    })

    const events = []
    for await (const event of runtime.run('当前问题')) events.push(event)

    expect(events.map((event) => event.type)).toEqual(['context_compacted', 'turn_started', 'text_delta', 'completed'])
    expect(events.at(-1)).toMatchObject({ type: 'completed', usage: { totalTokens: 38 } })
    expect(runtime.messagesSnapshot()[1]?.content).toContain('[PawCode 历史摘要]')
    expect(onMessagesChanged).toHaveBeenCalled()
    expect(onContextCompacted).toHaveBeenCalledOnce()
  })
})
