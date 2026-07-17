import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type Context,
} from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { PiAiModelAdapter } from '../src/models/pi-ai-model-adapter.js'
import { AgentRuntime } from '../src/runtime/agent-runtime.js'
import type { Tool } from '../src/tools/tool.js'
import { ToolRegistry } from '../src/tools/tool-registry.js'

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

describe('PiAiModelAdapter', () => {
  it('在 PawCode Runtime 与 pi-ai Provider 之间转换工具调用和消息历史', async () => {
    const faux = fauxProvider({ provider: 'faux-pawcode' })
    const models = createModels()
    models.setProvider(faux.provider)
    let continuationContext: Context | undefined

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('echo', { value: 'hello' }), {
        stopReason: 'toolUse',
      }),
      (context) => {
        continuationContext = context
        return fauxAssistantMessage([fauxThinking('整理工具结果'), fauxText('完成')])
      },
    ])

    const runtime = new AgentRuntime({
      model: new PiAiModelAdapter({
        provider: 'faux-pawcode',
        model: faux.getModel().id,
        models,
      }),
      tools: new ToolRegistry([echoTool]),
      toolContext: { workspace: process.cwd(), maxOutputChars: 10_000 },
      maxTurns: 3,
    })

    const events = []
    for await (const event of runtime.run('开始')) events.push(event)

    expect(events.some((event) => event.type === 'text_delta')).toBe(true)
    expect(events.some((event) => event.type === 'thinking_delta')).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'completed', text: '完成' })
    expect(continuationContext?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult'])
    expect(continuationContext?.messages.at(-1)).toMatchObject({
      role: 'toolResult',
      toolName: 'echo',
      isError: false,
    })
  })
})
