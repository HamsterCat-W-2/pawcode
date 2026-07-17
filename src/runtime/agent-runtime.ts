import type { Message } from '../domain/message.js'
import type { ModelResponse } from '../domain/model.js'
import type { ModelAdapter } from '../models/model-adapter.js'
import type { ToolContext } from '../tools/tool.js'
import { ToolRegistry } from '../tools/tool-registry.js'
import type { AgentEvent } from './agent-event.js'

const systemPrompt = `你是 PawCode，一个运行在终端中的只读编程 Agent。
需要了解项目时，必须使用工具读取真实文件，不要猜测。
你只能查看文件，不能修改文件或执行命令。
完成调查后用简洁中文回答，并指出作为依据的文件。`

export interface AgentRuntimeOptions {
  model: ModelAdapter
  tools: ToolRegistry
  toolContext: ToolContext
  maxTurns: number
}

export class AgentRuntime {
  private messages: Message[] = this.initialMessages()

  constructor(private readonly options: AgentRuntimeOptions) {}

  clear(): void {
    this.messages = this.initialMessages()
  }

  messageCount(): number {
    return this.messages.length
  }

  // 事件流把 Agent 的执行过程与终端展示分离，未来可以复用到 TUI 或 JSON 输出。
  async *run(prompt: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const input = prompt.trim()
    if (!input) {
      yield { type: 'failed', error: new Error('输入不能为空') }
      return
    }

    this.messages.push({ role: 'user', content: input })

    try {
      for (let turn = 1; turn <= this.options.maxTurns; turn += 1) {
        yield { type: 'turn_started', turn }

        let response: ModelResponse | undefined

        for await (const event of this.options.model.stream({
          // 传递快照，避免适配器持有内部数组后被后续消息追加所影响。
          messages: [...this.messages],
          tools: this.options.tools.definitions(),
          ...(signal ? { signal } : {}),
        })) {
          switch (event.type) {
            case 'text_delta':
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

        this.messages.push({
          role: 'assistant',
          content: response.content,
          ...(response.toolCalls.length > 0 ? { tool_calls: response.toolCalls } : {}),
          ...(response.providerData !== undefined ? { providerData: response.providerData } : {}),
        })

        if (response.toolCalls.length === 0) {
          yield { type: 'completed', text: response.content ?? '模型没有返回文本' }
          return
        }

        for (const call of response.toolCalls) {
          yield {
            type: 'tool_started',
            name: call.function.name,
            argumentsJson: call.function.arguments,
          }

          const result = await this.options.tools.execute(
            call.function.name,
            call.function.arguments,
            this.options.toolContext,
          )

          this.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: result,
          })
          yield { type: 'tool_finished', name: call.function.name, result }
        }
      }

      yield {
        type: 'failed',
        error: new Error(`达到最大 Agent 轮数 ${this.options.maxTurns}`),
      }
    } catch (error) {
      yield {
        type: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }

  private initialMessages(): Message[] {
    return [{ role: 'system', content: systemPrompt }]
  }
}
