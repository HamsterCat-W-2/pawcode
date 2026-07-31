import type { Skill, SkillActivation, SkillCatalog, ActiveSkill } from './skill-types.js'

/**
 * 管理当前 Runtime 的 Skill 目录快照和显式激活状态。
 * 它不读取文件、不执行工具，也不依赖 MCP transport；这些职责分别属于 loader 与 ToolRegistry。
 */
export class SkillRegistry {
  private active: ActiveSkill | undefined

  constructor(private readonly catalog: SkillCatalog) {}

  /** 供 one-shot 或没有任何 Skill 文件的 Runtime 构造一个空注册表。 */
  static empty(): SkillRegistry {
    return new SkillRegistry({ skills: [], overridden: [], diagnostics: [] })
  }

  /** 返回可用 Skill；调用方不得修改内部数组。 */
  skills(): Skill[] {
    return [...this.catalog.skills]
  }

  /** 返回被项目级 Skill 覆盖但仍合法的用户级 Skill，用于 `/skills` 展示。 */
  overridden(): Skill[] {
    return [...this.catalog.overridden]
  }

  /** 返回读取和解析时产生的安全诊断。 */
  diagnostics(): string[] {
    return this.catalog.diagnostics.map((diagnostic) => `[${diagnostic.source}] ${diagnostic.message}`)
  }

  /** 当前激活状态只读快照，避免 CLI 意外修改 Runtime 行为。 */
  current(): ActiveSkill | undefined {
    return this.active
      ? { ...this.active, ...(this.active.allowedTools ? { allowedTools: [...this.active.allowedTools] } : {}) }
      : undefined
  }

  /**
   * 激活一个已发现 Skill，并找出其声明但当前 Runtime 不存在的工具名称。
   * 未知工具只产生提示，不能因为 Skill 文本中的名称而创建或授权工具。
   */
  activate(name: string, availableTools: string[]): SkillActivation | undefined {
    const skill = this.catalog.skills.find((candidate) => candidate.name === name)
    if (!skill) return undefined
    this.active = {
      name: skill.name,
      source: skill.source,
      instructions: skill.instructions,
      ...(skill.allowedTools !== undefined ? { allowedTools: [...skill.allowedTools] } : {}),
    }
    const known = new Set(availableTools)
    return {
      skill: this.current()!,
      unknownTools: (skill.allowedTools ?? []).filter((tool) => !known.has(tool)),
    }
  }

  /** 清除内存中的激活状态，恢复基础 system prompt 与工具可见性。 */
  clear(): void {
    this.active = undefined
  }

  /** 将当前 Skill 指令包在稳定边界内，避免其来源混同于项目上下文或用户输入。 */
  systemPrompt(basePrompt: string): string {
    if (!this.active) return basePrompt
    return `${basePrompt}\n\n<pawcode-skill name="${this.active.name}" source="${this.active.source}">\n${this.active.instructions}\n</pawcode-skill>`
  }

  /**
   * 返回应额外禁用的工具。缺失 allowedTools 表示 Skill 不改变工具集合；
   * 空数组则禁用所有已注册工具，适合纯分析类 Skill。
   */
  disabledTools(availableTools: string[]): string[] {
    if (!this.active?.allowedTools) return []
    const allowed = new Set(this.active.allowedTools)
    return availableTools.filter((tool) => !allowed.has(tool))
  }
}
