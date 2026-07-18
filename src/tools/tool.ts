import type { ToolDefinition } from '../domain/tool.js'
import type { PermissionManager, PermissionRequest } from '../permissions/permission-manager.js'

export interface ToolContext {
  workspace: string
  maxOutputChars: number
  permissionManager?: PermissionManager
  signal?: AbortSignal
}

export interface Tool {
  readonly definition: ToolDefinition
  // 副作用工具必须实现此方法；ToolRegistry 会在 execute 之前统一授权。
  permissionRequest?(argumentsJson: string, context: ToolContext): Promise<PermissionRequest> | PermissionRequest
  execute(argumentsJson: string, context: ToolContext): Promise<string>
}
