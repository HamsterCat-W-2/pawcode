import { performance } from 'node:perf_hooks'

export interface StartupMark {
  /** 展示给用户的阶段名称，例如 context 或 mcp.demo.initialize。 */
  name: string
  /** 该阶段相对上一个主流程 mark 或外部测量点的耗时。 */
  elapsedMs: number
}

/**
 * 只在显式开启时记录启动阶段，避免普通 CLI 路径产生额外输出和可见开销。
 */
export class StartupProfiler {
  /** CLI 启动开始时间，用于最终 total。 */
  private readonly startedAt = performance.now()
  /** 主流程 mark 的上一个时间点；外部 record 不修改它。 */
  private lastMarkAt = this.startedAt
  /** 按输出顺序保存所有主流程和外部模块耗时。 */
  private readonly marks: StartupMark[] = []

  /** enabled 只由 --verbose-startup 控制，普通启动不产生诊断输出。 */
  constructor(private readonly enabled: boolean) {}

  mark(name: string): void {
    // 禁用时直接返回，避免普通启动引入不必要的计时记录。
    if (!this.enabled) return
    const now = performance.now()
    this.marks.push({ name, elapsedMs: roundMilliseconds(now - this.lastMarkAt) })
    this.lastMarkAt = now
  }

  /**
   * 记录由其他模块测量出的独立耗时，例如并行 MCP Server 的阶段耗时。
   * 不更新 lastMarkAt，因为外部耗时与 CLI 主流程的连续阶段不是同一条时间线。
   */
  record(name: string, elapsedMs: number): void {
    // MCP 并行阶段由模块内部测量，不能用 mark 改变 CLI 主流程的时间基准。
    if (!this.enabled) return
    this.marks.push({ name, elapsedMs: roundMilliseconds(elapsedMs) })
  }

  report(): string {
    // 未开启诊断时返回空字符串，调用方无需额外分支处理。
    if (!this.enabled) return ''
    const lines = this.marks.map((mark) => `- ${mark.name}: ${mark.elapsedMs}ms`)
    lines.push(`- total: ${roundMilliseconds(performance.now() - this.startedAt)}ms`)
    return `PawCode 启动耗时\n${lines.join('\n')}`
  }
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100
}
