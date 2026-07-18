import type { Message } from '../domain/message.js'
import { addModelUsage, type ModelResponse, type ModelUsage } from '../domain/model.js'
import type { ModelAdapter } from '../models/model-adapter.js'
import type { ToolContext } from '../tools/tool.js'
import { ToolRegistry } from '../tools/tool-registry.js'
import type { AgentEvent } from './agent-event.js'
import type { ContextCompactor } from './context-compactor.js'

export const systemPrompt = `你是 PawCode，一个运行在终端中的 AI 编程 Agent。
需要了解项目时，必须使用工具读取真实文件，不要猜测。
修改前先读取相关文件，小范围修改优先使用 apply_patch，创建或完整重写文件使用 write_file。
所有写入和命令都受权限系统控制；权限被拒绝时不要尝试绕过。
修改后使用 git_diff 检查差异，并根据项目配置运行格式、类型、测试和构建验证。
未经用户明确要求，不要提交、推送或执行破坏性 Git 操作。
完成后用简洁中文说明改动、验证结果和仍存在的风险。`

export interface AgentRuntimeOptions {
  model: ModelAdapter
  tools: ToolRegistry
  toolContext: ToolContext
  maxTurns: number
  initialMessages?: Message[]
  compactor?: ContextCompactor
  onMessagesChanged?: (messages: Message[]) => Promise<void>
  onContextCompacted?: () => Promise<void>
}

export class AgentRuntime {
  private messages: Message[]

  constructor(private readonly options: AgentRuntimeOptions) {
    this.messages = structuredClone(options.initialMessages ?? this.initialMessages())
  }

  async clear(): Promise<void> {
    this.messages = this.initialMessages()
    await this.notifyMessagesChanged()
  }

  messageCount(): number {
    return this.messages.length
  }

  messagesSnapshot(): Message[] {
    return structuredClone(this.messages)
  }

  // 事件流把 Agent 的执行过程与终端展示分离，未来可以复用到 TUI 或 JSON 输出。
  async *run(prompt: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const input = prompt.trim()
    if (!input) {
      yield { type: 'failed', error: new Error('输入不能为空') }
      return
    }

    // 一次用户请求可能包含多个模型—工具轮次，CLI 应展示整个 run 的合计值。
    let totalUsage: ModelUsage | undefined
    let stopReason: string | undefined
    let pendingAssistantText = ''

    try {
      this.messages.push({ role: 'user', content: input })
      await this.notifyMessagesChanged()

      if (this.options.compactor) {
        const compaction = await this.options.compactor.compactIfNeeded(this.messages, signal)
        if (compaction.error) {
          yield { type: 'context_compaction_failed', error: compaction.error }
        } else if (compaction.changed) {
          this.messages = compaction.messages
          totalUsage = addModelUsage(totalUsage, compaction.usage)
          await this.notifyMessagesChanged()
          await this.options.onContextCompacted?.()
          yield {
            type: 'context_compacted',
            removedMessages: compaction.removedMessages,
            estimatedTokensBefore: compaction.estimatedTokensBefore,
            estimatedTokensAfter: compaction.estimatedTokensAfter,
          }
        }
      }

      for (let turn = 1; turn <= this.options.maxTurns; turn += 1) {
        yield { type: 'turn_started', turn }
        pendingAssistantText = ''

        let response: ModelResponse | undefined

        for await (const event of this.options.model.stream({
          // 传递快照，避免适配器持有内部数组后被后续消息追加所影响。
          messages: [...this.messages],
          tools: this.options.tools.definitions(),
          ...(signal ? { signal } : {}),
        })) {
          switch (event.type) {
            case 'text_delta':
              pendingAssistantText += event.text
              yield { type: 'text_delta', text: event.text }
              break
            case 'thinking_delta':
              yield { type: 'thinking_delta', text: event.text }
              break
            case 'completed':
              response = event.response
              break
            case 'tool_call':
              // 工具只在完整 response 到达后统一执行，确保会话先保存 assistant 消息。
              break
          }
        }

        if (!response) {
          throw new Error('模型流结束时缺少 completed 事件')
        }

        totalUsage = addModelUsage(totalUsage, response.usage)
        stopReason = response.stopReason ?? stopReason

        this.messages.push({
          role: 'assistant',
          content: response.content,
          ...(response.toolCalls.length > 0 ? { tool_calls: response.toolCalls } : {}),
          ...(response.providerData !== undefined ? { providerData: response.providerData } : {}),
        })
        // 完整 response 已进入历史，后续错误不能再把流式文本作为“部分回答”重复保存。
        pendingAssistantText = ''
        await this.notifyMessagesChanged()

        if (response.toolCalls.length === 0) {
          yield {
            type: 'completed',
            text: response.content ?? '模型没有返回文本',
            ...(totalUsage ? { usage: totalUsage } : {}),
            ...(stopReason ? { stopReason } : {}),
          }
          return
        }

        for (const call of response.toolCalls) {
          yield {
            type: 'tool_started',
            name: call.function.name,
            argumentsJson: call.function.arguments,
          }

          const result = await this.options.tools.execute(call.function.name, call.function.arguments, {
            ...this.options.toolContext,
            ...(signal ? { signal } : {}),
          })

          this.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: result,
          })
          await this.notifyMessagesChanged()
          yield { type: 'tool_finished', name: call.function.name, result }
        }
      }

      yield {
        type: 'failed',
        error: new Error(`达到最大 Agent 轮数 ${this.options.maxTurns}`),
      }
    } catch (error) {
      if (pendingAssistantText) {
        // 供应商流在 completed 前失败时仍保留用户已经看到的文本，恢复会话不会凭空丢失半段回答。
        this.messages.push({ role: 'assistant', content: pendingAssistantText })
        await this.notifyMessagesChanged()
      }
      if (signal?.aborted) {
        yield { type: 'cancelled', ...(pendingAssistantText ? { text: pendingAssistantText } : {}) }
        return
      }
      yield {
        type: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }

  private initialMessages(): Message[] {
    return createInitialMessages()
  }

  private async notifyMessagesChanged(): Promise<void> {
    if (this.options.onMessagesChanged) {
      await this.options.onMessagesChanged(this.messagesSnapshot())
    }
  }
}

export function createInitialMessages(): Message[] {
  return [{ role: 'system', content: systemPrompt }]
}
