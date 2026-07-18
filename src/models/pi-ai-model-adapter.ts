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
  type ToolCall as PiToolCall,
  type Usage,
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { Message } from '../domain/message.js'
import type { ModelRequest, ModelResponse, ModelUsage } from '../domain/model.js'
import type { ToolCall, ToolDefinition } from '../domain/tool.js'
import type { ModelAdapter } from './model-adapter.js'
import type { ModelEvent } from './model-event.js'

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
  readonly contextWindow: number
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
    this.contextWindow = selectedModel.contextWindow
  }

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    const controller = new AbortController()
    let didTimeout = false
    const timeout = setTimeout(() => {
      didTimeout = true
      controller.abort()
    }, this.timeoutMs)
    const forwardAbort = () => controller.abort()
    request.signal?.addEventListener('abort', forwardAbort, { once: true })

    try {
      const stream = this.models.stream(this.selectedModel, toPiContext(request, this.selectedModel), {
        signal: controller.signal,
        timeoutMs: this.timeoutMs,
        ...(this.options.apiKey ? { apiKey: this.options.apiKey } : {}),
      })

      for await (const event of stream) {
        switch (event.type) {
          case 'text_delta':
            yield { type: 'text_delta', text: event.delta }
            break
          case 'thinking_delta':
            yield { type: 'thinking_delta', text: event.delta }
            break
          case 'toolcall_end':
            // 只有 end 事件才包含完整参数，避免 Runtime 执行半截 JSON。
            yield { type: 'tool_call', call: fromPiToolCall(event.toolCall) }
            break
          case 'done':
            // done 中的完整消息用于会话历史；delta 只负责实时展示。
            yield { type: 'completed', response: fromPiResponse(event.message) }
            break
          case 'error':
            // pi-ai 把请求失败编码成流事件，这里恢复成异常交给 Runtime 统一处理。
            if (event.reason === 'aborted' && request.signal?.aborted) {
              throw new Error('模型请求已取消')
            }
            if (event.reason === 'aborted' && didTimeout) {
              throw new Error(`模型请求超过 ${this.timeoutMs}ms`)
            }
            throw new Error(event.error.errorMessage ?? `模型请求${event.reason}`)
        }
      }
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

/**
 * 把 PawCode 的完整模型请求转换为 pi-ai Context。
 *
 * 为什么需要转换：AgentRuntime 使用 PawCode 自己的 Domain 类型，以免直接依赖
 * pi-ai；而 pi-ai 要求 systemPrompt、messages、tools 分别存放。这个函数就是两层
 * 之间的协议边界，供应商 SDK 的格式变化应被限制在 Adapter 内部。
 */
function toPiContext(request: ModelRequest, model: Model<Api>): Context {
  // PawCode 把 system prompt 当作普通消息保存，pi-ai 则使用独立字段。
  const systemPrompt = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content ?? '')
    .filter(Boolean)
    .join('\n\n')

  // system 消息已经提取，其余消息再按照角色逐条转换。
  const messages = request.messages
    .filter((message) => message.role !== 'system')
    .map((message, index, allMessages) => toPiMessage(message, index, allMessages, model))

  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    messages,
    // 工具定义同样属于两个协议，因此集中在这里转换，Runtime 不需要感知 pi-ai。
    tools: request.tools.map(toPiTool),
  }
}

/**
 * 把一条 PawCode Message 转换为对应的 pi-ai Message。
 *
 * 两边的角色命名和字段结构不完全一致：例如 PawCode 使用 `tool`，pi-ai 使用
 * `toolResult`；PawCode 的工具参数是 JSON 字符串，pi-ai 使用对象。
 */
function toPiMessage(message: Message, index: number, messages: Message[], model: Model<Api>): PiMessage {
  if (message.role === 'user') {
    // pi-ai 消息要求 timestamp；PawCode 当前没有保存消息时间，因此在发送时补上。
    return { role: 'user', content: message.content ?? '', timestamp: Date.now() }
  }

  if (message.role === 'assistant') {
    // 只有 API、供应商和模型完全一致时才重放签名与 responseId；跨模型复用可能被供应商拒绝。
    if (isPiAssistantMessageForModel(message.providerData, model)) return message.providerData

    // 缺少 providerData 或恢复时切换了模型，则使用 PawCode 可移植字段重建消息。
    return createFallbackAssistantMessage(message, model)
  }

  if (message.role === 'tool') {
    const toolCallId = message.tool_call_id ?? 'unknown'
    return {
      role: 'toolResult',
      toolCallId,
      // PawCode 的 tool 消息只保存调用 ID，所以需要从前面的 assistant 消息查回名称。
      toolName: findToolName(messages.slice(0, index), toolCallId),
      content: [{ type: 'text', text: message.content ?? '' }],
      // 当前 Domain 没有独立 isError 字段，只能根据 ToolRegistry 的错误前缀推断。
      isError: message.content?.startsWith('工具执行失败：') ?? false,
      timestamp: Date.now(),
    }
  }

  // system 消息已由 toPiContext 提取，正常情况下不会到达这里。
  return { role: 'user', content: message.content ?? '', timestamp: Date.now() }
}

/**
 * 在缺少原始 providerData 时，构造一条最小可用的 pi-ai AssistantMessage。
 *
 * 这是兼容旧数据的兜底路径，不代表真实供应商响应：Token 用量只能填零，且无法
 * 恢复已经丢失的 thinking signature。正常在线对话会直接重用 providerData。
 */
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
        // PawCode 采用 OpenAI 风格 JSON 字符串；pi-ai 的 arguments 必须是对象。
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

/**
 * 把 pi-ai 的统一 AssistantMessage 转换回 PawCode ModelResponse。
 *
 * pi-ai 使用内容块数组表达文本、thinking 和工具调用；PawCode Runtime 当前只消费
 * 拼接后的文本和 OpenAI 风格 ToolCall，因此需要在返回 Runtime 前做一次投影。
 */
function fromPiResponse(response: AssistantMessage): ModelResponse {
  // 一个响应可能包含多个 text block，PawCode 当前将它们合并成一段文本。
  const text = response.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('')
  // pi-ai 的对象参数转换为 PawCode ToolRegistry 当前使用的 JSON 字符串。
  const toolCalls: ToolCall[] = response.content.filter((content) => content.type === 'toolCall').map(fromPiToolCall)

  return {
    content: text || null,
    toolCalls,
    usage: fromPiUsage(response.usage),
    stopReason: response.stopReason,
    // 简化后的响应会丢弃部分信息，因此同时保存原始消息供下一轮完整重放。
    providerData: response,
  }
}

function fromPiUsage(usage: Usage): ModelUsage {
  // 显式逐字段转换，防止 pi-ai 的类型或命名扩散到 CLI、Runtime 和会话层。
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: {
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      total: usage.cost.total,
    },
  }
}

/** 把单个完整 pi-ai ToolCall 转成 PawCode 的 OpenAI 风格 ToolCall。 */
function fromPiToolCall(call: PiToolCall): ToolCall {
  return {
    id: call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    },
  }
}

/**
 * 把 PawCode 的 OpenAI 风格 ToolDefinition 转换为 pi-ai Tool。
 * 两者表达的是同一份 JSON Schema，但外层字段结构不同。
 */
function toPiTool(definition: ToolDefinition): PiTool {
  return {
    name: definition.function.name,
    description: definition.function.description,
    // PawCode 工具目前保存标准 JSON Schema；pi-ai 的 TSchema 是其类型化超集。
    parameters: definition.function.parameters as TSchema,
  }
}

/**
 * 根据 toolCallId 从历史 assistant 消息中反向查找工具名称。
 * 之所以需要查找，是因为 PawCode 的 tool 结果消息目前没有直接保存 toolName。
 */
function findToolName(messages: Message[], toolCallId: string): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const call = messages[index]?.tool_calls?.find((item) => item.id === toolCallId)
    if (call) return call.function.name
  }
  return 'unknown'
}

/**
 * 把 PawCode ToolCall 中的 JSON 字符串参数解析成 pi-ai 需要的对象。
 * 模型偶尔可能返回非法 JSON；兜底为空对象，让后续工具参数校验给出业务错误。
 */
function parseArguments(argumentsJson: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(argumentsJson)
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

/**
 * providerData 在 PawCode Domain 中是 unknown，以保持 Domain 不依赖 pi-ai。
 * 在重放之前必须先进行最小运行时检查，TypeScript 才能安全地把它当作 AssistantMessage。
 */
function isPiAssistantMessage(value: unknown): value is AssistantMessage {
  return (
    isRecord(value) &&
    value.role === 'assistant' &&
    Array.isArray(value.content) &&
    typeof value.stopReason === 'string'
  )
}

function isPiAssistantMessageForModel(value: unknown, model: Model<Api>): value is AssistantMessage {
  return (
    isPiAssistantMessage(value) &&
    value.api === model.api &&
    value.provider === model.provider &&
    value.model === model.id
  )
}

/** 判断 unknown 是否为普通对象，供 JSON 参数和 providerData 的类型收窄复用。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * pi-ai AssistantMessage 强制要求 Usage；fallback 消息没有真实计费数据，因此使用零值。
 */
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
