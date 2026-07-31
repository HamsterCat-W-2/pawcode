/** Skill 的来源范围；项目级同名 Skill 覆盖用户级 Skill。 */
export type SkillSource = 'user' | 'project'

/**
 * 经过文件安全检查和 frontmatter 校验后的可用 Skill。
 * instructions 不包含 frontmatter，只保存会注入模型 system prompt 的 Markdown 正文。
 */
export interface Skill {
  /** `/skill <name>` 使用的稳定标识。 */
  name: string
  /** `/skills` 展示的简短用途。 */
  description: string
  /** 缺失表示不额外限制工具；空数组表示禁止所有工具。 */
  allowedTools?: string[]
  /** 原始 Markdown 正文，作为受边界标识保护的模型指令。 */
  instructions: string
  /** Skill 的覆盖范围，用于优先级和人类可读输出。 */
  source: SkillSource
  /** 已解析的普通文件绝对路径，仅用于诊断与展示。 */
  path: string
}

/** 不可用 Skill 的安全摘要；不包含完整正文或敏感内容。 */
export interface SkillDiagnostic {
  /** 诊断归属的目录范围。 */
  source: SkillSource
  /** 出错文件路径；目录不存在时可以省略。 */
  path?: string
  /** 供 CLI 输出的简短原因。 */
  message: string
}

/**
 * 一次发现操作的结果。overridden 保存仍然合法、但被项目级同名 Skill 覆盖的用户级条目，
 * 以便 `/skills` 向用户解释优先级，而不是让它们无声消失。
 */
export interface SkillCatalog {
  skills: Skill[]
  overridden: Skill[]
  diagnostics: SkillDiagnostic[]
}

/** 当前交互 Runtime 已显式激活的 Skill；该状态绝不写入 Session 历史。 */
export type ActiveSkill = Pick<Skill, 'name' | 'source' | 'instructions' | 'allowedTools'>

/** 激活结果包含未知工具，CLI 可提示用户但不把该名称变成可用工具。 */
export interface SkillActivation {
  skill: ActiveSkill
  unknownTools: string[]
}
