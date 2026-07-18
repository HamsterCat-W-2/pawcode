import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { atomicWriteFile } from '../filesystem/atomic-file.js'

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next'])

export interface GrepMatch {
  path: string
  line: number
  text: string
}

// 文件路径安全、符号链接检查和递归遍历都隐藏在这个深模块中。
export class WorkspaceFiles {
  private constructor(private readonly root: string) {}

  static async create(workspace: string): Promise<WorkspaceFiles> {
    return new WorkspaceFiles(await realpath(workspace))
  }

  async list(relativePath = '.', maxDepth = 2): Promise<string[]> {
    const target = await this.resolve(relativePath)
    const info = await stat(target)
    if (!info.isDirectory()) throw new Error('目标不是目录')

    const entries = await this.walk(target, Math.max(0, Math.min(maxDepth, 5)))
    return entries.map((entry) => path.relative(this.root, entry))
  }

  async read(relativePath: string, startLine = 1, lineCount = 300): Promise<string> {
    const target = await this.resolve(relativePath)
    const info = await stat(target)
    if (!info.isFile()) throw new Error('目标不是文件')
    if (info.size > 2_000_000) throw new Error('文件超过 2MB，拒绝读取')

    const content = await readFile(target, 'utf8')
    const lines = content.split(/\r?\n/)
    const start = Math.max(1, startLine)
    const count = Math.max(1, Math.min(lineCount, 1_000))

    return lines
      .slice(start - 1, start - 1 + count)
      .map((line, index) => `${start + index}: ${line}`)
      .join('\n')
  }

  async write(relativePath: string, content: string): Promise<string> {
    assertContentSize(content)
    const target = await this.resolveForWrite(relativePath)
    await mkdir(path.dirname(target), { recursive: true })
    await atomicWriteFile(target, content)
    return `已写入 ${path.relative(this.root, target)}（${Buffer.byteLength(content, 'utf8')} bytes）`
  }

  async replace(relativePath: string, oldText: string, newText: string, replaceAll = false): Promise<string> {
    if (!oldText) throw new Error('old_text 不能为空')
    const target = await this.resolve(relativePath)
    const info = await stat(target)
    if (!info.isFile()) throw new Error('目标不是文件')
    if (info.size > 2_000_000) throw new Error('文件超过 2MB，拒绝修改')

    const content = await readFile(target, 'utf8')
    // 先计算匹配数量再写文件，避免“看似精确”的补丁悄悄改到多个位置。
    const occurrences = content.split(oldText).length - 1
    if (occurrences === 0) throw new Error('没有找到 old_text，文件未修改')
    if (occurrences > 1 && !replaceAll) {
      throw new Error(`old_text 出现 ${occurrences} 次；请提供更精确的上下文或设置 replace_all`)
    }

    const updated = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText)
    assertContentSize(updated)
    await atomicWriteFile(target, updated)
    return `已修改 ${path.relative(this.root, target)}（替换 ${replaceAll ? occurrences : 1} 处）`
  }

  async resolveDirectory(relativePath = '.'): Promise<string> {
    const target = await this.resolve(relativePath)
    if (!(await stat(target)).isDirectory()) throw new Error('工作目录不是目录')
    return target
  }

  async grep(query: string, relativePath = '.', maxResults = 50): Promise<GrepMatch[]> {
    if (!query) throw new Error('搜索文本不能为空')

    const target = await this.resolve(relativePath)
    const files = (await stat(target)).isFile() ? [target] : await this.walk(target, 20, false)
    const matches: GrepMatch[] = []

    for (const file of files) {
      try {
        const info = await stat(file)
        if (!info.isFile() || info.size > 1_000_000) continue

        const content = await readFile(file, 'utf8')
        if (content.includes('\u0000')) continue

        const lines = content.split(/\r?\n/)
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]
          if (line?.includes(query)) {
            matches.push({
              path: path.relative(this.root, file),
              line: index + 1,
              text: line.trim(),
            })
          }
          if (matches.length >= maxResults) return matches
        }
      } catch {
        continue
      }
    }

    return matches
  }

  private async resolve(input: string): Promise<string> {
    if (path.isAbsolute(input)) throw new Error(`只允许工作区相对路径：${input}`)
    const candidate = path.resolve(this.root, input || '.')
    if (!this.isInside(candidate)) {
      throw new Error(`路径越过工作区边界：${input}`)
    }

    // realpath 会展开目标中的符号链接，第二次边界检查用于阻止链接逃逸。
    const target = await realpath(candidate)
    if (!this.isInside(target)) {
      throw new Error(`符号链接越过工作区边界：${input}`)
    }
    return target
  }

  private async resolveForWrite(input: string): Promise<string> {
    if (!input || path.isAbsolute(input)) throw new Error(`只允许工作区相对路径：${input}`)
    const candidate = path.resolve(this.root, input)
    if (!this.isInside(candidate)) throw new Error(`路径越过工作区边界：${input}`)
    const relative = path.relative(this.root, candidate)
    if (relative === '.git' || relative.startsWith(`.git${path.sep}`)) {
      throw new Error('禁止通过文件工具修改 .git 元数据')
    }

    // 已存在文件直接校验最终真实路径；写入符号链接时也不能越过工作区。
    try {
      const existing = await realpath(candidate)
      if (!this.isInside(existing)) throw new Error(`符号链接越过工作区边界：${input}`)
      if ((await stat(existing)).isDirectory()) throw new Error('目标是目录')
      return existing
    } catch (error) {
      if (!isMissingPathError(error)) throw error
    }

    // 新文件本身没有 realpath，因此向上寻找最近的已存在父目录并校验它。
    let ancestor = path.dirname(candidate)
    while (this.isInside(ancestor)) {
      try {
        const resolvedAncestor = await realpath(ancestor)
        if (!this.isInside(resolvedAncestor)) throw new Error(`符号链接越过工作区边界：${input}`)
        return candidate
      } catch (error) {
        if (!isMissingPathError(error)) throw error
        const parent = path.dirname(ancestor)
        if (parent === ancestor) break
        ancestor = parent
      }
    }
    throw new Error(`无法解析写入路径：${input}`)
  }

  private isInside(target: string): boolean {
    const relative = path.relative(this.root, target)
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  }

  private async walk(
    directory: string,
    maxDepth: number,
    includeDirectories = true,
    currentDepth = 0,
  ): Promise<string[]> {
    if (currentDepth > maxDepth) return []

    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    const output: string[] = []

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue

      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (includeDirectories) output.push(`${absolute}${path.sep}`)
        output.push(...(await this.walk(absolute, maxDepth, includeDirectories, currentDepth + 1)))
      } else if (entry.isFile()) {
        output.push(absolute)
      }
    }

    return output
  }
}

function assertContentSize(content: string): void {
  if (Buffer.byteLength(content, 'utf8') > 1_048_576) throw new Error('写入内容超过 1MiB')
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
