#!/usr/bin/env node

import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { Command } from 'commander'
import { loadConfig } from './config/config.js'
import type { ModelUsage } from './domain/model.js'
import { PiAiModelAdapter } from './models/pi-ai-model-adapter.js'
import { PermissionManager } from './permissions/permission-manager.js'
import type { AgentEvent } from './runtime/agent-event.js'
import { AgentRuntime } from './runtime/agent-runtime.js'
import { ApplyPatchTool } from './tools/apply-patch-tool.js'
import { GitDiffTool } from './tools/git-diff-tool.js'
import { GrepTool } from './tools/grep-tool.js'
import { ListFilesTool } from './tools/list-files-tool.js'
import { ReadFileTool } from './tools/read-file-tool.js'
import { RunCommandTool } from './tools/run-command-tool.js'
import { ToolRegistry } from './tools/tool-registry.js'
import { WriteFileTool } from './tools/write-file-tool.js'

interface CliOptions {
  provider?: string
  model?: string
  maxTurns?: number
  allowWrite?: boolean
  allowCommand?: string[]
}

const program = new Command()
  .name('paw')
  .description('PawCode：终端中的 AI 编程伙伴')
  .version('0.3.0')
  .argument('[prompt...]', '直接执行一次问题；省略时进入交互模式')
  .option('--provider <name>', '覆盖 .env 中的模型供应商')
  .option('--model <name>', '覆盖 .env 中的模型名称')
  .option('--max-turns <number>', '最大 Agent 轮数', parsePositiveInteger)
  .option('--allow-write', '非交互模式中允许工作区文件写入')
  .option('--allow-command <prefix>', '允许匹配前缀的命令，可重复设置', collectOption, [])
  .parse()

const promptParts = program.args as string[]
const options = program.opts<CliOptions>()

async function main(): Promise<void> {
  const config = loadConfig()
  const provider = options.provider ?? config.provider
  const modelName = options.model ?? config.model
  const maxTurns = options.maxTurns ?? config.maxAgentTurns

  if (promptParts.length > 0) {
    // 单次模式不能安全地暂停等待确认，因此只接受启动参数中的显式 allow 规则。
    const runtime = createRuntime(
      provider,
      modelName,
      maxTurns,
      config,
      new PermissionManager({
        ...(options.allowWrite ? { allowWrite: true } : {}),
        ...(options.allowCommand ? { allowedCommandPrefixes: options.allowCommand } : {}),
      }),
    )
    await renderRun(runtime, promptParts.join(' '))
    return
  }

  const readline = createInterface({ input: stdin, output: stdout })
  // 交互会话复用同一个 readline，模型工具调用期间可暂停并向用户请求权限。
  const permissionManager = new PermissionManager({
    ...(options.allowWrite ? { allowWrite: true } : {}),
    ...(options.allowCommand ? { allowedCommandPrefixes: options.allowCommand } : {}),
    confirm: async (request) => {
      console.log(`\n⚠️  ${request.description}`)
      const answer = (await readline.question('允许？[y] 本次 / [a] 本会话同一操作 / [N] 拒绝：')).trim().toLowerCase()
      if (answer === 'a') return 'allow_session'
      if (answer === 'y' || answer === 'yes') return 'allow_once'
      return 'deny'
    },
  })
  const runtime = createRuntime(provider, modelName, maxTurns, config, permissionManager)
  await runInteractive(runtime, provider, modelName, readline)
}

function createRuntime(
  provider: string,
  modelName: string,
  maxTurns: number,
  config: ReturnType<typeof loadConfig>,
  permissionManager: PermissionManager,
): AgentRuntime {
  return new AgentRuntime({
    model: new PiAiModelAdapter({
      provider,
      model: modelName,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    }),
    tools: new ToolRegistry([
      // 所有工具只在这里注册；副作用工具仍会由 ToolRegistry 统一执行权限检查。
      new ListFilesTool(),
      new ReadFileTool(),
      new GrepTool(),
      new WriteFileTool(),
      new ApplyPatchTool(),
      new RunCommandTool(),
      new GitDiffTool(),
    ]),
    toolContext: {
      workspace: process.cwd(),
      maxOutputChars: config.maxToolOutputChars,
      permissionManager,
    },
    maxTurns,
  })
}

async function runInteractive(
  runtime: AgentRuntime,
  provider: string,
  modelName: string,
  readline: ReturnType<typeof createInterface>,
): Promise<void> {
  console.log('\n🐾 PawCode v0.3.0')
  console.log(`模型：${provider}/${modelName}`)
  console.log(`工作区：${process.cwd()}`)
  console.log('命令：/clear 清空会话，/status 查看状态，/exit 退出\n')

  try {
    while (true) {
      const input = (await readline.question('你 > ')).trim()
      if (!input) continue
      if (input === '/exit') return

      if (input === '/clear') {
        runtime.clear()
        console.log('会话已清空\n')
        continue
      }

      if (input === '/status') {
        console.log(`模型：${provider}/${modelName}\n消息数：${runtime.messageCount()}\n`)
        continue
      }

      await renderRun(runtime, input)
    }
  } finally {
    readline.close()
  }
}

async function renderRun(runtime: AgentRuntime, prompt: string): Promise<void> {
  const state: RenderState = { streamingText: false, thinkingShown: false }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel)

  try {
    for await (const event of runtime.run(prompt, controller.signal)) {
      renderEvent(event, state)
    }
  } finally {
    process.removeListener('SIGINT', cancel)
  }
}

interface RenderState {
  streamingText: boolean
  thinkingShown: boolean
}

function renderEvent(event: AgentEvent, state: RenderState): void {
  switch (event.type) {
    case 'turn_started':
      state.thinkingShown = false
      return
    case 'thinking_delta':
      // 默认不展示模型的完整推理内容，只提示当前正在生成。
      if (!state.thinkingShown && !state.streamingText) {
        console.log('\n💭 思考中...')
        state.thinkingShown = true
      }
      return
    case 'text_delta':
      if (!state.streamingText) {
        stdout.write('\nPawCode > ')
        state.streamingText = true
      }
      stdout.write(event.text)
      return
    case 'tool_started':
      if (state.streamingText) stdout.write('\n')
      state.streamingText = false
      console.log(`\n🔧 ${event.name} ${event.argumentsJson}`)
      return
    case 'tool_finished':
      console.log(`✓ ${event.name} 返回 ${event.result.length} 个字符`)
      return
    case 'completed':
      if (state.streamingText) {
        // 完整文本已经由 text_delta 输出，这里只负责收尾，避免重复打印。
        stdout.write('\n\n')
        state.streamingText = false
      } else {
        // 某些 Provider 可能只给最终消息而不产生 text_delta，保留非流式兜底。
        console.log(`\nPawCode > ${event.text}\n`)
      }
      if (event.usage || event.stopReason) {
        console.log(formatCompletionStats(event.usage, event.stopReason))
      }
      return
    case 'failed':
      if (state.streamingText) stdout.write('\n')
      state.streamingText = false
      console.error(`\n错误：${event.error.message}\n`)
  }
}

function formatCompletionStats(usage: ModelUsage | undefined, stopReason: string | undefined): string {
  const parts: string[] = []
  if (usage) {
    parts.push(`Token：${usage.inputTokens} 输入 + ${usage.outputTokens} 输出 = ${usage.totalTokens}`)
    if (usage.cacheReadTokens || usage.cacheWriteTokens) {
      parts.push(`缓存：读 ${usage.cacheReadTokens} / 写 ${usage.cacheWriteTokens}`)
    }
    if (usage.cost) parts.push(`成本：$${usage.cost.total.toFixed(6)}`)
  }
  if (stopReason) parts.push(`停止原因：${stopReason}`)
  return `📊 ${parts.join('；')}\n`
}

function parsePositiveInteger(value: string): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`必须是正整数：${value}`)
  }
  return number
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value]
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`PawCode 启动失败：${message}`)
  process.exitCode = 1
})
