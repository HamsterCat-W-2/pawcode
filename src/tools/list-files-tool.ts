import { z } from 'zod'
import type { Tool, ToolContext } from './tool.js'
import { WorkspaceFiles } from './workspace-files.js'

const argumentsSchema = z.object({
  path: z.string().default('.'),
  max_depth: z.number().int().min(0).max(5).default(2),
})

export class ListFilesTool implements Tool {
  readonly definition = {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description: '递归列出工作区内的文件和目录',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的目录' },
          max_depth: { type: 'integer', minimum: 0, maximum: 5 },
        },
        additionalProperties: false,
      },
    },
  }

  contextTargets(argumentsJson: string) {
    const args = argumentsSchema.parse(JSON.parse(argumentsJson || '{}'))
    return [{ path: args.path, kind: 'directory' as const }]
  }

  async execute(argumentsJson: string, context: ToolContext): Promise<string> {
    const args = argumentsSchema.parse(JSON.parse(argumentsJson || '{}'))
    const files = await WorkspaceFiles.create(context.workspace)
    const entries = await files.list(args.path, args.max_depth)
    return entries.join('\n') || '目录为空'
  }
}
