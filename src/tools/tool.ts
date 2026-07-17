import type { ToolDefinition } from '../domain/tool.js'

export interface ToolContext {
  workspace: string
  maxOutputChars: number
}

export interface Tool {
  readonly definition: ToolDefinition
  execute(argumentsJson: string, context: ToolContext): Promise<string>
}
