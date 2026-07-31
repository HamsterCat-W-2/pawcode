import type { Dirent } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Skill, SkillCatalog, SkillDiagnostic, SkillSource } from './skill-types.js'

/** 单个 Skill 文件的最大字节数；限制上下文大小，也避免读取异常大文件。 */
export const maxSkillFileBytes = 32 * 1024

/** Skill 名称用于交互命令和诊断，因此只接受稳定、无路径含义的小写标识。 */
const skillNamePattern = /^[a-z0-9][a-z0-9-]{0,39}$/

/** 注入 homeDirectory 让测试不依赖真实用户目录。 */
export interface SkillLoaderOptions {
  homeDirectory?: string
}

/**
 * 从固定用户级和项目级目录发现 Skills。读取入口不接受任意路径，
 * 防止 `/skill` 被变成加载仓库任意文件的旁路。
 */
export async function loadSkills(workspace: string, options: SkillLoaderOptions = {}): Promise<SkillCatalog> {
  const resolvedWorkspace = path.resolve(workspace)
  const homeDirectory = path.resolve(options.homeDirectory ?? os.homedir())
  const userDirectory = path.join(homeDirectory, '.pawcode', 'skills')
  const projectDirectory = path.join(resolvedWorkspace, '.pawcode', 'skills')

  // 两个范围互不依赖，可并行读取；一个范围的问题不能阻止另一个范围的 Skill 可用。
  const [user, project] = await Promise.all([
    loadSkillDirectory('user', userDirectory),
    loadSkillDirectory('project', projectDirectory),
  ])
  const diagnostics = [...user.diagnostics, ...project.diagnostics]
  const userByName = indexSkills('user', user.skills, diagnostics)
  const projectByName = indexSkills('project', project.skills, diagnostics)
  const overridden: Skill[] = []
  const skills: Skill[] = []

  // 按名称排序使 `/skills` 的输出和测试稳定；项目级在同名时覆盖用户级。
  for (const name of [...new Set([...userByName.keys(), ...projectByName.keys()])].sort()) {
    const projectSkill = projectByName.get(name)
    const userSkill = userByName.get(name)
    if (projectSkill) {
      skills.push(projectSkill)
      if (userSkill) overridden.push(userSkill)
    } else if (userSkill) {
      skills.push(userSkill)
    }
  }
  return { skills, overridden, diagnostics }
}

/** 单个目录的原始发现结果；同层重名冲突在 indexSkills 中统一处理。 */
interface SkillDirectoryResult {
  skills: Skill[]
  diagnostics: SkillDiagnostic[]
}

/** 只读取固定目录第一层的普通 `.md` 文件，不递归且不跟随符号链接。 */
async function loadSkillDirectory(source: SkillSource, directory: string): Promise<SkillDirectoryResult> {
  const diagnostics: SkillDiagnostic[] = []
  // 显式指定 UTF-8 名称，避免 `readdir` 的 Buffer 重载让后续路径和字符串校验失去类型保证。
  let entries: Dirent<string>[]
  try {
    entries = await readdir(directory, { withFileTypes: true, encoding: 'utf8' })
  } catch (error) {
    // 缺少目录等同于该范围没有 Skill；其他读目录失败需要可见诊断。
    if (isMissingPathError(error)) return { skills: [], diagnostics }
    diagnostics.push({ source, path: directory, message: `无法读取 Skill 目录：${errorMessage(error)}` })
    return { skills: [], diagnostics }
  }

  const results = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith('.') && entry.name.endsWith('.md'))
      .map(async (entry) => {
        const filePath = path.join(directory, entry.name)
        // Dirent 先排除明显非文件项；lstat 再防止平台差异或赛跑条件下跟随符号链接。
        if (!entry.isFile() || entry.isSymbolicLink()) {
          return {
            diagnostic: { source, path: filePath, message: 'Skill 必须是普通 Markdown 文件' } satisfies SkillDiagnostic,
          }
        }
        return readSkillFile(source, filePath)
      }),
  )
  const skills: Skill[] = []
  for (const result of results) {
    if ('skill' in result) skills.push(result.skill)
    else diagnostics.push(result.diagnostic)
  }
  return { skills, diagnostics }
}

/** 读取、大小检查、解析并校验一个候选 Skill 文件。 */
async function readSkillFile(
  source: SkillSource,
  filePath: string,
): Promise<{ skill: Skill } | { diagnostic: SkillDiagnostic }> {
  try {
    const info = await lstat(filePath)
    if (!info.isFile() || info.isSymbolicLink()) {
      return { diagnostic: { source, path: filePath, message: 'Skill 必须是普通 Markdown 文件' } }
    }
    if (info.size > maxSkillFileBytes) {
      return { diagnostic: { source, path: filePath, message: `Skill 文件超过 ${maxSkillFileBytes} 字节限制` } }
    }
    const parsed = parseSkillMarkdown(await readFile(filePath, 'utf8'))
    if (!parsed.ok) return { diagnostic: { source, path: filePath, message: parsed.message } }
    return {
      skill: {
        ...parsed.value,
        source,
        path: filePath,
      },
    }
  } catch (error) {
    return { diagnostic: { source, path: filePath, message: `无法读取 Skill：${errorMessage(error)}` } }
  }
}

/**
 * MVP frontmatter 解析器只支持 name、description 和 allowedTools，避免引入宽泛 YAML 解释能力。
 * 正文保留原始 Markdown，让用户可以编写多段自然语言工作流说明。
 */
function parseSkillMarkdown(
  markdown: string,
):
  | { ok: true; value: Pick<Skill, 'name' | 'description' | 'allowedTools' | 'instructions'> }
  | { ok: false; message: string } {
  if (!markdown.startsWith('---\n')) return { ok: false, message: 'Skill 缺少 frontmatter 起始标记' }
  const end = markdown.indexOf('\n---\n', 4)
  if (end < 0) return { ok: false, message: 'Skill 缺少 frontmatter 结束标记' }
  const frontmatter = markdown.slice(4, end)
  const instructions = markdown.slice(end + 5).trim()
  if (!instructions) return { ok: false, message: 'Skill 正文不能为空' }

  const fields = new Map<string, string | string[]>()
  let activeList: string | undefined
  for (const rawLine of frontmatter.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const listItem = line.match(/^\s+-\s+(.+)$/)
    if (listItem && activeList) {
      const listValue = listItem[1]
      if (listValue === undefined) return { ok: false, message: 'allowedTools 列表项不能为空' }
      const current = fields.get(activeList)
      if (!Array.isArray(current)) return { ok: false, message: `${activeList} 必须是字符串数组` }
      current.push(unquote(listValue.trim()))
      continue
    }
    const field = line.match(/^([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*)$/)
    if (!field) return { ok: false, message: 'frontmatter 仅支持简单字段和值' }
    const key = field[1]
    const rawValue = field[2]
    // RegExp 匹配成功后分组必然存在；此处显式收窄是为了兼容 noUncheckedIndexedAccess。
    if (key === undefined || rawValue === undefined) return { ok: false, message: 'frontmatter 字段解析失败' }
    if (fields.has(key)) return { ok: false, message: `frontmatter 字段重复：${key}` }
    if (key === 'allowedTools' && !rawValue.trim()) {
      fields.set(key, [])
      activeList = key
      continue
    }
    fields.set(key, unquote(rawValue.trim()))
    activeList = undefined
  }

  const name = fields.get('name')
  const description = fields.get('description')
  const allowedTools = fields.get('allowedTools')
  if (typeof name !== 'string' || !skillNamePattern.test(name)) {
    return { ok: false, message: 'name 必须匹配 ^[a-z0-9][a-z0-9-]{0,39}$' }
  }
  if (typeof description !== 'string' || description.length === 0 || description.length > 200) {
    return { ok: false, message: 'description 长度必须为 1～200' }
  }
  if (allowedTools !== undefined && (!Array.isArray(allowedTools) || allowedTools.some((tool) => !tool))) {
    return { ok: false, message: 'allowedTools 必须是非空字符串数组' }
  }
  const unknownFields = [...fields.keys()].filter((key) => !['name', 'description', 'allowedTools'].includes(key))
  if (unknownFields.length > 0) return { ok: false, message: `不支持的 frontmatter 字段：${unknownFields.join(', ')}` }
  return {
    ok: true,
    value: { name, description, ...(allowedTools !== undefined ? { allowedTools } : {}), instructions },
  }
}

/** 同一范围的同名声明没有安全优先级，因此全部排除并留下诊断。 */
function indexSkills(source: SkillSource, skills: Skill[], diagnostics: SkillDiagnostic[]): Map<string, Skill> {
  const byName = new Map<string, Skill[]>()
  for (const skill of skills) byName.set(skill.name, [...(byName.get(skill.name) ?? []), skill])
  const indexed = new Map<string, Skill>()
  for (const [name, candidates] of byName) {
    const onlyCandidate = candidates[0]
    if (candidates.length === 1 && onlyCandidate) indexed.set(name, onlyCandidate)
    else {
      for (const candidate of candidates) {
        diagnostics.push({ source, path: candidate.path, message: `同一范围内 Skill 名称重复：${name}` })
      }
    }
  }
  return indexed
}

/** 去除简单单双引号，满足示例和常见 frontmatter 写法；不尝试支持完整 YAML 转义。 */
function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }
  return value
}

/** Node 的 ENOENT 代表固定 Skill 目录不存在，是正常的空发现结果。 */
function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** 所有外部 I/O 错误统一压缩为安全字符串，避免依赖 Error 的具体子类。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
