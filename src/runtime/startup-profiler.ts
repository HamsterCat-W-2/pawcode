import { performance } from 'node:perf_hooks'

export interface StartupMark {
  name: string
  elapsedMs: number
}

/**
 * 只在显式开启时记录启动阶段，避免普通 CLI 路径产生额外输出和可见开销。
 */
export class StartupProfiler {
  private readonly startedAt = performance.now()
  private lastMarkAt = this.startedAt
  private readonly marks: StartupMark[] = []

  constructor(private readonly enabled: boolean) {}

  mark(name: string): void {
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
    if (!this.enabled) return
    this.marks.push({ name, elapsedMs: roundMilliseconds(elapsedMs) })
  }

  report(): string {
    if (!this.enabled) return ''
    const lines = this.marks.map((mark) => `- ${mark.name}: ${mark.elapsedMs}ms`)
    lines.push(`- total: ${roundMilliseconds(performance.now() - this.startedAt)}ms`)
    return `PawCode 启动耗时\n${lines.join('\n')}`
  }
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100
}
