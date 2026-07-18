/**
 * 区分“等待用户输入”和“正在执行模型请求”时的 SIGINT 语义。
 *
 * 输入提示处的 Ctrl+C 请求退出整个交互会话；模型运行期间的 Ctrl+C 由 renderRun
 * 自己的 AbortController 处理，只取消当前请求，不能同时触发退出提示和关闭 readline。
 */
export class InteractiveSignalState {
  private runController: AbortController | undefined
  private exitRequested = false

  beginRun(): AbortController {
    const controller = new AbortController()
    this.runController = controller
    return controller
  }

  endRun(): void {
    this.runController = undefined
  }

  interruptRun(): boolean {
    if (!this.runController || this.runController.signal.aborted) return false
    this.runController.abort()
    return true
  }

  requestKeyboardExit(): boolean {
    if (this.runController || this.exitRequested) return false
    this.exitRequested = true
    return true
  }

  shouldExit(): boolean {
    return this.exitRequested
  }
}

/** Node readline/promises 在 question 等待期间收到 Ctrl+C 时会直接 reject，而不一定触发 process SIGINT。 */
export function isReadlineKeyboardInterrupt(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Ctrl+C')
}
