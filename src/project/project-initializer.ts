import path from 'node:path'
import type { ModelAdapter } from '../models/model-adapter.js'
import type { PermissionManager } from '../permissions/permission-manager.js'
import { WorkspaceFiles } from '../tools/workspace-files.js'

const maxSnapshotBytes = 120 * 1024
const maxFileBytes = 32 * 1024
const defaultIgnoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next'])
const maxProbeFiles = 400
const maxProbeBytes = 512 * 1024

export interface ProjectSnapshot {
  targetExists: boolean
  tree: string[]
  files: Array<{ path: string; content: string }>
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

  async inspect(): Promise<ProjectSnapshot> {
    const workspaceFiles = await this.files
    const rawEntries = (await workspaceFiles.list('.', 3)).map((entry) => entry.replaceAll(path.sep, '/')).sort()
    const gitignoreRules = await readGitignore(workspaceFiles)
    const entries = rawEntries.filter((entry) => !isIgnoredEntry(entry) && !isGitignored(entry, gitignoreRules))
    const selected = await selectMetadataFiles(entries, workspaceFiles)
    const files: Array<{ path: string; content: string }> = []
    let totalBytes = 0

    for (const filePath of selected) {
      if (totalBytes >= maxSnapshotBytes) break
      try {
        const content = await workspaceFiles.read(filePath, 1, 1_000)
        const clipped = content.slice(0, Math.min(maxFileBytes, maxSnapshotBytes - totalBytes))
        files.push({ path: filePath, content: clipped })
        totalBytes += Buffer.byteLength(clipped, 'utf8')
      } catch {
        // 文件可能在扫描后被删除或变成不可读；项目树仍然可以用于生成草稿。
      }
    }

    return {
      targetExists: rawEntries.some((entry) => entry === 'PAWCODE.md'),
      tree: entries.slice(0, 600),
      files,
    }
  }

  async generate(snapshot: ProjectSnapshot): Promise<string> {
    if (snapshot.targetExists) throw new Error('项目根目录已存在 PAWCODE.md，为避免覆盖用户规则，本次未生成文件')

    const request = {
      messages: [
        {
          role: 'system' as const,
          content:
            '你是 PawCode 的项目初始化器。根据项目事实生成项目根目录 PAWCODE.md。只输出 Markdown，不要解释，不要使用代码围栏，不要编造事实，不要写入任何 API Key、密码、Token、环境变量值或其他敏感信息。文档必须以一级标题开头，并包含：项目用途、技术栈、目录结构、常用命令、开发约定、测试与验证、注意事项。',
        },
        {
          role: 'user' as const,
          content: JSON.stringify(snapshot, null, 2),
        },
      ],
      tools: [],
    }

    let generated = ''
    for await (const event of this.options.model.stream(request)) {
      if (event.type === 'text_delta') generated += event.text
      if (event.type === 'completed' && !generated && event.response.content) generated = event.response.content
    }

    const content = generated.trim()
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
      .map((line) => line.replace(/^\d+:\s?/, '').trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const negated = line.startsWith('!')
        const pattern = (negated ? line.slice(1) : line).replace(/^\//, '')
        return { pattern: pattern.replace(/\/$/, ''), negated, directoryOnly: line.endsWith('/') }
      })
      .filter((rule) => rule.pattern.length > 0)
  } catch {
    return []
  }
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
  const hasSlash = pattern.includes('/')
  const expression = globExpression(pattern)
  if (!hasSlash) {
    return segments.some((segment) => new RegExp(`^${expression}$`).test(segment))
  }
  return new RegExp(`^${expression}${directoryOnly ? '(?:/.*)?' : ''}$`).test(normalizedEntry)
}

function globExpression(pattern: string): string {
  let expression = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? ''
    if (character === '*' && pattern[index + 1] === '*') {
      expression += '.*'
      index += 1
    } else if (character === '*') {
      expression += '[^/]*'
    } else if (character === '?') {
      expression += '[^/]'
    } else {
      expression += escapeRegExp(character)
    }
  }
  return expression
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
  const suspiciousValue = /(?:api[_-]?key|secret|token|password|credential)\s*[:=]\s*[^\s<`]+/i
  const privateKey = /-----BEGIN [^-]*PRIVATE KEY-----/i
  const knownToken = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/
  if (suspiciousValue.test(content) || privateKey.test(content) || knownToken.test(content)) {
    throw new Error('生成内容疑似包含敏感凭据，已拒绝写入')
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}
