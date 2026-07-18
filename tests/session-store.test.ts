import { chmod, mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createInitialMessages } from '../src/runtime/agent-runtime.js'
import { SessionManager } from '../src/sessions/session-manager.js'
import { SessionStore } from '../src/sessions/session-store.js'

describe('SessionStore', () => {
  it('在项目内原子保存并恢复 providerData', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'pawcode-session-'))
    const store = await SessionStore.create(workspace)
    const manager = await SessionManager.create(store, 'test-provider', 'test-model', createInitialMessages())
    await manager.rename('auth-refactor')
    const messages = [
      ...createInitialMessages(),
      { role: 'user' as const, content: '继续之前的工作' },
      {
        role: 'assistant' as const,
        content: '好的',
        providerData: { role: 'assistant', responseId: 'response-1', signature: 'signed' },
      },
    ]
    await manager.updateMessages(messages)
    await manager.markCompleted({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 12,
    })

    const record = await store.load(manager.snapshot().id)
    expect(record.messages).toEqual(messages)
    expect(record.cumulativeUsage?.totalTokens).toBe(12)
    expect(record.title).toBe('继续之前的工作')
    await expect(store.resolve('auth-refactor')).resolves.toMatchObject({ id: record.id })

    const another = await SessionManager.create(store, 'test-provider', 'test-model', createInitialMessages())
    await expect(another.rename('auth-refactor')).rejects.toThrow('会话名称已存在')

    const sessionPath = path.join(workspace, '.pawcode', 'sessions', `${record.id}.json`)
    expect((await stat(sessionPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(sessionPath, 'utf8')).not.toContain('API_KEY')
    expect((await readdir(path.dirname(sessionPath))).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('从恢复点创建新会话分支且不修改原会话', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'pawcode-fork-'))
    const store = await SessionStore.create(workspace)
    const original = await SessionManager.create(store, 'provider', 'model', createInitialMessages())
    await original.updateMessages([...createInitialMessages(), { role: 'user', content: '原始目标' }])
    const originalRecord = original.snapshot()

    const forked = await SessionManager.fork(store, originalRecord, 'try-another-way')
    const forkedRecord = forked.snapshot()

    expect(forkedRecord.id).not.toBe(originalRecord.id)
    expect(forkedRecord.parentSessionId).toBe(originalRecord.id)
    expect(forkedRecord.name).toBe('try-another-way')
    expect(forkedRecord.messages).toEqual(originalRecord.messages)
    await expect(store.load(originalRecord.id)).resolves.not.toHaveProperty('parentSessionId')
  })

  it('不同项目不能恢复复制过去的会话', async () => {
    const first = await mkdtemp(path.join(tmpdir(), 'pawcode-project-a-'))
    const second = await mkdtemp(path.join(tmpdir(), 'pawcode-project-b-'))
    const firstStore = await SessionStore.create(first)
    const manager = await SessionManager.create(firstStore, 'provider', 'model', createInitialMessages())
    const id = manager.snapshot().id
    const source = path.join(first, '.pawcode', 'sessions', `${id}.json`)
    const targetDirectory = path.join(second, '.pawcode', 'sessions')
    await mkdir(targetDirectory, { recursive: true })
    await writeFile(path.join(targetDirectory, `${id}.json`), await readFile(source, 'utf8'), 'utf8')
    const secondStore = await SessionStore.create(second)

    await expect(secondStore.load(id)).rejects.toThrow('属于其他项目')
  })

  it('列表跳过损坏会话，但显式加载返回错误', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'pawcode-corrupt-'))
    const store = await SessionStore.create(workspace)
    const sessionsDirectory = path.join(workspace, '.pawcode', 'sessions')
    await writeFile(path.join(sessionsDirectory, 'broken.json'), '{invalid', 'utf8')
    await chmod(path.join(sessionsDirectory, 'broken.json'), 0o600)

    await expect(store.list()).resolves.toEqual([])
    await expect(store.load('broken')).rejects.toThrow('无法读取会话')
  })
})
