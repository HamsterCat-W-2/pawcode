import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config/config.js'
import { resolveContext } from '../src/context/context-resolver.js'

const temporaryDirectories: string[] = []

describe('项目上下文解析', () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    )
  })

  it('按用户级、根级、子目录顺序加载 PAWCODE 和 AGENTS', async () => {
    const root = await fixture()
    const home = path.join(root, 'home')
    const targetDirectory = path.join(root, 'src/tools')
    await mkdir(path.join(home, '.pawcode'), { recursive: true, mode: 0o700 })
    await mkdir(targetDirectory, { recursive: true })
    await writeText(path.join(home, '.pawcode/PAWCODE.md'), '用户规则')
    await writeText(path.join(root, 'PAWCODE.md'), '项目根规则')
    await writeText(path.join(root, 'AGENTS.md'), '兼容规则')
    await writeText(path.join(root, 'src/PAWCODE.md'), 'src 规则')
    await writeText(path.join(targetDirectory, 'AGENTS.md'), 'tools 规则')

    const context = await resolveContext(root, loadConfig({ model: { name: 'test-model' } }), '内置安全提示', {
      homeDirectory: home,
      targetPath: 'src/tools/example.ts',
    })

    expect(context.systemPrompt).toContain('用户规则')
    expect(context.systemPrompt.indexOf('项目根规则')).toBeLessThan(context.systemPrompt.indexOf('src 规则'))
    expect(context.systemPrompt.indexOf('src 规则')).toBeLessThan(context.systemPrompt.indexOf('tools 规则'))
    expect(context.sources.map((source) => path.basename(source.path))).toEqual([
      'PAWCODE.md',
      'PAWCODE.md',
      'AGENTS.md',
      'PAWCODE.md',
      'AGENTS.md',
    ])
  })

  it('可以关闭 AGENTS.md，并按路径规则收紧工具', async () => {
    const root = await fixture()
    await writeText(path.join(root, 'AGENTS.md'), '不应被加载')
    const config = loadConfig({
      model: { name: 'test-model' },
      instructions: { includeAgentsMd: false },
      context: {
        pathRules: [{ pattern: 'src/tools/**', instructions: '工具规则', disabledTools: ['run_command'] }],
      },
    })

    const context = await resolveContext(root, config, '内置安全提示', { targetPath: 'src/tools/example.ts' })
    expect(context.systemPrompt).not.toContain('不应被加载')
    expect(context.systemPrompt).toContain('工具规则')
    expect(context.disabledTools).toEqual(['run_command'])
  })

  it('拒绝工作区外目标路径并保留可诊断信息', async () => {
    const root = await fixture()
    const context = await resolveContext(root, loadConfig({ model: { name: 'test-model' } }), '安全提示', {
      targetPath: '../outside.ts',
    })
    expect(context.diagnostics.join('\n')).toContain('越过工作区边界')
  })
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pawcode-context-'))
  temporaryDirectories.push(root)
  return root
}

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content, { mode: 0o600 })
  await chmod(filePath, 0o600)
}
