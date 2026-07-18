import { z } from 'zod'
import { runProcess } from './process-runner.js'
import type { Tool, ToolContext } from './tool.js'
import { WorkspaceFiles } from './workspace-files.js'

const argumentsSchema = z.object({
  staged: z.boolean().default(false),
})

export class GitDiffTool implements Tool {
  readonly definition = {
    type: 'function' as const,
    function: {
      name: 'git_diff',
      description: '读取当前 Git 工作区状态和未提交 diff，不修改仓库',
      parameters: {
        type: 'object',
        properties: {
          staged: { type: 'boolean', description: '为 true 时查看已暂存 diff' },
        },
        additionalProperties: false,
      },
    },
  }

  async execute(argumentsJson: string, context: ToolContext): Promise<string> {
    const args = argumentsSchema.parse(JSON.parse(argumentsJson || '{}'))
    const files = await WorkspaceFiles.create(context.workspace)
    const cwd = await files.resolveDirectory('.')
    // status 能显示未跟踪文件，diff 能显示内容变化；两者合并才是完整审查视图。
    const [status, diff] = await Promise.all([
      runProcess('git', ['status', '--short'], {
        cwd,
        timeoutMs: 30_000,
        maxCaptureChars: context.maxOutputChars,
        ...(context.signal ? { signal: context.signal } : {}),
      }),
      runProcess('git', ['diff', '--no-ext-diff', ...(args.staged ? ['--cached'] : [])], {
        cwd,
        timeoutMs: 30_000,
        maxCaptureChars: context.maxOutputChars,
        ...(context.signal ? { signal: context.signal } : {}),
      }),
    ])
    if (status.exitCode !== 0 || diff.exitCode !== 0) throw new Error(status.stderr || diff.stderr || 'Git 检查失败')
    return [`status:\n${status.stdout || '工作区干净'}`, `diff:\n${diff.stdout || '没有差异'}`].join('\n\n')
  }
}
