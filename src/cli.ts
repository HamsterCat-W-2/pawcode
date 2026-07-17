#!/usr/bin/env node

import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { Command } from 'commander'
import { loadConfig } from './config/config.js'
import { PiAiModelAdapter } from './models/pi-ai-model-adapter.js'
import type { AgentEvent } from './runtime/agent-event.js'
import { AgentRuntime } from './runtime/agent-runtime.js'
import { GrepTool } from './tools/grep-tool.js'
import { ListFilesTool } from './tools/list-files-tool.js'
import { ReadFileTool } from './tools/read-file-tool.js'
import { ToolRegistry } from './tools/tool-registry.js'

interface CliOptions {
  provider?: string
  model?: string
  maxTurns?: number
}

const program = new Command()
  .name('paw')
  .description('PawCode：终端中的 AI 编程伙伴')
  .version('0.2.0')
  .argument('[prompt...]', '直接执行一次问题；省略时进入交互模式')
  .option('--provider <name>', '覆盖 .env 中的模型供应商')
  .option('--model <name>', '覆盖 .env 中的模型名称')
  .option('--max-turns <number>', '最大 Agent 轮数', parsePositiveInteger)
  .parse()

const promptParts = program.args as string[]
const options = program.opts<CliOptions>()

async function main(): Promise<void> {
  const config = loadConfig()
  const provider = options.provider ?? config.provider
  const modelName = options.model ?? config.model
  const maxTurns = options.maxTurns ?? config.maxAgentTurns
  const runtime = new AgentRuntime({
    model: new PiAiModelAdapter({
      provider,
      model: modelName,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    }),
    tools: new ToolRegistry([new ListFilesTool(), new ReadFileTool(), new GrepTool()]),
    toolContext: {
      workspace: process.cwd(),
      maxOutputChars: config.maxToolOutputChars,
    },
    maxTurns,
  })

  if (promptParts.length > 0) {
    await renderRun(runtime, promptParts.join(' '))
    return
  }

  await runInteractive(runtime, provider, modelName)
}

async function runInteractive(runtime: AgentRuntime, provider: string, modelName: string): Promise<void> {
  const readline = createInterface({ input: stdin, output: stdout })
  console.log('\n🐾 PawCode v0.2.0')
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
  for await (const event of runtime.run(prompt)) {
    renderEvent(event)
  }
}

function renderEvent(event: AgentEvent): void {
  switch (event.type) {
    case 'turn_started':
      return
    case 'tool_started':
      console.log(`\n🔧 ${event.name} ${event.argumentsJson}`)
      return
    case 'tool_finished':
      console.log(`✓ ${event.name} 返回 ${event.result.length} 个字符`)
      return
    case 'completed':
      console.log(`\nPawCode > ${event.text}\n`)
      return
    case 'failed':
      console.error(`\n错误：${event.error.message}\n`)
  }
}

function parsePositiveInteger(value: string): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`必须是正整数：${value}`)
  }
  return number
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`PawCode 启动失败：${message}`)
  process.exitCode = 1
})
