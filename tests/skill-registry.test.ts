import { describe, expect, it } from 'vitest'
import { SkillRegistry } from '../src/skills/skill-registry.js'
import type { SkillCatalog } from '../src/skills/skill-types.js'

/** 用内存目录快照构造 Registry，聚焦激活与限制语义，不让文件 I/O 干扰断言。 */
function createCatalog(): SkillCatalog {
  return {
    skills: [
      {
        name: 'review',
        description: '只读审查',
        allowedTools: ['read_file', 'missing_tool'],
        instructions: '审查改动，不要修改文件。',
        source: 'project',
        path: '/workspace/.pawcode/skills/review.md',
      },
      {
        name: 'writing',
        description: '纯写作',
        allowedTools: [],
        instructions: '只输出方案。',
        source: 'user',
        path: '/home/.pawcode/skills/writing.md',
      },
      {
        name: 'default-tools',
        description: '不限制工具',
        instructions: '遵循默认工具规则。',
        source: 'user',
        path: '/home/.pawcode/skills/default-tools.md',
      },
    ],
    overridden: [],
    diagnostics: [],
  }
}

describe('SkillRegistry', () => {
  it('激活后只注入请求期 prompt，并报告未注册的 allowedTools 名称', () => {
    const registry = new SkillRegistry(createCatalog())

    const result = registry.activate('review', ['read_file', 'write_file'])

    expect(result).toMatchObject({ skill: { name: 'review', source: 'project' }, unknownTools: ['missing_tool'] })
    expect(registry.systemPrompt('基础规则')).toContain('<pawcode-skill name="review" source="project">')
    expect(registry.systemPrompt('基础规则')).toContain('审查改动，不要修改文件。')
    expect(registry.disabledTools(['read_file', 'write_file'])).toEqual(['write_file'])
  })

  it('空 allowedTools 禁用全部工具，缺失 allowedTools 不额外禁用工具', () => {
    const registry = new SkillRegistry(createCatalog())

    registry.activate('writing', ['read_file', 'write_file'])
    expect(registry.disabledTools(['read_file', 'write_file'])).toEqual(['read_file', 'write_file'])

    registry.activate('default-tools', ['read_file', 'write_file'])
    expect(registry.disabledTools(['read_file', 'write_file'])).toEqual([])
  })

  it('清除只影响内存激活状态，不删除目录快照', () => {
    const registry = new SkillRegistry(createCatalog())
    registry.activate('review', ['read_file'])

    registry.clear()

    expect(registry.current()).toBeUndefined()
    expect(registry.systemPrompt('基础规则')).toBe('基础规则')
    expect(registry.skills()).toHaveLength(3)
  })
})
