#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { stdin, stdout } from 'node:process'
import { emitKeypressEvents } from 'node:readline'
import { createInterface } from 'node:readline/promises'
import { promisify } from 'node:util'
import { Command } from 'commander'
import { loadConfig, type PawCodeConfig } from './config/config.js'
import type { Message } from './domain/message.js'
import type { ModelUsage } from './domain/model.js'
import { PiAiModelAdapter } from './models/pi-ai-model-adapter.js'
import { RetryingModelAdapter } from './models/retrying-model-adapter.js'
import { renderBanner } from './output/banner-renderer.js'
import { isBrokenPipeError } from './output/output-errors.js'
import { encodeJsonLine, toJsonEvent } from './output/json-renderer.js'
import { renderResumeHint, renderSessionHistory } from './output/session-display.js'
import { formatToolFinished, formatToolStarted, type HumanToolLine } from './output/tool-event-renderer.js'
import { PermissionManager } from './permissions/permission-manager.js'
import type { AgentEvent } from './runtime/agent-event.js'
import { AgentRuntime, createInitialMessages } from './runtime/agent-runtime.js'
import { ContextCompactor } from './runtime/context-compactor.js'
import { InteractiveSignalState, isReadlineKeyboardInterrupt } from './runtime/interactive-signal-state.js'
import { SessionManager } from './sessions/session-manager.js'
import type { SessionSummary } from './sessions/session-schema.js'
import { SessionStore } from './sessions/session-store.js'
import { ApplyPatchTool } from './tools/apply-patch-tool.js'
import { GitDiffTool } from './tools/git-diff-tool.js'
import { GrepTool } from './tools/grep-tool.js'
import { ListFilesTool } from './tools/list-files-tool.js'
import { ReadFileTool } from './tools/read-file-tool.js'
import { RunCommandTool } from './tools/run-command-tool.js'
import { ToolRegistry } from './tools/tool-registry.js'
import { WriteFileTool } from './tools/write-file-tool.js'

const execFileAsync = promisify(execFile)

// 管道消费者提前关闭（例如 `| head`）属于正常结束，不应输出未捕获的 EPIPE 堆栈。
stdout.on('error', (error) => {
  if (isBrokenPipeError(error)) process.exit(0)
  throw error
})

interface CliOptions {
  provider?: string
  model?: string
  maxTurns?: number
  allowWrite?: boolean
  allowCommand?: string[]
  continue?: boolean
  resume?: string | boolean
  forkSession?: boolean
  name?: string
  listSessions?: boolean
  json?: boolean
  verbose?: boolean
}

interface RuntimeBundle {
  runtime: AgentRuntime
  session: SessionManager
  provider: string
  model: string
}

const program = new Command()
  .name('paw')
  .description('PawCode：终端中的 AI 编程伙伴')
  .version('0.4.1')
  .argument('[prompt...]', '直接执行一次问题；省略时进入交互模式')
  .option('--provider <name>', '覆盖 .env 或恢复会话中的模型供应商')
  .option('--model <name>', '覆盖 .env 或恢复会话中的模型名称')
  .option('--max-turns <number>', '最大 Agent 轮数', parsePositiveInteger)
  .option('--allow-write', '非交互模式中允许工作区文件写入')
  .option('--allow-command <prefix>', '允许匹配前缀的命令，可重复设置', collectOption, [])
  .option('-c, --continue', '恢复当前项目最近更新的会话')
  .option('-r, --resume [session]', '按 ID/名称恢复会话；省略参数时打开选择器')
  .option('--fork-session', '恢复时复制历史并创建新的会话 ID')
  .option('-n, --name <name>', '为新会话或恢复的会话设置名称')
  .option('--list-sessions', '列出当前项目的会话后退出')
  .option('--json', '以严格 NDJSON 输出运行事件')
  .option('--verbose', '显示工具调用参数和成功结果明细')
  .parse()

const promptParts = program.args as string[]
const options = program.opts<CliOptions>()

async function main(): Promise<void> {
  if (options.continue && options.resume) throw new Error('--continue 与 --resume 不能同时使用')
  if (options.forkSession && !options.continue && !options.resume) {
    throw new Error('--fork-session 必须与 --continue 或 --resume 一起使用')
  }

  // 会话目录始终从当前工作区创建，不接受 CLI 路径参数，避免跨项目恢复。
  const store = await SessionStore.create(process.cwd())
  await store.recoverInterruptedSessions()
  if (options.listSessions) {
    renderSessions(await store.list(), options.json ?? false)
    return
  }
  if (options.json && promptParts.length === 0) throw new Error('--json 需要 prompt，或与 --list-sessions 一起使用')

  let session = await resolveSession(store)
  if (options.forkSession) {
    if (!session) throw new Error('没有可用于分支的会话')
    // fork 只复制历史；PermissionManager 是新建的内存对象，不会沿用旧会话授权。
    session = await SessionManager.fork(store, session.snapshot(), options.name)
  } else if (session && options.name) {
    await session.rename(options.name)
  }
  const resumed = session?.snapshot()
  const defaultProvider = options.provider ?? resumed?.provider
  const defaultModel = options.model ?? resumed?.model
  const config = loadConfig(process.env, {
    ...(defaultProvider ? { provider: defaultProvider } : {}),
    ...(defaultModel ? { model: defaultModel } : {}),
  })
  const provider = options.provider ?? resumed?.provider ?? config.provider
  const model = options.model ?? resumed?.model ?? config.model
  const maxTurns = options.maxTurns ?? config.maxAgentTurns

  if (resumed?.lastRunStatus === 'interrupted') {
    console.error('提示：该会话上次运行异常中断，已恢复最后一次成功保存的消息。')
  }

  if (resumed && (provider !== resumed.provider || model !== resumed.model)) {
    console.error(
      `警告：恢复会话时从 ${resumed.provider}/${resumed.model} 切换到 ${provider}/${model}，providerData 可能不兼容。`,
    )
    await session?.updateModel(provider, model)
  }
  if (resumed?.gitBranch) {
    const currentBranch = await detectGitBranch(process.cwd())
    if (currentBranch && currentBranch !== resumed.gitBranch) {
      console.error(`警告：会话创建于分支 ${resumed.gitBranch}，当前分支为 ${currentBranch}。`)
    }
  }

  if (promptParts.length > 0) {
    session ??= await createSession(store, provider, model, options.name)
    const permissionManager = createPermissionManager(options)
    const bundle = createRuntimeBundle(session, provider, model, maxTurns, config, permissionManager)
    const sessionRecord = session.snapshot()
    if (options.json) {
      // JSON 模式的 stdout 只能写协议事件，所有警告和诊断仍走 stderr。
      writeJson({
        version: 1,
        type: 'session',
        session: {
          id: sessionRecord.id,
          title: sessionRecord.title,
          ...(sessionRecord.name ? { name: sessionRecord.name } : {}),
          provider,
          model,
        },
      })
    } else {
      console.log(`会话：${sessionRecord.id}`)
    }
    await renderRun(bundle, promptParts.join(' '), options.json ? renderJsonEvent : renderHumanEvent)
    return
  }

  const readline = createInterface({ input: stdin, output: stdout })
  const permissionManager = createPermissionManager(options, async (description, signal) => {
    console.log(`\n⚠️  ${description}`)
    // 权限问题与当前 run 共用 AbortSignal，Esc/Ctrl+C 可以立即退出等待而不是卡在确认框。
    const rawAnswer = signal
      ? await readline.question('允许？[y] 本次 / [a] 本会话同一操作 / [N] 拒绝：', { signal })
      : await readline.question('允许？[y] 本次 / [a] 本会话同一操作 / [N] 拒绝：')
    const answer = rawAnswer.trim().toLowerCase()
    if (answer === 'a') return 'allow_session'
    if (answer === 'y' || answer === 'yes') return 'allow_once'
    return 'deny'
  })
  session ??= await createSession(store, provider, model, options.name)
  const bundle = createRuntimeBundle(session, provider, model, maxTurns, config, permissionManager)
  await runInteractive(bundle, store, config, maxTurns, permissionManager, readline, resumed !== undefined)
}

async function resolveSession(store: SessionStore): Promise<SessionManager | undefined> {
  // --continue 固定取最近会话；--resume 则支持稳定 ID/名称或人工选择，两者语义保持区分。
  if (options.continue) {
    const latest = await store.latest()
    if (!latest) throw new Error('当前项目没有可继续的会话')
    return SessionManager.resume(store, latest.id)
  }
  if (typeof options.resume === 'string') return SessionManager.resolve(store, options.resume)
  if (options.resume) {
    if (options.json) throw new Error('JSON 模式下 --resume 必须提供会话 ID 或名称')
    const selected = await pickSession(store)
    return SessionManager.resume(store, selected.id)
  }
  return undefined
}

async function createSession(
  store: SessionStore,
  provider: string,
  model: string,
  name?: string,
): Promise<SessionManager> {
  const session = await SessionManager.create(
    store,
    provider,
    model,
    createInitialMessages(),
    await detectGitBranch(process.cwd()),
  )
  if (name) await session.rename(name)
  return session
}

function createRuntimeBundle(
  session: SessionManager,
  provider: string,
  modelName: string,
  maxTurns: number,
  config: PawCodeConfig,
  permissionManager: PermissionManager,
): RuntimeBundle {
  const providerModel = new PiAiModelAdapter({
    provider,
    model: modelName,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  })
  const model = new RetryingModelAdapter(providerModel, {
    maxRetries: config.modelMaxRetries,
    baseDelayMs: config.modelRetryBaseDelayMs,
  })
  const compactor = new ContextCompactor({
    model,
    threshold: config.contextCompactThreshold,
    keepRecentTokens: config.contextKeepRecentTokens,
  })
  const record = session.snapshot()
  const runtime = new AgentRuntime({
    model,
    tools: new ToolRegistry([
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
    initialMessages: record.messages,
    compactor,
    onMessagesChanged: (messages) => session.updateMessages(messages),
    onContextCompacted: () => session.markCompacted(),
  })
  return { runtime, session, provider, model: modelName }
}

function createPermissionManager(
  cliOptions: CliOptions,
  confirm?: (description: string, signal?: AbortSignal) => Promise<'allow_once' | 'allow_session' | 'deny'>,
): PermissionManager {
  return new PermissionManager({
    ...(cliOptions.allowWrite ? { allowWrite: true } : {}),
    ...(cliOptions.allowCommand ? { allowedCommandPrefixes: cliOptions.allowCommand } : {}),
    ...(confirm ? { confirm: (request, signal) => confirm(request.description, signal) } : {}),
  })
}

async function runInteractive(
  initialBundle: RuntimeBundle,
  store: SessionStore,
  config: PawCodeConfig,
  maxTurns: number,
  permissionManager: PermissionManager,
  readline: ReturnType<typeof createInterface>,
  showRestoredHistory: boolean,
): Promise<void> {
  let bundle = initialBundle
  const signalState = new InteractiveSignalState()
  const handleKeyboardExit = () => {
    if (!signalState.requestKeyboardExit()) return
    stdout.write(renderResumeHint(bundle.session.snapshot()))
    readline.close()
  }
  const handleKeypress = (_value: string, key: { name?: string }) => {
    // Node 会把单独 Esc 标记为 name=escape 且 meta=true；按 name 判断才能兼容真实终端。
    if (key.name !== 'escape') return
    if (signalState.interruptRun()) return
    clearCurrentInput(readline)
  }
  // process 级监听可以与 renderRun 的一次性 SIGINT 监听并存：状态对象决定本次信号是退出还是取消运行。
  process.on('SIGINT', handleKeyboardExit)
  if (stdin.isTTY) {
    // readline 已负责 raw mode；显式启用 keypress 解析后才能区分单独的 Esc 与 Alt/方向键序列。
    emitKeypressEvents(stdin, readline)
    stdin.on('keypress', handleKeypress)
  }
  printInteractiveHeader(bundle)
  if (showRestoredHistory) printSessionHistory(bundle.session.snapshot().messages)

  try {
    while (true) {
      let input: string
      try {
        input = (await readline.question('你 > ')).trim()
      } catch (error) {
        // readline/promises 可能直接以 “Aborted with Ctrl+C” reject，此时 process SIGINT 监听器不会先执行。
        if (isReadlineKeyboardInterrupt(error)) {
          if (signalState.requestKeyboardExit()) stdout.write(renderResumeHint(bundle.session.snapshot()))
          return
        }
        // process SIGINT 已关闭 readline 时，未完成的 question 也会 reject；退出提示不能重复输出。
        if (signalState.shouldExit()) return
        throw error
      }
      if (!input) continue
      if (input === '/exit') {
        stdout.write(renderResumeHint(bundle.session.snapshot()))
        return
      }

      if (input === '/clear') {
        await bundle.runtime.clear()
        await bundle.session.markCleared()
        console.log('会话已清空\n')
        continue
      }
      if (input === '/status') {
        const record = bundle.session.snapshot()
        console.log(
          `会话：${record.id}\n标题：${record.title}\n状态：${record.lastRunStatus}\n模型：${bundle.provider}/${bundle.model}\n消息数：${bundle.runtime.messageCount()}\n压缩次数：${record.compactionCount}\n`,
        )
        continue
      }
      if (input === '/sessions') {
        renderSessions(await store.list(), false)
        continue
      }
      if (input === '/new') {
        // “本会话允许”属于内存授权，切换会话身份时必须主动清空。
        permissionManager.clearSessionRules()
        const session = await createSession(store, bundle.provider, bundle.model)
        bundle = createRuntimeBundle(session, bundle.provider, bundle.model, maxTurns, config, permissionManager)
        console.log(`已创建会话 ${session.snapshot().id}\n`)
        continue
      }
      if (input === '/resume' || input.startsWith('/resume ')) {
        try {
          permissionManager.clearSessionRules()
          const identifier = input.slice('/resume'.length).trim()
          const session = identifier
            ? await SessionManager.resolve(store, identifier)
            : await SessionManager.resume(store, (await pickSession(store, readline)).id)
          const record = session.snapshot()
          bundle = createRuntimeBundle(session, record.provider, record.model, maxTurns, config, permissionManager)
          console.log(`已恢复会话 ${record.id}：${record.title}\n`)
          printSessionHistory(record.messages)
        } catch (error) {
          console.error(`恢复失败：${error instanceof Error ? error.message : String(error)}\n`)
        }
        continue
      }
      if (input === '/rename' || input.startsWith('/rename ')) {
        try {
          const requestedName = input.slice('/rename'.length).trim()
          const name = requestedName || bundle.session.snapshot().title
          await bundle.session.rename(name)
          console.log(`会话已命名为：${name}\n`)
        } catch (error) {
          console.error(`命名失败：${error instanceof Error ? error.message : String(error)}\n`)
        }
        continue
      }
      if (input === '/branch' || input.startsWith('/branch ')) {
        try {
          permissionManager.clearSessionRules()
          const name = input.slice('/branch'.length).trim() || undefined
          const session = await SessionManager.fork(store, bundle.session.snapshot(), name)
          const record = session.snapshot()
          bundle = createRuntimeBundle(session, record.provider, record.model, maxTurns, config, permissionManager)
          console.log(`已创建会话分支 ${record.id}，原会话 ${record.parentSessionId}\n`)
        } catch (error) {
          console.error(`创建分支失败：${error instanceof Error ? error.message : String(error)}\n`)
        }
        continue
      }

      const controller = signalState.beginRun()
      try {
        await renderRun(bundle, input, renderHumanEvent, controller)
      } finally {
        signalState.endRun()
      }
    }
  } finally {
    process.removeListener('SIGINT', handleKeyboardExit)
    stdin.removeListener('keypress', handleKeypress)
    readline.close()
  }
}

function clearCurrentInput(readline: ReturnType<typeof createInterface>): void {
  // 模拟 Home + Kill Line，确保光标位于输入中间时也能清除整行，而不是只删除光标左侧。
  readline.write(null, { ctrl: true, name: 'a' })
  readline.write(null, { ctrl: true, name: 'k' })
}

function printSessionHistory(messages: Message[]): void {
  const history = renderSessionHistory(messages)
  if (history) stdout.write(history)
}

async function renderRun(
  bundle: RuntimeBundle,
  prompt: string,
  renderer: (event: AgentEvent, state: RenderState) => void,
  controller = new AbortController(),
): Promise<void> {
  const state: RenderState = { streamingText: false, thinkingShown: false }
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel)
  let terminalEventSeen = false

  await bundle.session.markRunning()
  try {
    for await (const event of bundle.runtime.run(prompt, controller.signal)) {
      renderer(event, state)
      if (event.type === 'completed') {
        terminalEventSeen = true
        await bundle.session.markCompleted(event.usage)
      } else if (event.type === 'failed') {
        terminalEventSeen = true
        await bundle.session.markFailed()
      } else if (event.type === 'cancelled') {
        terminalEventSeen = true
        await bundle.session.markCancelled()
      }
    }
    if (!terminalEventSeen) await bundle.session.markFailed()
  } catch (error) {
    await bundle.session.markFailed()
    throw error
  } finally {
    process.removeListener('SIGINT', cancel)
  }
}

interface RenderState {
  streamingText: boolean
  thinkingShown: boolean
}

function renderHumanEvent(event: AgentEvent, state: RenderState): void {
  switch (event.type) {
    case 'turn_started':
      state.thinkingShown = false
      return
    case 'thinking_delta':
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
      writeHumanToolLine(formatToolStarted(event.name, event.argumentsJson, options.verbose ?? false))
      return
    case 'tool_finished':
      writeHumanToolLine(formatToolFinished(event.name, event.result, options.verbose ?? false))
      return
    case 'context_compacted':
      console.log(
        `\n🗜️ 上下文已压缩：移除 ${event.removedMessages} 条消息，估算 Token ${event.estimatedTokensBefore} → ${event.estimatedTokensAfter}`,
      )
      return
    case 'context_compaction_failed':
      console.error(`\n上下文压缩失败，已保留原历史：${event.error.message}`)
      return
    case 'completed':
      if (state.streamingText) {
        stdout.write('\n\n')
        state.streamingText = false
      } else {
        console.log(`\nPawCode > ${event.text}\n`)
      }
      if (event.usage || event.stopReason) console.log(formatCompletionStats(event.usage, event.stopReason))
      if (event.stopReason === 'length') console.log('提示：模型达到单次输出上限，已保留当前内容，可输入“继续”。\n')
      return
    case 'cancelled':
      if (state.streamingText) stdout.write('\n')
      state.streamingText = false
      console.log('\n已取消当前请求，已保留产生的内容。\n')
      return
    case 'failed':
      if (state.streamingText) stdout.write('\n')
      state.streamingText = false
      console.error(`\n错误：${event.error.message}\n`)
  }
}

function writeHumanToolLine(line: HumanToolLine | undefined): void {
  if (!line) return
  if (line.level === 'error') console.error(line.text)
  else console.log(line.text)
}

function renderJsonEvent(event: AgentEvent): void {
  writeJson(toJsonEvent(event))
}

function renderSessions(sessions: SessionSummary[], json: boolean): void {
  if (json) {
    writeJson({ version: 1, type: 'sessions', sessions })
    return
  }
  if (sessions.length === 0) {
    console.log('当前项目没有会话。')
    return
  }
  for (const session of sessions) {
    const label = session.name ? `${session.name} — ${session.title}` : session.title
    console.log(
      `${session.id}  ${session.updatedAt}  ${session.provider}/${session.model}  ${session.messageCount} 条  ${session.lastRunStatus}  ${label}`,
    )
  }
}

async function pickSession(
  store: SessionStore,
  existingReadline?: ReturnType<typeof createInterface>,
): Promise<SessionSummary> {
  // 选择器使用更新时间倒序的快照，序号只在本次提示期间有效；脚本应使用稳定 ID 或 name。
  const sessions = await store.list()
  if (sessions.length === 0) throw new Error('当前项目没有可恢复的会话')
  console.log('\n选择会话：')
  sessions.forEach((session, index) => {
    const label = session.name ? `${session.name} — ${session.title}` : session.title
    console.log(`${index + 1}. ${label}  (${session.id})`)
  })

  const readline = existingReadline ?? createInterface({ input: stdin, output: stdout })
  try {
    const answer = (await readline.question('输入序号：')).trim()
    const index = Number(answer) - 1
    const selected = Number.isInteger(index) ? sessions[index] : undefined
    if (!selected) throw new Error(`无效的会话序号：${answer}`)
    return selected
  } finally {
    if (!existingReadline) readline.close()
  }
}

function printInteractiveHeader(bundle: RuntimeBundle): void {
  const session = bundle.session.snapshot()
  const sessionLabel = session.name
    ? `${session.name} (${session.id.slice(0, 8)})`
    : `${session.id.slice(0, 8)} — ${session.title}`
  const banner = renderBanner({
    version: '0.4.1',
    provider: bundle.provider,
    model: bundle.model,
    workspace: process.cwd(),
    session: sessionLabel,
    columns: stdout.columns ?? 80,
    isTty: stdout.isTTY === true,
    // NO_COLOR 只要存在就关闭颜色，兼容 https://no-color.org/ 的通用约定。
    color: stdout.isTTY === true && process.env.NO_COLOR === undefined,
  })
  if (banner) console.log(`\n${banner}\n`)
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

async function detectGitBranch(workspace: string): Promise<string | undefined> {
  try {
    const { stdout: branch } = await execFileAsync('git', ['branch', '--show-current'], { cwd: workspace })
    return branch.trim() || undefined
  } catch {
    return undefined
  }
}

function writeJson(value: unknown): void {
  // 集中唯一的 stdout JSON 写入口，避免某个事件意外混入人类可读装饰文本。
  stdout.write(encodeJsonLine(value))
}

function parsePositiveInteger(value: string): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) throw new Error(`必须是正整数：${value}`)
  return number
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value]
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  if (options.json) writeJson({ version: 1, type: 'failed', error: { message } })
  else console.error(`PawCode 启动失败：${message}`)
  process.exitCode = 1
})
