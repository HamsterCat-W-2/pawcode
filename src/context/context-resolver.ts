import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { PawCodeConfig } from '../config/config.js'
import { PersistentMemoryStore, type MemoryReadResult } from '../memory/memory-store.js'
import type { ContextSource, ResolvedContext } from './context-types.js'

interface ResolveContextOptions {
  homeDirectory?: string
  targetPath?: string
  targetPaths?: string[]
}

interface LoadedInstruction {
  source: ContextSource
  content: string
}

/**
 * 只负责发现和合并项目上下文，不修改 SessionRecord。上下文每次启动按当前文件 hash 重建，
 * 避免私有规则进入历史回放或上下文压缩。
 */
export async function resolveContext(
  workspace: string,
  config: PawCodeConfig,
  baseSystemPrompt: string,
  options: ResolveContextOptions = {},
): Promise<ResolvedContext> {
  const root = await realpath(workspace)
  const diagnostics: string[] = []
  const loaded: LoadedInstruction[] = []
  const seen = new Set<string>()
  const home = path.resolve(options.homeDirectory ?? os.homedir())

  await loadInstruction(
    path.join(home, '.pawcode', 'PAWCODE.md'),
    'user',
    undefined,
    root,
    loaded,
    seen,
    config,
    diagnostics,
  )
  const memoryStore = PersistentMemoryStore.create(root, home)
  const userMemory = await memoryStore.read('user')
  appendMemory(userMemory, loaded, diagnostics)

  const requestedTargets = options.targetPaths ?? (options.targetPath ? [options.targetPath] : [undefined])
  const resolvedTargets: Array<string | undefined> = []
  for (const targetPath of requestedTargets) {
    const target = await resolveTarget(root, targetPath, diagnostics)
    resolvedTargets.push(target)
    const targetParent = target && (await isDirectory(target)) ? target : target ? path.dirname(target) : root
    const directories = ancestors(root, targetParent)
    for (const directory of directories) {
      await loadInstruction(
        path.join(directory, 'PAWCODE.md'),
        'project',
        relativePath(root, directory),
        root,
        loaded,
        seen,
        config,
        diagnostics,
      )
      if (config.instructions.includeAgentsMd) {
        await loadInstruction(
          path.join(directory, 'AGENTS.md'),
          'project',
          relativePath(root, directory),
          root,
          loaded,
          seen,
          config,
          diagnostics,
        )
      }
    }
  }

  for (const relativeFile of config.instructions.files) {
    if (path.isAbsolute(relativeFile) || !isSafeRelativePath(relativeFile)) {
      diagnostics.push(`忽略不安全的上下文文件路径：${relativeFile}`)
      continue
    }
    await loadInstruction(
      path.join(root, relativeFile),
      'project',
      relativeFile,
      root,
      loaded,
      seen,
      config,
      diagnostics,
    )
  }
  const projectMemory = await memoryStore.read('project')
  appendMemory(projectMemory, loaded, diagnostics)

  const matchingRules = resolvedTargets.flatMap((target) => {
    const relativeTarget = target ? relativePath(root, target) : ''
    return config.context.pathRules
      .filter((rule) => globMatches(rule.pattern, relativeTarget))
      .map((rule) => ({ rule, relativeTarget }))
  })
  const ruleInstructions = matchingRules
    .map(({ rule, relativeTarget }) =>
      rule.instructions ? `【路径规则：${relativeTarget || '.'}】\n${rule.instructions}` : undefined,
    )
    .filter((value): value is string => Boolean(value))
  const disabledTools = [...new Set(matchingRules.flatMap(({ rule }) => rule.disabledTools))]
  const sections = [
    baseSystemPrompt,
    ...loaded.map((entry) =>
      entry.source.kind === 'memory-user' || entry.source.kind === 'memory-project'
        ? `【持久化记忆：${entry.source.kind === 'memory-user' ? '用户级' : '项目级'}】\n${entry.content}`
        : `【项目上下文：${entry.source.path}】\n${entry.content}`,
    ),
    config.context.appendSystemPrompt,
    ...ruleInstructions,
  ].filter(Boolean)

  return {
    systemPrompt: sections.join('\n\n'),
    sources: loaded.map((entry) => entry.source),
    disabledTools,
    diagnostics,
  }
}

async function loadInstruction(
  filePath: string,
  kind: 'user' | 'project' | 'local',
  relative: string | undefined,
  workspaceRoot: string,
  loaded: LoadedInstruction[],
  seen: Set<string>,
  config: PawCodeConfig,
  diagnostics: string[],
): Promise<void> {
  const resolved = path.resolve(filePath)
  if (seen.has(resolved)) return
  seen.add(resolved)

  try {
    const resolvedFile = await realpath(resolved)
    if (kind !== 'user' && !isInside(workspaceRoot, resolvedFile)) {
      diagnostics.push(`上下文文件符号链接越过工作区边界，已跳过：${resolved}`)
      return
    }
    const info = await stat(resolvedFile)
    if (!info.isFile()) return
    if (info.size > config.instructions.maxFileBytes) {
      diagnostics.push(`上下文文件超过大小限制，已跳过：${resolvedFile}`)
      return
    }
    const content = await readFile(resolvedFile, 'utf8')
    loaded.push({
      source: {
        kind,
        path: resolvedFile,
        ...(relative ? { relativePath: relative } : {}),
        bytes: Buffer.byteLength(content, 'utf8'),
        hash: createHash('sha256').update(content).digest('hex'),
        enabled: true,
      },
      content,
    })
  } catch (error) {
    if (!isMissingPathError(error))
      diagnostics.push(`上下文文件读取失败：${resolved}：${error instanceof Error ? error.message : String(error)}`)
  }
}

function appendMemory(result: MemoryReadResult, loaded: LoadedInstruction[], diagnostics: string[]): void {
  if (result.diagnostic) {
    diagnostics.push(result.diagnostic)
    return
  }
  if (result.entries.length === 0) return
  const content = result.entries.map((entry) => `- [${entry.id}] ${entry.content}`).join('\n')
  loaded.push({
    source: {
      kind: result.scope === 'user' ? 'memory-user' : 'memory-project',
      path: result.path,
      bytes: Buffer.byteLength(content, 'utf8'),
      hash: createHash('sha256').update(content).digest('hex'),
      enabled: true,
    },
    content,
  })
}

async function resolveTarget(
  root: string,
  targetPath: string | undefined,
  diagnostics: string[],
): Promise<string | undefined> {
  if (!targetPath) return undefined
  if (path.isAbsolute(targetPath)) {
    diagnostics.push(`目标路径必须是工作区相对路径：${targetPath}`)
    return undefined
  }
  const candidate = path.resolve(root, targetPath)
  if (!isInside(root, candidate)) {
    diagnostics.push(`目标路径越过工作区边界：${targetPath}`)
    return undefined
  }
  try {
    const resolved = await realpath(candidate)
    if (!isInside(root, resolved)) diagnostics.push(`目标路径符号链接越过工作区边界：${targetPath}`)
    else return resolved
  } catch (error) {
    if (!isMissingPathError(error)) diagnostics.push(`目标路径解析失败：${targetPath}`)
  }
  return candidate
}

function ancestors(root: string, targetDirectory: string): string[] {
  const result: string[] = []
  let current = targetDirectory
  while (isInside(root, current)) {
    result.unshift(current)
    if (current === root) break
    current = path.dirname(current)
  }
  return result
}

function globMatches(pattern: string, value: string): boolean {
  const normalizedPattern = pattern.replaceAll('\\', '/')
  const normalizedValue = value.replaceAll('\\', '/')
  const expression = normalizedPattern.split('*').map(escapeRegExp).join('.*').replaceAll('\\.\\.\\.', '.*')
  return new RegExp(`^${expression}$`).test(normalizedValue)
}

function isSafeRelativePath(value: string): boolean {
  return value !== '' && !path.isAbsolute(value) && !value.split(/[\\/]+/).includes('..')
}

function relativePath(root: string, value: string): string {
  return path.relative(root, value).replaceAll(path.sep, '/') || '.'
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isDirectory()
  } catch {
    return false
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
