import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceFiles } from '../src/tools/workspace-files.js'

describe('WorkspaceFiles', () => {
  it('读取指定行并添加行号', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pawcode-files-'))
    await writeFile(path.join(root, 'hello.txt'), 'one\ntwo\nthree', 'utf8')
    const files = await WorkspaceFiles.create(root)

    await expect(files.read('hello.txt', 2, 2)).resolves.toBe('2: two\n3: three')
  })

  it('搜索文本并返回文件与行号', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pawcode-grep-'))
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'src', 'answer.ts'), 'export const answer = 42;\n')
    const files = await WorkspaceFiles.create(root)

    await expect(files.grep('answer')).resolves.toEqual([
      { path: 'src/answer.ts', line: 1, text: 'export const answer = 42;' },
    ])
  })

  it('阻止路径和符号链接逃逸', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pawcode-safe-'))
    await symlink(tmpdir(), path.join(root, 'outside'))
    const files = await WorkspaceFiles.create(root)

    await expect(files.read('../secret.txt')).rejects.toThrow('路径越过工作区边界')
    await expect(files.list('outside')).rejects.toThrow('符号链接越过工作区边界')
    await expect(files.write('outside/new.txt', 'blocked')).rejects.toThrow('符号链接越过工作区边界')
    await expect(files.write('.git/config', 'blocked')).rejects.toThrow('禁止通过文件工具修改 .git')
  })

  it('允许显式访问工作区内的符号链接，但目录扫描不跟随链接', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pawcode-safe-inside-'))
    await mkdir(path.join(root, 'real'))
    await writeFile(path.join(root, 'real', 'inside.txt'), 'inside')
    await symlink(path.join(root, 'real'), path.join(root, 'linked'))
    const files = await WorkspaceFiles.create(root)

    await expect(files.read('linked/inside.txt')).resolves.toContain('inside')
    await expect(files.list('.')).resolves.not.toContain('linked/inside.txt')
  })

  it('创建文件并执行精确文本替换', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pawcode-write-'))
    const files = await WorkspaceFiles.create(root)

    await expect(files.write('src/new.ts', 'const value = 1\n')).resolves.toContain('src/new.ts')
    await expect(files.replace('src/new.ts', 'value = 1', 'value = 2')).resolves.toContain('替换 1 处')
    await expect(readFile(path.join(root, 'src/new.ts'), 'utf8')).resolves.toBe('const value = 2\n')

    await writeFile(path.join(root, 'duplicate.txt'), 'same same', 'utf8')
    await expect(files.replace('duplicate.txt', 'same', 'new')).rejects.toThrow('出现 2 次')
  })
})
