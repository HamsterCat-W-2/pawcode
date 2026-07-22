import { mkdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { atomicWriteFile } from '../filesystem/atomic-file.js'
import { ensureUserConfigDirectory } from '../config/config-loader.js'

const memoryFileSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(
      z
        .object({
          id: z.string().regex(/^mem_[A-Za-z0-9_-]{8,80}$/),
          content: z.string().min(1).max(4_096),
          createdAt: z.string().datetime(),
          updatedAt: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict()

const maxEntries = 100
const maxFileBytes = 64 * 1024
const sensitiveMemoryPattern = /(api[_ -]?key|password|passwd|secret|token|private\s+key|-----begin)/i

export type MemoryScope = 'user' | 'project'

export interface MemoryEntry {
  id: string
  content: string
  createdAt: string
  updatedAt: string
}

export interface MemoryReadResult {
  scope: MemoryScope
  path: string
  entries: MemoryEntry[]
  diagnostic?: string
}

export class PersistentMemoryStore {
  private constructor(
    private readonly workspace: string,
    private readonly homeDirectory: string,
  ) {}

  static create(workspace: string, homeDirectory = os.homedir()): PersistentMemoryStore {
    return new PersistentMemoryStore(path.resolve(workspace), path.resolve(homeDirectory))
  }

  async read(scope: MemoryScope): Promise<MemoryReadResult> {
    const filePath = this.filePath(scope)
    try {
      const info = await stat(filePath)
      if (!info.isFile()) throw new Error('目标不是普通文件')
      if (info.size > maxFileBytes) throw new Error(`记忆文件超过 ${maxFileBytes} bytes`)
      const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
      const result = memoryFileSchema.safeParse(parsed)
      if (!result.success) {
        const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
        throw new Error(`schema 校验失败：${details}`)
      }
      return { scope, path: filePath, entries: result.data.entries }
    } catch (error) {
      if (isMissingPathError(error)) return { scope, path: filePath, entries: [] }
      return {
        scope,
        path: filePath,
        entries: [],
        diagnostic: `记忆文件未加载：${filePath}：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  async list(): Promise<MemoryReadResult[]> {
    return Promise.all([this.read('user'), this.read('project')])
  }

  async add(scope: MemoryScope, content: string): Promise<MemoryEntry> {
    const normalized = validateMemoryContent(content)

    const current = await this.read(scope)
    if (current.diagnostic) throw new Error(current.diagnostic)
    if (current.entries.length >= maxEntries) throw new Error(`记忆条目不能超过 ${maxEntries} 条`)
    const now = new Date().toISOString()
    const entry: MemoryEntry = {
      id: `mem_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      content: normalized,
      createdAt: now,
      updatedAt: now,
    }
    await this.write(scope, [...current.entries, entry])
    return entry
  }

  async update(scope: MemoryScope, id: string, content: string): Promise<MemoryEntry> {
    assertMemoryId(id)
    const normalized = validateMemoryContent(content)
    const current = await this.read(scope)
    if (current.diagnostic) throw new Error(current.diagnostic)
    const existing = current.entries.find((entry) => entry.id === id)
    if (!existing) throw new Error(`找不到记忆：${id}`)
    const updated: MemoryEntry = {
      ...existing,
      content: normalized,
      updatedAt: new Date().toISOString(),
    }
    await this.write(
      scope,
      current.entries.map((entry) => (entry.id === id ? updated : entry)),
    )
    return updated
  }

  async remove(scope: MemoryScope, id: string): Promise<void> {
    assertMemoryId(id)
    const current = await this.read(scope)
    if (current.diagnostic) throw new Error(current.diagnostic)
    const next = current.entries.filter((entry) => entry.id !== id)
    if (next.length === current.entries.length) throw new Error(`找不到记忆：${id}`)
    await this.write(scope, next)
  }

  async clear(scope: MemoryScope): Promise<void> {
    const current = await this.read(scope)
    if (current.diagnostic) throw new Error(current.diagnostic)
    await this.write(scope, [])
  }

  private async write(scope: MemoryScope, entries: MemoryEntry[]): Promise<void> {
    const serialized = `${JSON.stringify({ version: 1, entries }, null, 2)}\n`
    if (Buffer.byteLength(serialized, 'utf8') > maxFileBytes) throw new Error(`记忆文件不能超过 ${maxFileBytes} bytes`)
    const target = this.filePath(scope)
    if (scope === 'user') await ensureUserConfigDirectory(this.homeDirectory)
    else await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await atomicWriteFile(target, serialized, { mode: 0o600 })
  }

  private filePath(scope: MemoryScope): string {
    return scope === 'user'
      ? path.join(this.homeDirectory, '.pawcode', 'memory.json')
      : path.join(this.workspace, '.pawcode', 'memory.json')
  }
}

function validateMemoryContent(content: string): string {
  const normalized = content.trim()
  if (!normalized) throw new Error('记忆内容不能为空')
  if (normalized.length > 4_096) throw new Error('单条记忆不能超过 4096 个字符')
  if (sensitiveMemoryPattern.test(normalized)) {
    throw new Error('记忆内容疑似包含敏感的密钥、Token、密码或私钥，拒绝保存')
  }
  return normalized
}

function assertMemoryId(id: string): void {
  if (!/^mem_[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error(`非法记忆 ID：${id}`)
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
