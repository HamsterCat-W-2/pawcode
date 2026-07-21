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
  ): Promise<DynamicContextProvider> {
    const context = await resolveContext(workspace, config, baseSystemPrompt, { targetPaths: ['.'] })
    return new DynamicContextProvider(workspace, config, baseSystemPrompt, context, fingerprint(context, ['.'], config))
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
      const nextFingerprint = fingerprint(next, targetPaths, this.config)
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

function fingerprint(context: ResolvedContext, targetPaths: string[], config: PawCodeConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        targetPaths,
        config,
        sources: context.sources.map((source) => ({ path: source.path, hash: source.hash, enabled: source.enabled })),
        disabledTools: context.disabledTools,
        diagnostics: context.diagnostics,
      }),
    )
    .digest('hex')
}
