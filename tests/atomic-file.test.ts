import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { atomicWriteFile, cleanupOrphanAtomicFiles } from '../src/filesystem/atomic-file.js'

describe('atomic file', () => {
  it('原子替换内容并保留已有文件权限', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pawcode-atomic-'))
    const target = path.join(directory, 'value.txt')
    await writeFile(target, 'old', { mode: 0o640 })

    await atomicWriteFile(target, 'new')

    expect(await readFile(target, 'utf8')).toBe('new')
    expect((await stat(target)).mode & 0o777).toBe(0o640)
    expect(await cleanupOrphanAtomicFiles(directory)).toBe(0)
  })

  it('清理死亡进程遗留临时文件，不触碰普通文件', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pawcode-orphan-'))
    await mkdir(directory, { recursive: true })
    const orphan = path.join(directory, '.pawcode-atomic-99999999-00000000-0000-0000-0000-000000000000.tmp')
    const normal = path.join(directory, 'keep.tmp')
    await writeFile(orphan, 'partial')
    await writeFile(normal, 'keep')

    expect(await cleanupOrphanAtomicFiles(directory)).toBe(1)
    await expect(readFile(orphan, 'utf8')).rejects.toThrow()
    await expect(readFile(normal, 'utf8')).resolves.toBe('keep')
  })
})
