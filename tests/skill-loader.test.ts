import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadSkills, maxSkillFileBytes } from '../src/skills/skill-loader.js'

/** 每个用例使用独立临时工作区，避免真实用户目录中的 Skill 影响发现结果。 */
const temporaryDirectories: string[] = []

describe('SkillLoader', () => {
  afterEach(async () => {
    // 测试夹具只位于系统临时目录；force 让中途断言失败后也能安全清理。
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    )
  })

  it('项目级同名 Skill 覆盖用户级，并保留覆盖来源供界面展示', async () => {
    const root = await createFixture()
    const home = path.join(root, 'home')
    await writeSkill(path.join(home, '.pawcode', 'skills', 'review.md'), 'review', '用户审查流程', '用户规则')
    await writeSkill(path.join(root, '.pawcode', 'skills', 'team-review.md'), 'review', '团队审查流程', '项目规则')

    const catalog = await loadSkills(root, { homeDirectory: home })

    expect(catalog.skills).toEqual([
      expect.objectContaining({
        name: 'review',
        source: 'project',
        description: '团队审查流程',
        instructions: '项目规则',
      }),
    ])
    expect(catalog.overridden).toEqual([expect.objectContaining({ name: 'review', source: 'user' })])
  })

  it('同一范围重名时排除全部候选，避免按目录顺序静默选择', async () => {
    const root = await createFixture()
    await writeSkill(path.join(root, '.pawcode', 'skills', 'first.md'), 'duplicate', '第一个', '规则一')
    await writeSkill(path.join(root, '.pawcode', 'skills', 'second.md'), 'duplicate', '第二个', '规则二')

    const catalog = await loadSkills(root, { homeDirectory: path.join(root, 'home') })

    expect(catalog.skills).toEqual([])
    expect(catalog.diagnostics).toHaveLength(2)
    expect(catalog.diagnostics.every((diagnostic) => diagnostic.message.includes('名称重复：duplicate'))).toBe(true)
  })

  it('拒绝无效 frontmatter 与超过上限的内容，但不阻塞其他合法 Skill', async () => {
    const root = await createFixture()
    const directory = path.join(root, '.pawcode', 'skills')
    await writeFile(path.join(directory, 'invalid.md'), '没有 frontmatter', 'utf8')
    await writeFile(
      path.join(directory, 'large.md'),
      `---\nname: large\ndescription: 超大文件\n---\n${'a'.repeat(maxSkillFileBytes)}`,
      'utf8',
    )
    await writeSkill(path.join(directory, 'valid.md'), 'valid', '合法 Skill', '只读取需要的文件。', ['read_file'])

    const catalog = await loadSkills(root, { homeDirectory: path.join(root, 'home') })

    expect(catalog.skills).toEqual([
      expect.objectContaining({ name: 'valid', allowedTools: ['read_file'], instructions: '只读取需要的文件。' }),
    ])
    expect(catalog.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
      expect.arrayContaining(['Skill 缺少 frontmatter 起始标记', `Skill 文件超过 ${maxSkillFileBytes} 字节限制`]),
    )
  })
})

/** 创建具有用户目录和项目目录的最小工作区，不需要 Git 或真实配置。 */
async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pawcode-skills-'))
  temporaryDirectories.push(root)
  await Promise.all([
    mkdir(path.join(root, '.pawcode', 'skills'), { recursive: true }),
    mkdir(path.join(root, 'home', '.pawcode', 'skills'), { recursive: true }),
  ])
  return root
}

/** 按 MVP 支持的 Markdown/frontmatter 格式写入 Skill；allowedTools 缺失表示不附加工具限制。 */
async function writeSkill(
  filePath: string,
  name: string,
  description: string,
  instructions: string,
  allowedTools?: string[],
): Promise<void> {
  const tools =
    allowedTools === undefined ? '' : `\nallowedTools:\n${allowedTools.map((tool) => `  - ${tool}`).join('\n')}`
  await writeFile(filePath, `---\nname: ${name}\ndescription: ${description}${tools}\n---\n${instructions}\n`, 'utf8')
}
