import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { PermissionManager } from '../src/permissions/permission-manager.js'
import { GitDiffTool } from '../src/tools/git-diff-tool.js'
import { RunCommandTool } from '../src/tools/run-command-tool.js'
import { ToolRegistry } from '../src/tools/tool-registry.js'

const execFileAsync = promisify(execFile)

describe('命令与 Git 工具', () => {
  it('经确认后执行无 Shell 命令并返回退出码', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pawcode-command-'))
    const registry = new ToolRegistry([new RunCommandTool()])
    const result = await registry.execute(
      'run_command',
      JSON.stringify({ command: process.execPath, args: ['-e', 'process.stdout.write("ok")'] }),
      {
        workspace: root,
        maxOutputChars: 10_000,
        permissionManager: new PermissionManager({ confirm: async () => 'allow_once' }),
      },
    )

    expect(result).toContain('exit_code: 0')
    expect(result).toContain('ok')
  })

  it('拒绝危险命令且不会执行', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pawcode-danger-'))
    const target = path.join(root, 'keep.txt')
    await writeFile(target, 'keep', 'utf8')
    const registry = new ToolRegistry([new RunCommandTool()])
    const result = await registry.execute('run_command', JSON.stringify({ command: 'rm', args: ['keep.txt'] }), {
      workspace: root,
      maxOutputChars: 10_000,
      permissionManager: new PermissionManager({ allowedCommandPrefixes: ['rm'] }),
    })

    expect(result).toContain('权限被拒绝')
    await expect(readFile(target, 'utf8')).resolves.toBe('keep')
  })

  it('限制工作目录并中止超时命令', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pawcode-command-safe-'))
    const registry = new ToolRegistry([new RunCommandTool()])
    const context = {
      workspace: root,
      maxOutputChars: 10_000,
      permissionManager: new PermissionManager({ confirm: async () => 'allow_once' as const }),
    }

    await expect(
      registry.execute(
        'run_command',
        JSON.stringify({ command: process.execPath, args: ['-e', '0'], cwd: '..' }),
        context,
      ),
    ).resolves.toContain('路径越过工作区边界')
    await expect(
      registry.execute(
        'run_command',
        JSON.stringify({
          command: process.execPath,
          args: ['-e', 'setTimeout(() => {}, 10000)'],
          timeout_ms: 10,
        }),
        context,
      ),
    ).resolves.toContain('命令超过 10ms')
  })

  it('git_diff 返回未提交修改', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pawcode-git-'))
    await execFileAsync('git', ['init'], { cwd: root })
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
    await execFileAsync('git', ['config', 'user.name', 'PawCode Test'], { cwd: root })
    await writeFile(path.join(root, 'value.txt'), 'one\n', 'utf8')
    await execFileAsync('git', ['add', 'value.txt'], { cwd: root })
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root })
    await writeFile(path.join(root, 'value.txt'), 'two\n', 'utf8')

    const result = await new ToolRegistry([new GitDiffTool()]).execute('git_diff', '{}', {
      workspace: root,
      maxOutputChars: 20_000,
    })
    expect(result).toContain('M value.txt')
    expect(result).toContain('-one')
    expect(result).toContain('+two')
  })
})
