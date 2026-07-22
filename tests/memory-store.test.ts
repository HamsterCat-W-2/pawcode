import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config/config.js'
import { resolveContext } from '../src/context/context-resolver.js'
import { PersistentMemoryStore } from '../src/memory/memory-store.js'

const temporaryDirectories: string[] = []

describe('持久化记忆', () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    )
  })

  it('分别保存用户级和项目级记忆，并支持删除和清空', async () => {
    const root = await fixture()
    const home = await fixture()
    const store = PersistentMemoryStore.create(root, home)

    const userEntry = await store.add('user', '始终使用中文回答')
    const projectEntry = await store.add('project', '项目包管理器使用 pnpm')
    expect((await store.list()).flatMap((result) => result.entries)).toHaveLength(2)

    await store.remove('user', userEntry.id)
    expect((await store.read('user')).entries).toEqual([])
    await store.clear('project')
    expect((await store.read('project')).entries).toEqual([])
    expect(projectEntry.id).toMatch(/^mem_/)
  })

  it('拒绝疑似凭据，并将记忆注入上下文但不进入 Session 消息', async () => {
    const root = await fixture()
    const home = await fixture()
    const store = PersistentMemoryStore.create(root, home)
    await expect(store.add('project', 'api_key=sk-secret')).rejects.toThrow('敏感')
    await store.add('user', '统一使用 pnpm test')
    await store.add('project', '不要修改生成目录')

    const context = await resolveContext(root, loadConfig({ model: { name: 'test-model' } }), '基础规则', {
      homeDirectory: home,
    })
    expect(context.systemPrompt).toContain('统一使用 pnpm test')
    expect(context.systemPrompt).toContain('不要修改生成目录')
    expect(context.sources.map((source) => source.kind)).toEqual(['memory-user', 'memory-project'])
  })

  it('损坏的记忆文件只产生诊断，不阻断上下文加载', async () => {
    const root = await fixture()
    const home = await fixture()
    await writeFile(path.join(home, '.pawcode-memory-placeholder'), 'unused')
    const store = PersistentMemoryStore.create(root, home)
    await store.add('project', '有效项目记忆')
    await writeFile(path.join(root, '.pawcode', 'memory.json'), '{broken')

    const context = await resolveContext(root, loadConfig({ model: { name: 'test-model' } }), '基础规则', {
      homeDirectory: home,
    })
    expect(context.systemPrompt).not.toContain('有效项目记忆')
    expect(context.diagnostics.join('\n')).toContain('记忆文件未加载')
  })
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pawcode-memory-'))
  temporaryDirectories.push(root)
  return root
}
