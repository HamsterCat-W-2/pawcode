import { z } from 'zod'
import type { Tool, ToolContext } from './tool.js'
import { WorkspaceFiles } from './workspace-files.js'

const argumentsSchema = z.object({
  query: z.string().min(1),
  path: z.string().default('.'),
  max_results: z.number().int().positive().max(200).default(50),
})

export class GrepTool implements Tool {
  readonly definition = {
    type: 'function' as const,
    function: {
      name: 'grep',
      description: '在工作区文本文件中搜索字符串并返回文件、行号和内容',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '需要搜索的文本' },
          path: { type: 'string', description: '相对工作区的文件或目录' },
          max_results: { type: 'integer', minimum: 1, maximum: 200 },
        },
        required: ['query'],
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
    const matches = await files.grep(args.query, args.path, args.max_results)
    return matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join('\n') || `没有找到：${args.query}`
  }
}
