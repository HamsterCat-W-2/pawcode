import type { Message } from '../domain/message.js'
import type { ModelResponse, ModelUsage } from '../domain/model.js'
import type { ModelAdapter } from '../models/model-adapter.js'
import type { ToolContext } from '../tools/tool.js'
import { ToolRegistry } from '../tools/tool-registry.js'
import type { AgentEvent } from './agent-event.js'

const systemPrompt = `你是 PawCode，一个运行在终端中的 AI 编程 Agent。
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
    // 一次用户请求可能包含多个模型—工具轮次，CLI 应展示整个 run 的合计值。
    let totalUsage: ModelUsage | undefined
    let stopReason: string | undefined

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

        totalUsage = addUsage(totalUsage, response.usage)
        stopReason = response.stopReason ?? stopReason

        this.messages.push({
          role: 'assistant',
          content: response.content,
          ...(response.toolCalls.length > 0 ? { tool_calls: response.toolCalls } : {}),
          ...(response.providerData !== undefined ? { providerData: response.providerData } : {}),
        })

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

function addUsage(current: ModelUsage | undefined, next: ModelUsage | undefined): ModelUsage | undefined {
  if (!next) return current
  if (!current) return next

  const currentCost = current.cost
  const nextCost = next.cost
  // 部分本地或自定义 Provider 没有成本数据；只有任一轮提供成本时才创建 cost。
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    cacheReadTokens: current.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens + next.cacheWriteTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    ...(currentCost || nextCost
      ? {
          cost: {
            input: (currentCost?.input ?? 0) + (nextCost?.input ?? 0),
            output: (currentCost?.output ?? 0) + (nextCost?.output ?? 0),
            cacheRead: (currentCost?.cacheRead ?? 0) + (nextCost?.cacheRead ?? 0),
            cacheWrite: (currentCost?.cacheWrite ?? 0) + (nextCost?.cacheWrite ?? 0),
            total: (currentCost?.total ?? 0) + (nextCost?.total ?? 0),
          },
        }
      : {}),
  }
}
