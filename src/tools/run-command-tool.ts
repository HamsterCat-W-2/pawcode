import path from 'node:path'
import { z } from 'zod'
import type { PermissionRequest } from '../permissions/permission-manager.js'
import { runProcess } from './process-runner.js'
import type { Tool, ToolContext } from './tool.js'
import { WorkspaceFiles } from './workspace-files.js'

const argumentsSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).max(100).default([]),
  cwd: z.string().default('.'),
  timeout_ms: z.number().int().positive().max(600_000).default(120_000),
})

const forbiddenExecutables = new Set(['rm', 'sudo', 'shutdown', 'reboot', 'mkfs', 'dd'])
const shellExecutables = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh'])
const destructiveGitCommands = new Set(['reset', 'clean', 'restore', 'checkout'])

export class RunCommandTool implements Tool {
  readonly definition = {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description: '在工作区目录内执行一个程序；命令和参数分离，不经过 Shell 解析',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '可执行文件名称，例如 pnpm、git、node' },
          args: { type: 'array', items: { type: 'string' }, description: '参数数组' },
          cwd: { type: 'string', description: '相对工作区的工作目录，默认 .' },
          timeout_ms: { type: 'integer', minimum: 1, maximum: 600_000 },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  }

  contextTargets(argumentsJson: string) {
    const args = argumentsSchema.parse(JSON.parse(argumentsJson || '{}'))
    return [{ path: args.cwd, kind: 'cwd' as const }]
  }

  permissionRequest(argumentsJson: string): PermissionRequest {
    const args = argumentsSchema.parse(JSON.parse(argumentsJson || '{}'))
    const resource = formatCommand(args.command, args.args)
    // 危险性在授权前计算；PermissionManager 会让 forbiddenReason 优先于 allow 规则。
    const denied = forbiddenReason(args.command, args.args)
    return {
      capability: 'execute',
      tool: this.definition.function.name,
      description: `在 ${args.cwd} 执行 ${resource}`,
      resource,
      ...(denied ? { forbiddenReason: denied } : {}),
    }
  }

  async execute(argumentsJson: string, context: ToolContext): Promise<string> {
    const args = argumentsSchema.parse(JSON.parse(argumentsJson || '{}'))
    const files = await WorkspaceFiles.create(context.workspace)
    // cwd 必须经过与文件工具相同的 realpath 边界校验。
    const cwd = await files.resolveDirectory(args.cwd)
    const result = await runProcess(args.command, args.args, {
      cwd,
      timeoutMs: args.timeout_ms,
      maxCaptureChars: Math.max(context.maxOutputChars * 2, 20_000),
      ...(context.signal ? { signal: context.signal } : {}),
    })

    return [
      `$ ${formatCommand(args.command, args.args)}`,
      `exit_code: ${result.exitCode ?? 'signal'}`,
      ...(result.stdout ? [`stdout:\n${result.stdout}`] : []),
      ...(result.stderr ? [`stderr:\n${result.stderr}`] : []),
    ].join('\n')
  }
}

function forbiddenReason(command: string, args: string[]): string | undefined {
  // basename 同时覆盖 `rm` 与 `/bin/rm` 形式，避免绝对路径绕过名称检查。
  const executable = path.basename(command).toLowerCase()
  if (forbiddenExecutables.has(executable)) return `禁止执行危险程序 ${executable}`
  if (shellExecutables.has(executable) && args.some((argument) => argument === '-c' || argument === '--command')) {
    return '禁止通过 Shell command 选项绕过参数边界'
  }
  const destructiveGitCommand = args.find((argument) => destructiveGitCommands.has(argument))
  if (executable === 'git' && destructiveGitCommand) {
    return `禁止执行破坏性 Git 命令 git ${destructiveGitCommand}`
  }
  return undefined
}

function formatCommand(command: string, args: string[]): string {
  // 仅用于显示和权限规则匹配；执行时仍传递原始 command/args 数组。
  return [command, ...args.map((argument) => (/\s/.test(argument) ? JSON.stringify(argument) : argument))].join(' ')
}
