import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { sessionRecordSchema, type SessionRecord, type SessionSummary } from './session-schema.js'

/**
 * 当前项目的会话持久化边界。
 *
 * Store 自己固定 sessions 目录，并校验每条记录的 workspace，调用方不能借会话 ID
 * 指向任意路径，也不能把其他项目复制来的会话误恢复到当前项目。
 */
export class SessionStore {
  private constructor(
    private readonly workspace: string,
    private readonly sessionsDirectory: string,
  ) {}

  static async create(workspace: string): Promise<SessionStore> {
    // 使用 realpath 作为项目身份，避免同一目录通过符号链接产生两套互不一致的会话归属。
    const resolvedWorkspace = await realpath(workspace)
    const sessionsDirectory = path.join(resolvedWorkspace, '.pawcode', 'sessions')
    await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 })
    return new SessionStore(resolvedWorkspace, sessionsDirectory)
  }

  workspacePath(): string {
    return this.workspace
  }

  async save(record: SessionRecord): Promise<void> {
    // 在发生磁盘写入前完成 schema 和项目归属校验，防止半合法记录落盘。
    const validated = sessionRecordSchema.parse(record)
    if (validated.workspace !== this.workspace) throw new Error('会话工作区与当前项目不一致')

    let serialized: string
    try {
      serialized = `${JSON.stringify(validated, null, 2)}\n`
    } catch (error) {
      throw new Error(`会话包含无法序列化的数据：${error instanceof Error ? error.message : String(error)}`)
    }

    const target = this.sessionPath(validated.id)
    const temporary = path.join(this.sessionsDirectory, `.${validated.id}.${randomUUID()}.tmp`)
    try {
      // 临时文件与目标文件位于同一目录，rename 可作为原子替换；0600 避免会话内容被其他用户读取。
      await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, target)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  async load(id: string): Promise<SessionRecord> {
    const target = this.sessionPath(id)
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(target, 'utf8'))
    } catch (error) {
      throw new Error(`无法读取会话 ${id}：${error instanceof Error ? error.message : String(error)}`)
    }

    const result = sessionRecordSchema.safeParse(parsed)
    if (!result.success) {
      const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      throw new Error(`会话 ${id} 格式无效：${details}`)
    }
    if (result.data.id !== id) throw new Error(`会话文件名与内部 ID 不一致：${id}`)
    // 即使会话文件被手动复制进来，也不能越过项目隔离边界。
    if (result.data.workspace !== this.workspace) throw new Error(`会话 ${id} 属于其他项目，拒绝恢复`)
    return result.data
  }

  async list(): Promise<SessionSummary[]> {
    const entries = await readdir(this.sessionsDirectory, { withFileTypes: true })
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map(async (entry) => {
          const id = entry.name.slice(0, -'.json'.length)
          try {
            return await this.load(id)
          } catch {
            // 列表命令不能因为单个损坏会话崩溃；显式恢复该 ID 时仍会报告详细错误。
            return undefined
          }
        }),
    )

    return records
      .filter((record): record is SessionRecord => record !== undefined)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((record) => ({
        id: record.id,
        title: record.title,
        ...(record.name ? { name: record.name } : {}),
        updatedAt: record.updatedAt,
        provider: record.provider,
        model: record.model,
        messageCount: record.messages.length,
        lastRunStatus: record.lastRunStatus,
      }))
  }

  async latest(): Promise<SessionRecord | undefined> {
    const latest = (await this.list())[0]
    return latest ? this.load(latest.id) : undefined
  }

  async resolve(identifier: string): Promise<SessionRecord> {
    // ID 和用户命名都只做精确匹配，确保脚本中的 --resume 解析结果稳定、可预测。
    const matches = (await this.list()).filter((session) => session.id === identifier || session.name === identifier)
    if (matches.length === 0) throw new Error(`找不到当前项目会话：${identifier}`)
    if (matches.length > 1) throw new Error(`会话名称不唯一：${identifier}；请改用会话 ID`)
    const match = matches[0]
    if (!match) throw new Error(`找不到当前项目会话：${identifier}`)
    return this.load(match.id)
  }

  private sessionPath(id: string): string {
    // 会话 ID 最终会成为文件名，因此必须在 path.join 前阻断路径分隔符和目录穿越片段。
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error(`非法会话 ID：${id}`)
    return path.join(this.sessionsDirectory, `${id}.json`)
  }
}
