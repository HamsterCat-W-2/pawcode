import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config/config.js'
import { DynamicContextProvider } from '../src/context/runtime-context-provider.js'

const temporaryDirectories: string[] = []

describe('动态运行时上下文', () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    )
  })

  it('根据工具目标路径刷新上下文，并保持确定性的目标集合', async () => {
    const root = await fixture()
    await writeFile(path.join(root, 'PAWCODE.md'), '根规则')
    await mkdir(path.join(root, 'src/tools'), { recursive: true })
    await writeFile(path.join(root, 'src/PAWCODE.md'), 'src 规则')
    await writeFile(path.join(root, 'src/tools/PAWCODE.md'), 'tools 规则')

    const provider = await DynamicContextProvider.create(
      root,
      loadConfig({ model: { name: 'test-model' } }),
      '基础规则',
    )
    expect(provider.initial().systemPrompt).toContain('根规则')
    expect(provider.initial().systemPrompt).not.toContain('tools 规则')

    const decision = await provider.beforeToolCall('read_file', '{}', { workspace: root, maxOutputChars: 1_000 }, [
      { path: 'src/tools/example.ts', kind: 'file' },
      { path: 'src', kind: 'directory' },
      { path: 'src/tools/example.ts', kind: 'file' },
    ])

    expect(decision.updated).toBe(true)
    expect(decision.targetPaths).toEqual(['src', 'src/tools/example.ts'])
    expect(decision.context.systemPrompt).toContain('tools 规则')
    expect(provider.current().systemPrompt).toContain('src 规则')
  })

  it('非法目标路径回退到工作区上下文，不让路径输入越过工作区', async () => {
    const root = await fixture()
    await writeFile(path.join(root, 'PAWCODE.md'), '根规则')
    const provider = await DynamicContextProvider.create(
      root,
      loadConfig({ model: { name: 'test-model' } }),
      '基础规则',
    )

    const decision = await provider.beforeToolCall('read_file', '{}', { workspace: root, maxOutputChars: 1_000 }, [
      { path: '../outside.ts', kind: 'file' },
    ])

    expect(decision.targetPaths).toEqual(['.'])
    expect(decision.context.systemPrompt).toContain('根规则')
  })

  it('目标路径命中规则时返回禁用工具集合', async () => {
    const root = await fixture()
    const provider = await DynamicContextProvider.create(
      root,
      loadConfig({
        model: { name: 'test-model' },
        context: { pathRules: [{ pattern: 'secrets/**', disabledTools: ['run_command'] }] },
      }),
      '基础规则',
    )

    const decision = await provider.beforeToolCall('run_command', '{}', { workspace: root, maxOutputChars: 1_000 }, [
      { path: 'secrets/key.txt', kind: 'file' },
    ])

    expect(decision.disabled).toBe(true)
    expect(decision.context.disabledTools).toEqual(['run_command'])
  })
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pawcode-runtime-context-'))
  temporaryDirectories.push(root)
  return root
}
