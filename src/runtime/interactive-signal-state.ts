/**
 * 区分“等待用户输入”和“正在执行模型请求”时的 SIGINT 语义。
 *
 * 输入提示处的 Ctrl+C 请求退出整个交互会话；模型运行期间的 Ctrl+C 由 renderRun
 * 自己的 AbortController 处理，只取消当前请求，不能同时触发退出提示和关闭 readline。
 */
export class InteractiveSignalState {
  private runController: AbortController | undefined
  private selectionController: AbortController | undefined
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

  beginSelection(): AbortController {
    const controller = new AbortController()
    this.selectionController = controller
    return controller
  }

  endSelection(): void {
    this.selectionController = undefined
  }

  requestKeyboardExit(): boolean {
    if (this.runController || this.exitRequested) return false
    this.exitRequested = true
    // Ctrl+C 仍然退出整个交互进程，同时释放可能正在等待序号的会话选择器。
    this.selectionController?.abort()
    return true
  }

  shouldExit(): boolean {
    return this.exitRequested
  }
}
