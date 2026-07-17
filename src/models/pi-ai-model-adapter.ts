import {
  createModels,
  createProvider,
  type Api,
  type AssistantMessage,
  type Context,
  type Message as PiMessage,
  type Model,
  type Models,
  type TSchema,
  type Tool as PiTool,
  type Usage,
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { Message, ModelRequest, ModelResponse, ToolCall, ToolDefinition } from '../domain/types.js'
import type { ModelAdapter } from './model-adapter.js'

export interface PiAiModelAdapterOptions {
  provider: string
  model: string
  /** 显式密钥优先；省略时 pi-ai 会读取供应商自己的环境变量。 */
  apiKey?: string
  /** 提供后注册为自定义 OpenAI-compatible Provider，用于 Ollama、代理等服务。 */
  baseUrl?: string
  timeoutMs?: number
  /** 允许测试或上层应用注入自己的 Provider 集合。 */
  models?: Models
}

/**
 * PawCode 与 pi-ai 之间唯一的翻译层。
 * Runtime 继续依赖 PawCode 自己的 ModelAdapter，不感知任何供应商类型。
 */
export class PiAiModelAdapter implements ModelAdapter {
  private readonly models: Models
  private readonly selectedModel: Model<Api>
  private readonly timeoutMs: number

  constructor(private readonly options: PiAiModelAdapterOptions) {
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.models = options.models ?? (options.baseUrl ? createOpenAICompatibleModels(options) : builtinModels())

    const selectedModel = this.models.getModel(options.provider, options.model)
    if (!selectedModel) {
      const examples = this.models
        .getModels(options.provider)
        .slice(0, 8)
        .map((model) => model.id)
        .join(', ')
      const hint = examples ? `；可用模型示例：${examples}` : ''
      throw new Error(`pi-ai 中找不到模型 ${options.provider}/${options.model}${hint}`)
    }
    this.selectedModel = selectedModel
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const forwardAbort = () => controller.abort()
    request.signal?.addEventListener('abort', forwardAbort, { once: true })

    try {
      const response = await this.models.complete(this.selectedModel, toPiContext(request, this.selectedModel), {
        signal: controller.signal,
        timeoutMs: this.timeoutMs,
        ...(this.options.apiKey ? { apiKey: this.options.apiKey } : {}),
      })

      // pi-ai 使用结构化错误消息而不是抛出请求错误。
      if (response.stopReason === 'error' || response.stopReason === 'aborted') {
        throw new Error(response.errorMessage ?? `模型请求${response.stopReason}`)
      }

      return fromPiResponse(response)
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', forwardAbort)
    }
  }
}

function createOpenAICompatibleModels(options: PiAiModelAdapterOptions & { baseUrl?: string }): Models {
  const baseUrl = options.baseUrl
  if (!baseUrl) throw new Error('自定义 Provider 缺少 MODEL_BASE_URL')

  const model: Model<'openai-completions'> = {
    id: options.model,
    name: options.model,
    api: 'openai-completions',
    provider: options.provider,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // 自定义服务无法自动获知这些上限，只用于客户端元数据。
    contextWindow: 128_000,
    maxTokens: 32_000,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  }

  const provider = createProvider({
    id: options.provider,
    name: options.provider,
    baseUrl,
    auth: {
      // 本地模型通常不需要密钥；若设置 MODEL_API_KEY，则仍会自动带上。
      apiKey: {
        name: `${options.provider} API key`,
        async resolve({ ctx, credential }) {
          const apiKey = credential?.key ?? (await ctx.env('MODEL_API_KEY'))
          return {
            auth: apiKey ? { apiKey } : {},
            ...(apiKey ? { source: 'MODEL_API_KEY' } : { source: 'keyless' }),
          }
        },
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  })
  const models = createModels()
  models.setProvider(provider)
  return models
}

function toPiContext(request: ModelRequest, model: Model<Api>): Context {
  const systemPrompt = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content ?? '')
    .filter(Boolean)
    .join('\n\n')

  const messages = request.messages
    .filter((message) => message.role !== 'system')
    .map((message, index, allMessages) => toPiMessage(message, index, allMessages, model))

  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    messages,
    tools: request.tools.map(toPiTool),
  }
}

function toPiMessage(message: Message, index: number, messages: Message[], model: Model<Api>): PiMessage {
  if (message.role === 'user') {
    return { role: 'user', content: message.content ?? '', timestamp: Date.now() }
  }

  if (message.role === 'assistant') {
    if (isPiAssistantMessage(message.providerData)) return message.providerData
    return createFallbackAssistantMessage(message, model)
  }

  if (message.role === 'tool') {
    const toolCallId = message.tool_call_id ?? 'unknown'
    return {
      role: 'toolResult',
      toolCallId,
      toolName: findToolName(messages.slice(0, index), toolCallId),
      content: [{ type: 'text', text: message.content ?? '' }],
      isError: message.content?.startsWith('工具执行失败：') ?? false,
      timestamp: Date.now(),
    }
  }

  // system 消息已由 toPiContext 提取，正常情况下不会到达这里。
  return { role: 'user', content: message.content ?? '', timestamp: Date.now() }
}

function createFallbackAssistantMessage(message: Message, model: Model<Api>): AssistantMessage {
  const toolCalls = message.tool_calls ?? []
  return {
    role: 'assistant',
    content: [
      ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
      ...toolCalls.map((call) => ({
        type: 'toolCall' as const,
        id: call.id,
        name: call.function.name,
        arguments: parseArguments(call.function.arguments),
      })),
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: toolCalls.length > 0 ? 'toolUse' : 'stop',
    timestamp: Date.now(),
  }
}

function fromPiResponse(response: AssistantMessage): ModelResponse {
  const text = response.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('')
  const toolCalls: ToolCall[] = response.content
    .filter((content) => content.type === 'toolCall')
    .map((call) => ({
      id: call.id,
      type: 'function',
      function: {
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      },
    }))

  return {
    content: text || null,
    toolCalls,
    // 保存完整原始消息，以便下一轮重放供应商签名和 reasoning 信息。
    providerData: response,
  }
}

function toPiTool(definition: ToolDefinition): PiTool {
  return {
    name: definition.function.name,
    description: definition.function.description,
    // PawCode 工具目前保存标准 JSON Schema；pi-ai 的 TSchema 是其类型化超集。
    parameters: definition.function.parameters as TSchema,
  }
}

function findToolName(messages: Message[], toolCallId: string): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const call = messages[index]?.tool_calls?.find((item) => item.id === toolCallId)
    if (call) return call.function.name
  }
  return 'unknown'
}

function parseArguments(argumentsJson: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(argumentsJson)
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

function isPiAssistantMessage(value: unknown): value is AssistantMessage {
  return (
    isRecord(value) &&
    value.role === 'assistant' &&
    Array.isArray(value.content) &&
    typeof value.stopReason === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}
