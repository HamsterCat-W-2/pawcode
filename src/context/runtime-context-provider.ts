import { createHash } from 'node:crypto'
import path from 'node:path'
import type { PawCodeConfig } from '../config/config.js'
import type { ContextTarget, ToolContext } from '../tools/tool.js'
import type { ResolvedContext } from './context-types.js'
import { resolveContext } from './context-resolver.js'

export interface ContextDecision {
  context: ResolvedContext
  targetPaths: string[]
  disabled: boolean
  updated: boolean
  error?: Error
}

export interface RuntimeContextProvider {
  initial(): ResolvedContext
  current(): ResolvedContext
  beforeToolCall(
    toolName: string,
    argumentsJson: string,
    toolContext: ToolContext,
    targets: ContextTarget[],
  ): Promise<ContextDecision>
}

/**
 * 先提供启动快照，第一次工具调用前才实例化动态解析器。
 * 这样检查配置、显示上下文和进入交互提示都不会提前创建运行时上下文对象。
 */
export class DeferredContextProvider implements RuntimeContextProvider {
  private provider: RuntimeContextProvider | undefined
  private creating: Promise<RuntimeContextProvider> | undefined

  constructor(
    private readonly initialContext: ResolvedContext,
    private readonly createProvider: (context: ResolvedContext) => Promise<RuntimeContextProvider>,
  ) {}

  initial(): ResolvedContext {
    return this.current()
  }

  current(): ResolvedContext {
    return this.provider?.current() ?? structuredClone(this.initialContext)
  }

  async beforeToolCall(
    toolName: string,
    argumentsJson: string,
    toolContext: ToolContext,
    targets: ContextTarget[],
  ): Promise<ContextDecision> {
    const provider = await this.getProvider()
    return provider.beforeToolCall(toolName, argumentsJson, toolContext, targets)
  }

  private async getProvider(): Promise<RuntimeContextProvider> {
    if (this.provider) return this.provider
    this.creating ??= this.createProvider(this.initialContext)
    this.provider = await this.creating
    return this.provider
  }
}

export class DynamicContextProvider implements RuntimeContextProvider {
  private constructor(
    private readonly workspace: string,
    private readonly config: PawCodeConfig,
    private readonly baseSystemPrompt: string,
    private readonly currentContext: ResolvedContext,
    private fingerprint: string,
  ) {}

  static async create(
    workspace: string,
    config: PawCodeConfig,
    baseSystemPrompt: string,
    initialContext?: ResolvedContext,
  ): Promise<DynamicContextProvider> {
    // CLI 启动时已经解析过根上下文；复用快照可以避免同一工作区启动阶段重复读盘。
    const context =
      initialContext ?? (await resolveContext(workspace, config, baseSystemPrompt, { targetPaths: ['.'] }))
    // 初始快照与后续工具快照使用同一“有效上下文”指纹；目标路径只是重新解析的输入，不是展示刷新的理由。
    return new DynamicContextProvider(workspace, config, baseSystemPrompt, context, fingerprint(context))
  }

  initial(): ResolvedContext {
    return this.current()
  }

  current(): ResolvedContext {
    return structuredClone(this.currentContext)
  }

  async beforeToolCall(
    toolName: string,
    _argumentsJson: string,
    _toolContext: ToolContext,
    targets: ContextTarget[],
  ): Promise<ContextDecision> {
    const targetPaths = normalizeTargets(this.workspace, targets)
    try {
      const next = await resolveContext(this.workspace, this.config, this.baseSystemPrompt, { targetPaths })
      // 即使每次工具目标不同，也必须重新解析路径规则；但只有解析结果改变才通知模型和终端。
      const nextFingerprint = fingerprint(next)
      const updated = nextFingerprint !== this.fingerprint
      if (updated) {
        this.replaceContext(next, nextFingerprint)
      }
      return {
        context: this.current(),
        targetPaths,
        disabled: next.disabledTools.includes(toolName),
        updated,
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      return {
        context: this.current(),
        targetPaths,
        disabled: this.currentContext.disabledTools.includes(toolName),
        updated: false,
        error: failure,
      }
    }
  }

  private replaceContext(next: ResolvedContext, nextFingerprint: string): void {
    Object.assign(this.currentContext, next)
    this.fingerprint = nextFingerprint
  }
}

function normalizeTargets(workspace: string, targets: ContextTarget[]): string[] {
  const values = targets.length > 0 ? targets.map((target) => target.path) : ['.']
  const normalizedTargets = [...new Set(values)]
    .map((value) => normalizeTarget(workspace, value))
    .filter((value): value is string => value !== undefined)
    .sort()
    .slice(0, 16)
  return normalizedTargets.length > 0 ? normalizedTargets : ['.']
}

function normalizeTarget(workspace: string, value: string): string | undefined {
  if (!value || path.isAbsolute(value)) return undefined
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'))
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return undefined
  return normalized || '.'
}

/**
 * 为“会影响后续模型请求或工具执行”的解析结果生成指纹。
 * targetPaths 和完整配置仅是计算输入：它们变化而结果不变时不应产生 `context_updated` 噪声。
 */
function fingerprint(context: ResolvedContext): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        // system prompt 覆盖正文、附加配置和命中路径规则，是模型可见上下文的完整投影。
        systemPrompt: context.systemPrompt,
        // 来源元数据仍参与比较，确保 CLI 的 addedSources/removedSources 事件与快照一致。
        sources: context.sources.map((source) => ({
          kind: source.kind,
          path: source.path,
          relativePath: source.relativePath,
          hash: source.hash,
          enabled: source.enabled,
          memoryEntries: source.memoryEntries,
          reason: source.reason,
        })),
        disabledTools: context.disabledTools,
        diagnostics: context.diagnostics,
      }),
    )
    .digest('hex')
}
