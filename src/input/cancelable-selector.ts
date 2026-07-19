import { stdin, stdout } from 'node:process'
import { emitKeypressEvents } from 'node:readline'
import { createInterface } from 'node:readline/promises'
import { isReadlineKeyboardInterrupt } from './readline-errors.js'

type ReadlineInterface = ReturnType<typeof createInterface>

export type SelectionResult<T> = { status: 'selected'; value: T } | { status: 'cancelled' }

export interface CancelableSelectorOptions<T> {
  items: readonly T[]
  renderItem: (item: T, index: number) => string
  heading: string
  prompt?: string
  invalidMessage?: (answer: string) => string
  readline?: ReadlineInterface
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  signal?: AbortSignal
  onActiveChange?: (active: boolean) => void
}

/**
 * 统一的终端列表选择器。
 *
 * 调用方只处理 selected/cancelled 业务结果；Esc 解析、AbortSignal 联动、无效输入重试和
 * 临时监听器清理由本模块负责，避免每个命令各自实现一套略有差异的键盘行为。
 */
export async function selectFromList<T>(options: CancelableSelectorOptions<T>): Promise<SelectionResult<T>> {
  if (options.items.length === 0) throw new Error('没有可选择的项目')
  // 调用方已经取消时不能再创建 readline、注册监听或输出列表，避免 Ctrl+C 后界面“死灰复燃”。
  if (options.signal?.aborted) return { status: 'cancelled' }

  const input = options.input ?? stdin
  const output = options.output ?? stdout
  const ownsReadline = options.readline === undefined
  const readline = options.readline ?? createInterface({ input, output })
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort()
  const handleKeypress = (_value: string, key: { name?: string }) => {
    if (key.name === 'escape') controller.abort()
  }
  let keypressAttached = false
  let activeNotified = false
  let operationFailed = false

  try {
    options.signal?.addEventListener('abort', abortFromCaller, { once: true })

    // emitKeypressEvents 可重复调用；Node 会复用同一输入流的解析器。这里只在选择期间监听 Esc。
    emitKeypressEvents(input, readline)
    input.on('keypress', handleKeypress)
    keypressAttached = true
    if (options.onActiveChange) {
      // 先记录“需要对称关闭”，即使 true 回调修改状态后抛错，finally 仍会尝试发送 false。
      activeNotified = true
      options.onActiveChange(true)
    }

    // 渲染也必须位于 finally 保护范围内；自定义 renderItem/output 失败时仍要释放终端监听。
    output.write(`${options.heading}\n`)
    options.items.forEach((item, index) => output.write(`${index + 1}. ${options.renderItem(item, index)}\n`))

    while (true) {
      let answer: string
      try {
        answer = (
          await readline.question(options.prompt ?? '输入序号（Esc 取消）：', { signal: controller.signal })
        ).trim()
      } catch (error) {
        // Node 可能把 Ctrl+C 直接作为 question rejection；它与 Esc 一样是用户主动取消，不是启动失败。
        if (controller.signal.aborted || isReadlineKeyboardInterrupt(error)) return { status: 'cancelled' }
        throw error
      }

      const index = Number(answer) - 1
      if (Number.isInteger(index) && index >= 0 && index < options.items.length) {
        // 合法性由索引边界决定；T 本身可以包含 undefined，不能用元素值判断是否命中。
        return { status: 'selected', value: options.items[index] as T }
      }

      const message = options.invalidMessage?.(answer) ?? `无效的序号：${answer}`
      output.write(`${message}\n`)
    }
  } catch (error) {
    operationFailed = true
    throw error
  } finally {
    options.signal?.removeEventListener('abort', abortFromCaller)
    let cleanupError: unknown
    const cleanup = (action: () => void) => {
      try {
        action()
      } catch (error) {
        // 所有清理动作都要继续执行；仅保留第一个清理错误供成功路径报告。
        cleanupError ??= error
      }
    }
    cleanup(() => {
      if (keypressAttached) input.removeListener('keypress', handleKeypress)
    })
    cleanup(() => {
      if (ownsReadline) readline.close()
    })
    cleanup(() => {
      if (activeNotified) options.onActiveChange?.(false)
    })
    // 业务/渲染错误优先，不能被清理回调覆盖；成功路径则不能静默吞掉清理失败。
    if (!operationFailed && cleanupError !== undefined) throw cleanupError
  }
}
