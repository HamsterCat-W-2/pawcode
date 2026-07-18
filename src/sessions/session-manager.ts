import { randomUUID } from 'node:crypto'
import type { Message } from '../domain/message.js'
import { addModelUsage, type ModelUsage } from '../domain/model.js'
import type { SessionRecord } from './session-schema.js'
import { SessionStore } from './session-store.js'

/**
 * 协调单个活跃会话的内存状态与持久化。
 *
 * Manager 集中维护 updatedAt、累计用量和运行状态，使 CLI 与 Runtime 不必直接修改磁盘记录。
 */
export class SessionManager {
  private constructor(
    private readonly store: SessionStore,
    private record: SessionRecord,
  ) {}

  static async create(
    store: SessionStore,
    provider: string,
    model: string,
    initialMessages: Message[],
    gitBranch?: string,
  ): Promise<SessionManager> {
    const now = new Date().toISOString()
    const manager = new SessionManager(store, {
      schemaVersion: 1,
      id: randomUUID(),
      title: '新会话',
      createdAt: now,
      updatedAt: now,
      workspace: store.workspacePath(),
      ...(gitBranch ? { gitBranch } : {}),
      provider,
      model,
      messages: initialMessages,
      lastRunStatus: 'idle',
      compactionCount: 0,
    })
    await manager.persist()
    return manager
  }

  static async resume(store: SessionStore, id: string): Promise<SessionManager> {
    return new SessionManager(store, await store.load(id))
  }

  static async resolve(store: SessionStore, identifier: string): Promise<SessionManager> {
    return new SessionManager(store, await store.resolve(identifier))
  }

  static async fork(store: SessionStore, source: SessionRecord, name?: string): Promise<SessionManager> {
    const now = new Date().toISOString()
    // 分支继承对话历史，但获得独立 ID 和生命周期；权限规则不在 SessionRecord 中，因此不会被继承。
    const forked = structuredClone(source)
    forked.id = randomUUID()
    forked.parentSessionId = source.id
    forked.createdAt = now
    forked.updatedAt = now
    forked.lastRunStatus = 'idle'
    if (name) {
      const normalizedName = normalizeName(name)
      await ensureNameAvailable(store, normalizedName)
      forked.name = normalizedName
    } else delete forked.name

    const manager = new SessionManager(store, forked)
    await manager.persist()
    return manager
  }

  snapshot(): SessionRecord {
    // 返回深拷贝，避免调用方绕过 persist() 直接改变 Manager 持有的状态。
    return structuredClone(this.record)
  }

  async updateModel(provider: string, model: string): Promise<void> {
    this.record.provider = provider
    this.record.model = model
    await this.persist()
  }

  async rename(name: string): Promise<void> {
    const normalizedName = normalizeName(name)
    await ensureNameAvailable(this.store, normalizedName, this.record.id)
    this.record.name = normalizedName
    await this.persist()
  }

  async updateMessages(messages: Message[]): Promise<void> {
    this.record.messages = structuredClone(messages)
    const firstUserMessage = messages.find((message) => message.role === 'user')?.content?.trim()
    // title 用首条用户输入自动生成；用户设置的稳定 name 单独保存，不会被自动标题覆盖。
    if (this.record.title === '新会话' && firstUserMessage) {
      this.record.title = firstUserMessage.slice(0, 80)
    }
    await this.persist()
  }

  async markRunning(processId = process.pid): Promise<void> {
    this.record.lastRunStatus = 'running'
    this.record.activeProcessId = processId
    await this.persist()
  }

  async markCompleted(usage?: ModelUsage): Promise<void> {
    this.record.lastRunStatus = 'completed'
    delete this.record.activeProcessId
    // 会话用量跨多次用户请求累计，单次 run 的多轮汇总由 Runtime 负责。
    const cumulativeUsage = addModelUsage(this.record.cumulativeUsage, usage)
    if (cumulativeUsage) this.record.cumulativeUsage = cumulativeUsage
    await this.persist()
  }

  async markFailed(): Promise<void> {
    this.record.lastRunStatus = 'failed'
    delete this.record.activeProcessId
    await this.persist()
  }

  async markCancelled(): Promise<void> {
    this.record.lastRunStatus = 'cancelled'
    delete this.record.activeProcessId
    await this.persist()
  }

  async markCleared(): Promise<void> {
    this.record.title = '新会话'
    this.record.lastRunStatus = 'idle'
    this.record.compactionCount = 0
    delete this.record.activeProcessId
    delete this.record.cumulativeUsage
    await this.persist()
  }

  async markCompacted(): Promise<void> {
    this.record.compactionCount += 1
    await this.persist()
  }

  private async persist(): Promise<void> {
    // 所有状态修改最终从同一出口保存，保证 updatedAt 与实际落盘顺序一致。
    this.record.updatedAt = new Date().toISOString()
    await this.store.save(this.record)
  }
}

function normalizeName(name: string): string {
  const normalized = name.trim()
  if (!normalized) throw new Error('会话名称不能为空')
  if (normalized.length > 100) throw new Error('会话名称不能超过 100 个字符')
  return normalized
}

async function ensureNameAvailable(store: SessionStore, name: string, currentId?: string): Promise<void> {
  // 名称可用于 --resume，项目内保持唯一才能避免交互和自动化恢复到不同会话。
  const duplicate = (await store.list()).find((session) => session.name === name && session.id !== currentId)
  if (duplicate) throw new Error(`会话名称已存在：${name}`)
}
