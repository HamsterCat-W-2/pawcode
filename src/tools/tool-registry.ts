import type { ToolDefinition } from '../domain/tool.js'
import type { ContextTarget, Tool, ToolContext } from './tool.js'

export class ToolRegistry {
  private readonly tools: Map<string, Tool>
  private readonly disabledTools: Set<string>

  constructor(tools: Tool[], disabledTools: string[] = []) {
    this.tools = new Map()
    this.disabledTools = new Set(disabledTools)

    for (const tool of tools) {
      const name = tool.definition.function.name
      if (this.tools.has(name)) {
        throw new Error(`工具名称重复：${name}`)
      }
      this.tools.set(name, tool)
    }
  }

  definitions(disabledTools: string[] = []): ToolDefinition[] {
    const disabled = new Set([...this.disabledTools, ...disabledTools])
    return [...this.tools.values()]
      .filter((tool) => !disabled.has(tool.definition.function.name))
      .map((tool) => tool.definition)
  }

  /**
   * 返回所有已注册工具的完整名称，不受路径规则或 Skill 临时禁用影响。
   * SkillRegistry 用这个稳定集合计算 allowedTools 的补集，避免自行了解内置或 MCP 工具来源。
   */
  names(): string[] {
    return [...this.tools.keys()]
  }

  contextTargets(name: string, argumentsJson: string, context: ToolContext): ContextTarget[] {
    const tool = this.tools.get(name)
    if (!tool?.contextTargets) return [{ path: '.', kind: 'cwd' }]
    try {
      return tool.contextTargets(argumentsJson, context).slice(0, 16)
    } catch {
      return [{ path: '.', kind: 'cwd' }]
    }
  }

  async execute(
    name: string,
    argumentsJson: string,
    context: ToolContext,
    disabledTools: string[] = [],
  ): Promise<string> {
    if (this.disabledTools.has(name) || disabledTools.includes(name)) {
      return `工具执行失败：工具已被当前路径规则禁用：${name}`
    }
    const tool = this.tools.get(name)
    if (!tool) {
      return `工具执行失败：未知工具 ${name}`
    }

    try {
      const permissionRequest = await tool.permissionRequest?.(argumentsJson, context)
      if (permissionRequest) {
        // 权限检查放在 Registry，而不是交给 Runtime 或具体工具自行决定，确保入口唯一。
        const permission = await context.permissionManager?.authorize(permissionRequest, context.signal)
        if (!permission?.allowed) {
          return `工具执行失败：权限被拒绝：${permission?.reason ?? '没有配置权限管理器'}`
        }
      }

      const result = await tool.execute(argumentsJson, context)
      return truncate(result, context.maxOutputChars)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `工具执行失败：${message}`
    }
  }
}

function truncate(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value
  return `${value.slice(0, maxCharacters)}\n\n[工具输出已截断]`
}
