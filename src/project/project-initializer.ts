import path from 'node:path'
import type { ModelRequest } from '../domain/model.js'
import type { ModelAdapter } from '../models/model-adapter.js'
import type { PermissionManager } from '../permissions/permission-manager.js'
import { WorkspaceFiles } from '../tools/workspace-files.js'

const maxSnapshotBytes = 120 * 1024
const maxFileBytes = 32 * 1024
const defaultIgnoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next'])
const maxProbeFiles = 400
const maxProbeBytes = 512 * 1024
const fullMaxFiles = 2_000
const fullMaxFileBytes = 256 * 1024
const fullChunkBytes = 48 * 1024
const fullMaxChunks = 128

export type ProjectInitEvent =
  | { type: 'init_scan_started'; fileCount: number; chunkCount: number; diagnostics: ProjectDiagnostic[] }
  | { type: 'init_chunk_completed'; completed: number; total: number; chunkId: string }
  | { type: 'init_chunk_failed'; completed: number; total: number; chunkId: string; reason: string }
  | { type: 'init_generation_completed'; completedChunks: number; failedChunks: number }

export interface ProjectFile {
  path: string
  content: string
}

export interface ProjectChunk {
  id: string
  files: ProjectFile[]
}

export interface ProjectDiagnostic {
  path: string
  reason: string
}

export interface ProjectScanStats {
  mode: 'quick' | 'full'
  discoveredFiles: number
  ignoredFiles: number
  gitignoredFiles: number
  includedFiles: number
  selectedFiles: number
  chunkCount: number
  treeTruncated: boolean
}

export interface ProjectSnapshot {
  targetExists: boolean
  tree: string[]
  files: ProjectFile[]
  chunks?: ProjectChunk[]
  diagnostics?: ProjectDiagnostic[]
  stats: ProjectScanStats
}

export interface ProjectInitializerOptions {
  workspace: string
  model: ModelAdapter
  permissionManager: PermissionManager
}

/**
 * 扫描项目事实并生成 PAWCODE.md 的深模块。CLI 不需要知道敏感文件过滤、模型流收集和写入校验细节。
 */
export class ProjectInitializer {
  private readonly files: Promise<WorkspaceFiles>

  constructor(private readonly options: ProjectInitializerOptions) {
    this.files = WorkspaceFiles.create(options.workspace)
  }

  async inspect(mode: 'quick' | 'full' = 'quick', signal?: AbortSignal): Promise<ProjectSnapshot> {
    const workspaceFiles = await this.files
    signal?.throwIfAborted()
    const rawEntries = (await workspaceFiles.list('.', mode === 'full' ? 20 : 3))
      .map((entry) => entry.replaceAll(path.sep, '/'))
      .sort()
    const gitignoreRules = await readGitignore(workspaceFiles)
    const fileEntries = rawEntries.filter((entry) => !entry.endsWith('/'))
    const ignoredEntries = fileEntries.filter((entry) => isIgnoredEntry(entry))
    const gitignoredEntries = fileEntries.filter(
      (entry) => !isIgnoredEntry(entry) && isGitignored(entry, gitignoreRules),
    )
    const entries = rawEntries.filter((entry) => !isIgnoredEntry(entry) && !isGitignored(entry, gitignoreRules))
    const baseSnapshot = {
      targetExists: rawEntries.some((entry) => entry === 'PAWCODE.md'),
      tree: entries.slice(0, 2_000),
      stats: {
        mode,
        discoveredFiles: fileEntries.length,
        ignoredFiles: ignoredEntries.length,
        gitignoredFiles: gitignoredEntries.length,
        includedFiles: entries.filter((entry) => !entry.endsWith('/')).length,
        selectedFiles: 0,
        chunkCount: 0,
        treeTruncated: entries.length > 2_000,
      } satisfies ProjectScanStats,
    }
    if (mode === 'full') return this.inspectFull(workspaceFiles, entries, baseSnapshot, signal)

    const selected = await selectMetadataFiles(entries, workspaceFiles)
    const diagnostics: ProjectDiagnostic[] = []
    const files: ProjectFile[] = []
    let totalBytes = 0

    for (const filePath of selected) {
      if (totalBytes >= maxSnapshotBytes) {
        diagnostics.push({ path: '.', reason: `快速扫描达到 ${maxSnapshotBytes} bytes 上限，后续候选未读取` })
        break
      }
      try {
        const content = await workspaceFiles.read(filePath, 1, 1_000)
        const clipped = content.slice(0, Math.min(maxFileBytes, maxSnapshotBytes - totalBytes))
        files.push({ path: filePath, content: clipped })
        totalBytes += Buffer.byteLength(clipped, 'utf8')
        if (clipped.length < content.length) {
          diagnostics.push({ path: filePath, reason: `快速扫描内容超过 ${maxFileBytes} bytes，已截断` })
        }
      } catch (error) {
        // 文件可能在扫描后被删除或变成不可读；项目树仍然可以用于生成草稿。
        diagnostics.push({
          path: filePath,
          reason: `读取失败：${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }

    const tree = entries.slice(0, 600)
    return {
      ...baseSnapshot,
      tree,
      files,
      diagnostics,
      stats: { ...baseSnapshot.stats, selectedFiles: files.length, treeTruncated: entries.length > tree.length },
    }
  }

  async generate(snapshot: ProjectSnapshot): Promise<string> {
    if (snapshot.targetExists) throw new Error('项目根目录已存在 PAWCODE.md，为避免覆盖用户规则，本次未生成文件')

    return this.generateFromInput(snapshot, JSON.stringify(snapshot, null, 2))
  }

  async generateFull(
    snapshot: ProjectSnapshot,
    onEvent?: (event: ProjectInitEvent) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    assertCanGenerate(snapshot)
    const chunks = snapshot.chunks ?? []
    const summaries: Array<{ chunkId: string; summary: string }> = []
    let failedChunks = 0
    onEvent?.({
      type: 'init_scan_started',
      fileCount: chunks.reduce((count, chunk) => count + chunk.files.length, 0),
      chunkCount: chunks.length,
      diagnostics: snapshot.diagnostics ?? [],
    })

    for (let index = 0; index < chunks.length; index += 1) {
      signal?.throwIfAborted()
      const chunk = chunks[index]
      if (!chunk) continue
      try {
        const summary = await this.summarizeChunk(chunk, signal)
        summaries.push({ chunkId: chunk.id, summary })
        onEvent?.({ type: 'init_chunk_completed', completed: index + 1, total: chunks.length, chunkId: chunk.id })
      } catch (error) {
        failedChunks += 1
        const reason = error instanceof Error ? error.message : String(error)
        onEvent?.({ type: 'init_chunk_failed', completed: index + 1, total: chunks.length, chunkId: chunk.id, reason })
      }
    }

    onEvent?.({ type: 'init_generation_completed', completedChunks: summaries.length, failedChunks })
    const input = JSON.stringify(
      {
        tree: snapshot.tree,
        metadata: snapshot.files,
        summaries,
        diagnostics: [
          ...(snapshot.diagnostics ?? []),
          ...(failedChunks > 0 ? [{ path: '.', reason: `${failedChunks} 个分块摘要失败` }] : []),
        ],
      },
      null,
      2,
    )
    return this.generateFromInput(snapshot, input, signal)
  }

  private async inspectFull(
    files: WorkspaceFiles,
    entries: string[],
    baseSnapshot: Pick<ProjectSnapshot, 'targetExists' | 'tree' | 'stats'>,
    signal?: AbortSignal,
  ): Promise<ProjectSnapshot> {
    const fileEntries = entries.filter((entry) => !entry.endsWith('/'))
    const diagnostics: ProjectDiagnostic[] = []
    if (fileEntries.length > fullMaxFiles) {
      diagnostics.push({
        path: '.',
        reason: `文件数量超过完整扫描上限，已跳过 ${fileEntries.length - fullMaxFiles} 个文件`,
      })
    }
    const chunks: ProjectChunk[] = []
    const chunkCounts = new Map<string, number>()
    const lastChunkByDirectory = new Map<string, ProjectChunk>()
    for (const filePath of fileEntries.slice(0, fullMaxFiles)) {
      signal?.throwIfAborted()
      const parts = await readFullFile(files, filePath, signal)
      if (parts.diagnostic) diagnostics.push({ path: filePath, reason: parts.diagnostic })
      if (parts.chunks.length === 0) continue
      for (const part of parts.chunks) {
        if (chunks.length >= fullMaxChunks) {
          diagnostics.push({ path: filePath, reason: '达到完整扫描分块上限，后续内容未加入模型输入' })
          return {
            ...baseSnapshot,
            files: [],
            chunks,
            diagnostics,
            stats: {
              ...baseSnapshot.stats,
              selectedFiles: chunks.reduce((count, chunk) => count + chunk.files.length, 0),
              chunkCount: chunks.length,
            },
          }
        }
        const directory = path.posix.dirname(filePath)
        const previous = lastChunkByDirectory.get(directory)
        if (previous && byteLength(previous.files) + Buffer.byteLength(part.content, 'utf8') <= fullChunkBytes) {
          previous.files.push(part)
        } else {
          const count = (chunkCounts.get(directory) ?? 0) + 1
          const next = { id: `${directory}#${count}`, files: [part] }
          chunks.push(next)
          lastChunkByDirectory.set(directory, next)
          chunkCounts.set(directory, count)
        }
      }
    }
    return {
      ...baseSnapshot,
      files: [],
      chunks,
      diagnostics,
      stats: {
        ...baseSnapshot.stats,
        selectedFiles: chunks.reduce((count, chunk) => count + chunk.files.length, 0),
        chunkCount: chunks.length,
      },
    }
  }

  private async summarizeChunk(chunk: ProjectChunk, signal?: AbortSignal): Promise<string> {
    const request = {
      messages: [
        {
          role: 'system' as const,
          content:
            '你是 PawCode 的项目分析器。只根据给定文件事实生成该模块的简洁 Markdown 摘要，不要编造，不要输出 API Key、密码、Token、私钥或环境变量值。必须说明模块职责、关键文件、数据流、开发命令、测试方式和未确认事项。',
        },
        { role: 'user' as const, content: JSON.stringify(chunk, null, 2) },
      ],
      tools: [],
      ...(signal ? { signal } : {}),
    }
    return collectModelText(this.options.model, request, '分块摘要为空')
  }

  private async generateFromInput(snapshot: ProjectSnapshot, input: string, signal?: AbortSignal): Promise<string> {
    assertCanGenerate(snapshot)
    const request = {
      messages: [
        {
          role: 'system' as const,
          content:
            '你是 PawCode 的项目初始化器。根据项目事实生成项目根目录 PAWCODE.md。只输出 Markdown，不要解释，不要使用代码围栏，不要编造事实，不要写入任何 API Key、密码、Token、环境变量值或其他敏感信息。文档必须以一级标题开头，并包含：项目用途、技术栈、目录结构、常用命令、开发约定、测试与验证、注意事项。',
        },
        {
          role: 'user' as const,
          content: input,
        },
      ],
      tools: [],
      ...(signal ? { signal } : {}),
    }

    const content = (await collectModelText(this.options.model, request, '模型没有生成项目上下文')).trim()
    if (!content) throw new Error('模型没有生成项目上下文')
    if (!content.startsWith('#')) throw new Error('模型生成的项目上下文不是有效 Markdown')
    assertSafeGeneratedContent(content)
    return `${content}\n`
  }

  async write(content: string, signal?: AbortSignal): Promise<string> {
    if (!content.trim().startsWith('#')) throw new Error('拒绝写入无效的项目上下文')
    assertSafeGeneratedContent(content)
    const permission = await this.options.permissionManager.authorize(
      {
        capability: 'write',
        tool: 'init',
        description: '创建项目上下文文件 PAWCODE.md',
        resource: 'PAWCODE.md',
      },
      signal,
    )
    if (!permission.allowed) throw new Error(`权限被拒绝：${permission.reason ?? '当前模式不允许写入'}`)
    return (await this.files).write('PAWCODE.md', content)
  }
}

interface FullFileReadResult {
  chunks: ProjectFile[]
  diagnostic?: string
}

async function readFullFile(
  files: WorkspaceFiles,
  filePath: string,
  signal?: AbortSignal,
): Promise<FullFileReadResult> {
  const chunks: ProjectFile[] = []
  let startLine = 1
  let totalBytes = 0
  let sawContent = false

  try {
    while (totalBytes < fullMaxFileBytes) {
      signal?.throwIfAborted()
      const batch = await files.read(filePath, startLine, 1_000)
      if (!batch) break
      if (batch.includes('\u0000')) return { chunks: [], diagnostic: '检测为二进制文件，未读取内容' }
      sawContent = true

      let current = ''
      for (const line of batch.split(/\r?\n/)) {
        const next = current ? `${current}\n${line}` : line
        if (Buffer.byteLength(next, 'utf8') > fullChunkBytes && current) {
          chunks.push({ path: filePath, content: current })
          current = line
        } else {
          current = next
        }
        totalBytes += Buffer.byteLength(line, 'utf8') + 1
        if (totalBytes >= fullMaxFileBytes) break
      }
      if (current) chunks.push({ path: filePath, content: current })

      const lineCount = batch.split(/\r?\n/).length
      if (lineCount < 1_000 || totalBytes >= fullMaxFileBytes) break
      startLine += lineCount
    }
  } catch (error) {
    return { chunks: [], diagnostic: error instanceof Error ? error.message : String(error) }
  }

  if (!sawContent) return { chunks: [], diagnostic: '空文件，未加入摘要输入' }
  const content = chunks.map((chunk) => chunk.content).join('\n')
  if (containsSensitiveContent(content)) return { chunks: [], diagnostic: '内容疑似包含敏感凭据，未加入模型输入' }
  if (totalBytes >= fullMaxFileBytes) return { chunks, diagnostic: `文件超过 ${fullMaxFileBytes} bytes，已截断` }
  return { chunks }
}

function byteLength(files: ProjectFile[]): number {
  return files.reduce((total, file) => total + Buffer.byteLength(file.content, 'utf8'), 0)
}

async function collectModelText(model: ModelAdapter, request: ModelRequest, emptyMessage: string): Promise<string> {
  let generated = ''
  for await (const event of model.stream(request)) {
    if (event.type === 'text_delta') generated += event.text
    if (event.type === 'completed' && !generated && event.response.content) generated = event.response.content
  }
  const content = generated.trim()
  if (!content) throw new Error(emptyMessage)
  return content
}

function assertCanGenerate(snapshot: ProjectSnapshot): void {
  if (snapshot.targetExists) throw new Error('项目根目录已存在 PAWCODE.md，为避免覆盖用户规则，本次未生成文件')
}

async function selectMetadataFiles(entries: string[], files: WorkspaceFiles): Promise<string[]> {
  const candidates = entries
    .filter((entry) => !entry.endsWith('/') && baseCandidateScore(entry) > 0)
    .slice(0, maxProbeFiles)
  const ranked: Array<{ path: string; score: number }> = []
  let probedBytes = 0

  for (const entry of candidates) {
    const baseScore = baseCandidateScore(entry)
    if (probedBytes >= maxProbeBytes) {
      ranked.push({ path: entry, score: baseScore })
      continue
    }
    try {
      const preview = await files.read(entry, 1, 120)
      const clipped = preview.slice(0, Math.min(8 * 1024, maxProbeBytes - probedBytes))
      probedBytes += Buffer.byteLength(clipped, 'utf8')
      if (clipped.includes('\u0000')) continue
      const score = baseScore + sizeCandidateScore(clipped) + contentCandidateScore(clipped)
      if (score >= 2) ranked.push({ path: entry, score })
    } catch {
      if (baseScore >= 3) ranked.push({ path: entry, score: baseScore })
    }
  }

  return ranked
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .map((item) => item.path)
}

function isIgnoredEntry(entry: string): boolean {
  return entry.split('/').some((part) => defaultIgnoredDirectories.has(part)) || isSensitivePath(entry)
}

interface GitignoreRule {
  pattern: string
  negated: boolean
  directoryOnly: boolean
}

async function readGitignore(files: WorkspaceFiles): Promise<GitignoreRule[]> {
  try {
    const content = await files.read('.gitignore', 1, 1_000)
    return content
      .split(/\r?\n/)
      .map(parseGitignoreLine)
      .filter((rule): rule is GitignoreRule => rule !== undefined)
      .filter((rule) => rule.pattern.length > 0)
  } catch {
    return []
  }
}

function parseGitignoreLine(line: string): GitignoreRule | undefined {
  const trimmed = trimGitignoreWhitespace(line.replace(/^\d+:\s?/, '').replace(/\r$/, ''))
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('\\#')) {
    if (!trimmed.startsWith('\\#')) return undefined
  }

  const negated = trimmed.startsWith('!')
  const rawPattern = negated ? trimmed.slice(1) : trimmed
  const directoryOnly = rawPattern.endsWith('/') && !isEscaped(rawPattern, rawPattern.length - 1)
  const withoutDirectoryMarker = directoryOnly ? rawPattern.slice(0, -1) : rawPattern
  const pattern = unescapeGitignore(withoutDirectoryMarker.replace(/^\//, ''))
  return { pattern, negated, directoryOnly }
}

function isGitignored(entry: string, rules: GitignoreRule[]): boolean {
  let ignored = false
  for (const rule of rules) {
    if (!matchesGitignorePattern(rule.pattern, entry, rule.directoryOnly)) continue
    ignored = !rule.negated
  }
  return ignored
}

function matchesGitignorePattern(pattern: string, entry: string, directoryOnly: boolean): boolean {
  const normalizedEntry = entry.replace(/\/$/, '')
  const segments = normalizedEntry.split('/').filter(Boolean)
  const patternSegments = pattern.split('/').filter(Boolean)
  if (patternSegments.length === 0) return false

  // 没有斜杠的规则可匹配任意层级；目录规则不能把同名普通文件误判为目录。
  if (patternSegments.length === 1) {
    const candidates = directoryOnly && !entry.endsWith('/') ? segments.slice(0, -1) : segments
    return candidates.some((segment) => matchGitignoreSegment(patternSegments[0] ?? '', segment))
  }

  return directoryOnly
    ? matchGitignorePrefix(patternSegments, segments)
    : matchGitignoreSegments(patternSegments, segments)
}

function matchGitignoreSegments(pattern: string[], entry: string[]): boolean {
  if (pattern.length === 0) return entry.length === 0
  const head = pattern[0]
  if (head === '**') {
    return (
      matchGitignoreSegments(pattern.slice(1), entry) ||
      (entry.length > 0 && matchGitignoreSegments(pattern, entry.slice(1)))
    )
  }
  return (
    entry.length > 0 &&
    matchGitignoreSegment(head ?? '', entry[0] ?? '') &&
    matchGitignoreSegments(pattern.slice(1), entry.slice(1))
  )
}

function matchGitignorePrefix(pattern: string[], entry: string[]): boolean {
  if (pattern.length === 0) return true
  const head = pattern[0]
  if (head === '**') {
    return (
      matchGitignorePrefix(pattern.slice(1), entry) ||
      (entry.length > 0 && matchGitignorePrefix(pattern, entry.slice(1)))
    )
  }
  return (
    entry.length > 0 &&
    matchGitignoreSegment(head ?? '', entry[0] ?? '') &&
    matchGitignorePrefix(pattern.slice(1), entry.slice(1))
  )
}

function matchGitignoreSegment(pattern: string, value: string): boolean {
  let expression = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? ''
    if (character === '*') expression += '.*'
    else if (character === '?') expression += '.'
    else expression += escapeRegExp(character)
  }
  return new RegExp(`^${expression}$`).test(value)
}

function trimGitignoreWhitespace(line: string): string {
  let start = 0
  while (start < line.length && /\s/.test(line[start] ?? '')) start += 1
  let end = line.length
  while (end > start && /\s/.test(line[end - 1] ?? '') && !isEscaped(line, end - 1)) end -= 1
  return line.slice(start, end)
}

function unescapeGitignore(pattern: string): string {
  return pattern.replace(/\\([#! ])/g, '$1')
}

function isEscaped(value: string, index: number): boolean {
  let slashCount = 0
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashCount += 1
  return slashCount % 2 === 1
}

function baseCandidateScore(entry: string): number {
  if (isSensitivePath(entry)) return 0
  const basename = path.posix.basename(entry).toLowerCase()
  const relativeDirectory = path.posix.dirname(entry)
  let score = relativeDirectory === '.' ? 2 : 0
  if (/readme|config|lock|manifest|project|workspace|build|test|lint|format|settings|rules|tool/i.test(basename)) {
    score += 4
  }
  if (/^\.(github|gitlab|circleci)(?:\/|$)|(?:^|\/)(config|ci|docs|workflow)(?:\/|$)/i.test(entry)) score += 3
  if (basename.startsWith('.')) score += 1
  return score
}

function contentCandidateScore(content: string): number {
  const hints = [
    /scripts?|commands?|dependencies|devdependencies/i,
    /project|module|workspace|package|version|plugins?|tools?/i,
    /build|test|lint|format|compile|deploy|entry|include|exclude|extends/i,
  ]
  return hints.reduce((score, hint) => score + (hint.test(content) ? 1 : 0), 0)
}

function sizeCandidateScore(content: string): number {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes === 0 || bytes > maxFileBytes) return 0
  return bytes <= 8 * 1024 ? 1 : 0
}

function isSensitivePath(value: string): boolean {
  const basename = path.posix.basename(value).toLowerCase()
  if (basename.startsWith('.env')) return true
  if (['.pem', '.key', '.crt', '.cer', '.p12', '.pfx'].some((extension) => basename.endsWith(extension))) return true
  return ['secret', 'token', 'password', 'credential', 'private'].some((word) => basename.includes(word))
}

function assertSafeGeneratedContent(content: string): void {
  if (containsSensitiveContent(content)) {
    throw new Error('生成内容疑似包含敏感凭据，已拒绝写入')
  }
}

function containsSensitiveContent(content: string): boolean {
  const suspiciousValue = /(?:api[_-]?key|secret|token|password|credential)\s*[:=]\s*[^\s<`]+/i
  const privateKey = /-----BEGIN [^-]*PRIVATE KEY-----/i
  const knownToken = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/
  return suspiciousValue.test(content) || privateKey.test(content) || knownToken.test(content)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}
