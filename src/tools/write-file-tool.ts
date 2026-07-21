import { z } from 'zod'
import type { PermissionRequest } from '../permissions/permission-manager.js'
import type { Tool, ToolContext } from './tool.js'
import { WorkspaceFiles } from './workspace-files.js'

const argumentsSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
})

export class WriteFileTool implements Tool {
  readonly definition = {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: '在工作区内创建文件或用完整内容覆盖文件；小范围修改优先使用 apply_patch',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的文件路径' },
          content: { type: 'string', description: '文件的完整新内容' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  }

  contextTargets(argumentsJson: string) {
    const args = argumentsSchema.parse(JSON.parse(argumentsJson || '{}'))
    return [{ path: args.path, kind: 'file' as const }]
  }

  permissionRequest(argumentsJson: string): PermissionRequest {
    // 参数在授权阶段先校验，避免向用户展示与真实执行不一致的资源名称。
    const args = argumentsSchema.parse(JSON.parse(argumentsJson || '{}'))
    return {
      capability: 'write',
      tool: this.definition.function.name,
      description: `写入文件 ${args.path}`,
      resource: args.path,
    }
  }

  async execute(argumentsJson: string, context: ToolContext): Promise<string> {
    const args = argumentsSchema.parse(JSON.parse(argumentsJson || '{}'))
    const files = await WorkspaceFiles.create(context.workspace)
    return files.write(args.path, args.content)
  }
}
