import { open, readdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const temporaryPattern = /^\.pawcode-atomic-(\d+)-[0-9a-f-]+\.tmp$/

export interface AtomicWriteOptions {
  mode?: number
}

/**
 * 在目标同目录写入完整临时文件并 fsync，最后通过 rename 原子替换。
 * 这样进程中断时目标要么保持旧内容，要么完整变成新内容，不会留下半截文件。
 */
export async function atomicWriteFile(
  target: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = path.dirname(target)
  await cleanupOrphanAtomicFiles(directory)
  const existingMode = await stat(target)
    .then((info) => info.mode & 0o777)
    .catch((error: unknown) => {
      if (isMissingPathError(error)) return undefined
      throw error
    })
  const mode = options.mode ?? existingMode ?? 0o644
  const temporary = path.join(directory, `.pawcode-atomic-${process.pid}-${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined

  try {
    handle = await open(temporary, 'wx', mode)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, target)
    // rename 已成功后目录 fsync 只做持久化加固；不支持目录 fsync 的平台不能把成功写入误报为失败。
    await syncDirectoryBestEffort(directory)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

/** 清理已经不存在的 PawCode 进程遗留的临时文件，活跃并发实例的文件必须保留。 */
export async function cleanupOrphanAtomicFiles(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true })
  let removed = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const processIdText = temporaryPattern.exec(entry.name)?.[1]
    if (!processIdText) continue
    const processId = Number(processIdText)
    if (processIsAlive(processId)) continue
    try {
      await unlink(path.join(directory, entry.name))
      removed += 1
    } catch {
      // 文件可能已经被另一个启动实例清理；计数只包含本实例实际删除的项。
    }
  }
  return removed
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Windows 和部分文件系统不允许打开目录；目标 rename 已经成功，不能在这里回滚或报失败。
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
