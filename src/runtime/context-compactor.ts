import type { Message } from '../domain/message.js'
import type { ModelUsage } from '../domain/model.js'
import type { ModelAdapter } from '../models/model-adapter.js'

const summaryPrefix = '[PawCode 历史摘要]'
const summarySystemPrompt = `你负责压缩 AI 编程 Agent 的旧会话历史。
只输出一份简洁、事实性的中文摘要，必须保留：
- 用户目标与明确要求；
- 已确认的架构和安全决策；
- 已修改文件及关键实现；
- 命令、测试和验证结果；
- 错误、风险与未完成事项。
不要编造内容，不要调用工具，不要包含寒暄。`

export interface ContextCompactorOptions {
  model: ModelAdapter
  threshold: number
  keepRecentTokens: number
}

export interface CompactionResult {
  messages: Message[]
  changed: boolean
  removedMessages: number
  estimatedTokensBefore: number
  estimatedTokensAfter: number
  usage?: ModelUsage
  error?: Error
}

/**
 * 在下一次模型请求前压缩旧输入历史。
 *
 * 它不会截断当前模型输出；摘要失败时也会返回原历史，让请求按原语义继续执行。
 */
export class ContextCompactor {
  constructor(private readonly options: ContextCompactorOptions) {}

  async compactIfNeeded(messages: Message[], signal?: AbortSignal): Promise<CompactionResult> {
    const estimatedTokensBefore = estimateMessagesTokens(messages)
    // 未声明 context window 的兼容模型使用保守默认值，阈值仍由项目配置控制。
    const contextWindow = this.options.model.contextWindow ?? 128_000
    if (estimatedTokensBefore < contextWindow * this.options.threshold) {
      return unchanged(messages, estimatedTokensBefore)
    }

    // 初始 system prompt 是 Agent 行为边界，压缩时必须原样保留在首位。
    const firstSystem = messages[0]
    if (!firstSystem || firstSystem.role !== 'system') return unchanged(messages, estimatedTokensBefore)
    const groups = groupConversation(messages.slice(1))
    if (groups.length < 2) return unchanged(messages, estimatedTokensBefore)

    const recentGroups: Message[][] = []
    let recentTokens = 0
    const recentBudget = Math.min(this.options.keepRecentTokens, Math.floor(contextWindow * 0.5))
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index]
      if (!group) continue
      const groupTokens = estimateMessagesTokens(group)
      // 至少保留最后一个完整用户轮次，即使它本身已经超过 recentBudget。
      if (recentGroups.length > 0 && recentTokens + groupTokens > recentBudget) break
      recentGroups.unshift(group)
      recentTokens += groupTokens
    }

    const oldGroupCount = groups.length - recentGroups.length
    if (oldGroupCount <= 0) return unchanged(messages, estimatedTokensBefore)
    const oldMessages = groups.slice(0, oldGroupCount).flat()

    try {
      // 摘要通过同一个 ModelAdapter 生成，但不给工具，避免压缩阶段产生任何副作用。
      const summary = await this.summarize(oldMessages, signal)
      const compacted = [
        firstSystem,
        { role: 'system' as const, content: `${summaryPrefix}\n${summary.text}` },
        ...recentGroups.flat(),
      ]
      return {
        messages: compacted,
        changed: true,
        removedMessages: messages.length - compacted.length,
        estimatedTokensBefore,
        estimatedTokensAfter: estimateMessagesTokens(compacted),
        ...(summary.usage ? { usage: summary.usage } : {}),
      }
    } catch (error) {
      // 压缩是优化而不是正确性前提；失败时保留全部消息，由上层决定是否展示警告。
      return {
        ...unchanged(messages, estimatedTokensBefore),
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }

  private async summarize(messages: Message[], signal?: AbortSignal): Promise<{ text: string; usage?: ModelUsage }> {
    let completedText: string | undefined
    let usage: ModelUsage | undefined
    for await (const event of this.options.model.stream({
      messages: [
        { role: 'system', content: summarySystemPrompt },
        { role: 'user', content: serializeForSummary(messages) },
      ],
      tools: [],
      ...(signal ? { signal } : {}),
    })) {
      if (event.type === 'completed') {
        completedText = event.response.content?.trim() || undefined
        usage = event.response.usage
      }
    }
    if (!completedText) throw new Error('上下文摘要模型没有返回文本')
    return { text: completedText, ...(usage ? { usage } : {}) }
  }
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((total, message) => {
    const content = message.content ?? ''
    // 同时参考字符数和 UTF-8 字节数，对中文等多字节文本采用更保守的估算。
    const contentTokens = Math.max(content.length, Math.ceil(Buffer.byteLength(content, 'utf8') / 4))
    const toolTokens = Math.ceil(JSON.stringify(message.tool_calls ?? []).length / 4)
    return total + contentTokens + toolTokens + 12
  }, 0)
}

function groupConversation(messages: Message[]): Message[][] {
  // 只在新 user 消息前切分，确保 assistant tool_call 与紧随其后的 tool result 不被拆开。
  const groups: Message[][] = []
  let current: Message[] = []
  for (const message of messages) {
    if (message.role === 'user' && current.length > 0) {
      groups.push(current)
      current = []
    }
    current.push(message)
  }
  if (current.length > 0) groups.push(current)
  return groups
}

function serializeForSummary(messages: Message[]): string {
  // providerData 可能包含供应商私有签名和大对象；摘要只需要供应商无关的可读投影。
  return messages
    .map((message) => {
      const toolCalls = message.tool_calls
        ?.map((call) => `${call.function.name}(${call.function.arguments})`)
        .join(', ')
      return [
        `[${message.role}]`,
        ...(message.content ? [message.content] : []),
        ...(toolCalls ? [`tool_calls: ${toolCalls}`] : []),
        ...(message.tool_call_id ? [`tool_call_id: ${message.tool_call_id}`] : []),
      ].join('\n')
    })
    .join('\n\n')
}

function unchanged(messages: Message[], estimatedTokens: number): CompactionResult {
  return {
    messages,
    changed: false,
    removedMessages: 0,
    estimatedTokensBefore: estimatedTokens,
    estimatedTokensAfter: estimatedTokens,
  }
}
