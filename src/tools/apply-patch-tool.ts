import { z } from 'zod'
import type { PermissionRequest } from '../permissions/permission-manager.js'
import type { Tool, ToolContext } from './tool.js'
import { WorkspaceFiles } from './workspace-files.js'

const argumentsSchema = z.object({
  path: z.string().min(1),
  old_text: z.string().min(1),
  new_text: z.string(),
  replace_all: z.boolean().default(false),
})

export class ApplyPatchTool implements Tool {
  readonly definition = {
    type: 'function' as const,
    function: {
      name: 'apply_patch',
      description: '通过精确文本替换修改工作区文件；默认要求 old_text 只出现一次',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的文件路径' },
          old_text: { type: 'string', description: '必须与文件内容完全一致的旧文本' },
          new_text: { type: 'string', description: '替换后的新文本' },
          replace_all: { type: 'boolean', description: '是否替换全部匹配，默认 false' },
        },
        required: ['path', 'old_text', 'new_text'],
        additionalProperties: false,
      },
    },
  }

  contextTargets(argumentsJson: string) {
    const args = argumentsSchema.parse(JSON.parse(argumentsJson || '{}'))
    return [{ path: args.path, kind: 'file' as const }]
  }

  permissionRequest(argumentsJson: string): PermissionRequest {
    // 授权粒度是目标文件；具体替换内容仍由 WorkspaceFiles 做确定性校验。
    const args = argumentsSchema.parse(JSON.parse(argumentsJson || '{}'))
    return {
      capability: 'write',
      tool: this.definition.function.name,
      description: `修改文件 ${args.path}`,
      resource: args.path,
    }
  }

  async execute(argumentsJson: string, context: ToolContext): Promise<string> {
    const args = argumentsSchema.parse(JSON.parse(argumentsJson || '{}'))
    const files = await WorkspaceFiles.create(context.workspace)
    return files.replace(args.path, args.old_text, args.new_text, args.replace_all)
  }
}
