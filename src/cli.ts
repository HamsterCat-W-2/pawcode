#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { stdin, stdout } from 'node:process'
import { emitKeypressEvents } from 'node:readline'
import { createInterface } from 'node:readline/promises'
import { promisify } from 'node:util'
import { Command } from 'commander'
import { loadConfig, type PawCodeConfig } from './config/config.js'
import { loadConfigFiles, type LoadedConfigFile } from './config/config-loader.js'
import { resolveContext } from './context/context-resolver.js'
import type { ResolvedContext } from './context/context-types.js'
import { DeferredContextProvider } from './context/runtime-context-provider.js'
import type { Message } from './domain/message.js'
import type { ModelUsage } from './domain/model.js'
import { selectFromList, type SelectionResult } from './input/cancelable-selector.js'
import { isReadlineKeyboardInterrupt } from './input/readline-errors.js'
import type { ModelAdapter } from './models/model-adapter.js'
import { renderBanner } from './output/banner-renderer.js'
import { isBrokenPipeError } from './output/output-errors.js'
import { encodeJsonLine, toJsonEvent } from './output/json-renderer.js'
import { renderResumeHint, renderSessionHistory } from './output/session-display.js'
import { formatToolFinished, formatToolStarted, type HumanToolLine } from './output/tool-event-renderer.js'
import { PermissionManager } from './permissions/permission-manager.js'
import type { AgentEvent } from './runtime/agent-event.js'
import { InteractiveSignalState } from './runtime/interactive-signal-state.js'
import { StartupProfiler } from './runtime/startup-profiler.js'
import { systemPrompt } from './runtime/system-prompt.js'
import { SessionManager } from './sessions/session-manager.js'
import type { SessionSummary } from './sessions/session-schema.js'
import { SessionStore } from './sessions/session-store.js'
import type { ProjectInitEvent, ProjectSnapshot } from './project/project-initializer.js'
import { PersistentMemoryStore, type MemoryScope } from './memory/memory-store.js'

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
  verboseStartup?: boolean
  showConfig?: boolean
  showContext?: string | boolean
}

interface RuntimeBundle {
  runtime: import('./runtime/agent-runtime.js').AgentRuntime
  modelAdapter: ModelAdapter
  session: SessionManager
  provider: string
  model: string
}

type SessionResolution = { status: 'ready'; session: SessionManager | undefined } | { status: 'cancelled' }

const program = new Command()
  .name('paw')
  .description('PawCode：终端中的 AI 编程伙伴')
  .version('0.4.1')
  .argument('[prompt...]', '直接执行一次问题；省略时进入交互模式')
  .option('--provider <name>', '覆盖配置文件或恢复会话中的模型供应商')
  .option('--model <name>', '覆盖配置文件或恢复会话中的模型名称')
  .option('--max-turns <number>', '最大 Agent 轮数', parsePositiveInteger)
  .option('--allow-write', '非交互模式中允许工作区文件写入')
  .option('--allow-command <prefix>', '允许匹配前缀的命令，可重复设置', collectOption, [])
  .option('-c, --continue', '恢复当前项目最近更新的会话')
  .option('-r, --resume [session]', '按 ID/名称恢复会话；省略参数时打开选择器')
  .option('--fork-session', '恢复时复制历史并创建新的会话 ID')
  .option('-n, --name <name>', '为新会话或恢复的会话设置名称')
  .option('--list-sessions', '列出当前项目的会话后退出')
  .option('--show-config', '显示分层配置来源后退出')
  .option('--show-context [path]', '显示当前加载的项目上下文；可指定工作区相对路径后退出')
  .option('--json', '以严格 NDJSON 输出运行事件')
  .option('--verbose', '显示工具调用参数和成功结果明细')
  .option('--verbose-startup', '显示启动阶段耗时诊断')
  .parse()

const promptParts = program.args as string[]
const options = program.opts<CliOptions>()

async function main(): Promise<void> {
  const startupProfiler = new StartupProfiler(options.verboseStartup === true)
  if (options.continue && options.resume) throw new Error('--continue 与 --resume 不能同时使用')
  if (options.forkSession && !options.continue && !options.resume) {
    throw new Error('--fork-session 必须与 --continue 或 --resume 一起使用')
  }

  const loadedConfig = await loadConfigFiles(process.cwd())
  startupProfiler.mark('config')
  if (options.showConfig) {
    renderConfig(loadedConfig, options.json ?? false)
    printStartupReport(startupProfiler)
    return
  }
  if (options.showContext) {
    const inspectionConfig = loadConfig(loadedConfig.config, {
      ...(options.provider ? { provider: options.provider } : {}),
      model: options.model ?? 'context-inspection',
    })
    const context = await resolveContext(
      process.cwd(),
      inspectionConfig,
      // 诊断路径不启动模型，只复用与 Runtime 相同的内置安全 system prompt。
      systemPrompt,
      typeof options.showContext === 'string' ? { targetPath: options.showContext } : {},
    )
    renderContext(context, loadedConfig.warnings, options.json ?? false)
    printStartupReport(startupProfiler)
    return
  }
  for (const warning of loadedConfig.warnings) console.error(`配置警告：${warning}`)

  // 会话目录始终从当前工作区创建，不接受 CLI 路径参数，避免跨项目恢复。
  const store = await SessionStore.create(process.cwd())
  startupProfiler.mark('session-store')
  await store.recoverInterruptedSessions()
  startupProfiler.mark('session-recovery')
  if (options.listSessions) {
    renderSessions(await store.list(), options.json ?? false)
    printStartupReport(startupProfiler)
    return
  }
  if (options.json && promptParts.length === 0) throw new Error('--json 需要 prompt，或与 --list-sessions 一起使用')

  const resolution = await resolveSession(store)
  // 启动参数 `--resume` 没有更上层的交互输入，Esc 取消后应直接正常返回 shell。
  if (resolution.status === 'cancelled') return
  let session = resolution.session
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
  const config = loadConfig(loadedConfig.config, {
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
    const context = await resolveContext(process.cwd(), config, systemPrompt)
    startupProfiler.mark('context')
    const bundle = await createRuntimeBundle(session, provider, model, maxTurns, config, permissionManager, context)
    startupProfiler.mark('runtime')
    printStartupReport(startupProfiler)
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
    await renderRun(
      bundle,
      promptParts.join(' '),
      options.json
        ? renderJsonEvent
        : (event, state) => renderHumanEvent(event, state, options.verbose ?? config.display.verboseTools),
    )
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
  const context = await resolveContext(process.cwd(), config, systemPrompt)
  startupProfiler.mark('context')
  const bundle = await createRuntimeBundle(session, provider, model, maxTurns, config, permissionManager, context)
  startupProfiler.mark('runtime')
  printStartupReport(startupProfiler)
  await runInteractive(bundle, store, config, context, maxTurns, permissionManager, readline, resumed !== undefined)
}

async function resolveSession(store: SessionStore): Promise<SessionResolution> {
  // --continue 固定取最近会话；--resume 则支持稳定 ID/名称或人工选择，两者语义保持区分。
  if (options.continue) {
    const latest = await store.latest()
    if (!latest) throw new Error('当前项目没有可继续的会话')
    return { status: 'ready', session: await SessionManager.resume(store, latest.id) }
  }
  if (typeof options.resume === 'string') {
    return { status: 'ready', session: await SessionManager.resolve(store, options.resume) }
  }
  if (options.resume) {
    if (options.json) throw new Error('JSON 模式下 --resume 必须提供会话 ID 或名称')
    const selection = await pickSession(store)
    if (selection.status === 'cancelled') return selection
    return { status: 'ready', session: await SessionManager.resume(store, selection.value.id) }
  }
  return { status: 'ready', session: undefined }
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
    [{ role: 'system', content: systemPrompt }],
    await detectGitBranch(process.cwd()),
  )
  if (name) await session.rename(name)
  return session
}

async function createRuntimeBundle(
  session: SessionManager,
  provider: string,
  modelName: string,
  maxTurns: number,
  config: PawCodeConfig,
  permissionManager: PermissionManager,
  context: ResolvedContext,
): Promise<RuntimeBundle> {
  // 模型、工具和 Runtime 只在真正进入运行路径时加载；show-* 和 list 命令无需承担这些模块成本。
  const [
    { PiAiModelAdapter },
    { RetryingModelAdapter },
    { AgentRuntime },
    { ContextCompactor },
    { ToolRegistry },
    tools,
  ] = await Promise.all([
    import('./models/pi-ai-model-adapter.js'),
    import('./models/retrying-model-adapter.js'),
    import('./runtime/agent-runtime.js'),
    import('./runtime/context-compactor.js'),
    import('./tools/tool-registry.js'),
    Promise.all([
      import('./tools/list-files-tool.js'),
      import('./tools/read-file-tool.js'),
      import('./tools/grep-tool.js'),
      import('./tools/write-file-tool.js'),
      import('./tools/apply-patch-tool.js'),
      import('./tools/run-command-tool.js'),
      import('./tools/git-diff-tool.js'),
    ]),
  ])
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
  const contextProvider = new DeferredContextProvider(context, async (initialContext) => {
    const { DynamicContextProvider } = await import('./context/runtime-context-provider.js')
    return DynamicContextProvider.create(process.cwd(), config, systemPrompt, initialContext)
  })
  const runtime = new AgentRuntime({
    model,
    tools: new ToolRegistry(
      [
        new tools[0].ListFilesTool(),
        new tools[1].ReadFileTool(),
        new tools[2].GrepTool(),
        new tools[3].WriteFileTool(),
        new tools[4].ApplyPatchTool(),
        new tools[5].RunCommandTool(),
        new tools[6].GitDiffTool(),
      ],
      context.disabledTools,
    ),
    toolContext: {
      workspace: process.cwd(),
      maxOutputChars: config.maxToolOutputChars,
      permissionManager,
    },
    maxTurns,
    initialMessages: record.messages,
    systemPrompt: context.systemPrompt,
    contextProvider,
    compactor,
    onMessagesChanged: (messages) => session.updateMessages(messages),
    onContextCompacted: () => session.markCompacted(),
  })
  return { runtime, modelAdapter: model, session, provider, model: modelName }
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
  context: ResolvedContext,
  maxTurns: number,
  permissionManager: PermissionManager,
  readline: ReturnType<typeof createInterface>,
  showRestoredHistory: boolean,
): Promise<void> {
  let bundle = initialBundle
  let selectorActive = false
  const signalState = new InteractiveSignalState()
  const handleKeyboardExit = () => {
    if (!signalState.requestKeyboardExit()) return
    stdout.write(renderResumeHint(bundle.session.snapshot()))
    readline.close()
  }
  const handleKeypress = (_value: string, key: { name?: string }) => {
    // Node 会把单独 Esc 标记为 name=escape 且 meta=true；按 name 判断才能兼容真实终端。
    if (key.name !== 'escape') return
    // 列表选择期间由公共选择器独占 Esc，避免普通输入处理抢先清空选择器提示。
    if (selectorActive) return
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
      const initCommand = parseProjectInitCommand(input)
      if (initCommand) {
        await runProjectInit(bundle.modelAdapter, permissionManager, signalState, initCommand.full, initCommand.update)
        continue
      }
      if (input === '/memory' || input.startsWith('/memory ')) {
        await runMemoryCommand(input, permissionManager)
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
        bundle = await createRuntimeBundle(
          session,
          bundle.provider,
          bundle.model,
          maxTurns,
          config,
          permissionManager,
          context,
        )
        console.log(`已创建会话 ${session.snapshot().id}\n`)
        continue
      }
      if (input === '/resume' || input.startsWith('/resume ')) {
        try {
          const identifier = input.slice('/resume'.length).trim()
          let session: SessionManager
          if (identifier) {
            session = await SessionManager.resolve(store, identifier)
          } else {
            const selectionController = signalState.beginSelection()
            let selection: SelectionResult<SessionSummary>
            try {
              selection = await pickSession(store, {
                readline,
                signal: selectionController.signal,
                onActiveChange: (active) => {
                  selectorActive = active
                },
              })
            } finally {
              signalState.endSelection()
            }
            // Esc 只取消本次选择，不应切换会话、清空授权或结束整个交互进程。
            if (selection.status === 'cancelled') {
              if (signalState.shouldExit()) return
              console.log('\n已取消恢复会话。\n')
              continue
            }
            session = await SessionManager.resume(store, selection.value.id)
          }
          // 只有实际切换成功后才清空旧会话的内存授权；取消选择必须保持原会话不变。
          permissionManager.clearSessionRules()
          const record = session.snapshot()
          bundle = await createRuntimeBundle(
            session,
            record.provider,
            record.model,
            maxTurns,
            config,
            permissionManager,
            context,
          )
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
          bundle = await createRuntimeBundle(
            session,
            record.provider,
            record.model,
            maxTurns,
            config,
            permissionManager,
            context,
          )
          console.log(`已创建会话分支 ${record.id}，原会话 ${record.parentSessionId}\n`)
        } catch (error) {
          console.error(`创建分支失败：${error instanceof Error ? error.message : String(error)}\n`)
        }
        continue
      }

      const controller = signalState.beginRun()
      try {
        await renderRun(
          bundle,
          input,
          (event, state) => renderHumanEvent(event, state, options.verbose ?? config.display.verboseTools),
          controller,
        )
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

async function runProjectInit(
  model: ModelAdapter,
  permissionManager: PermissionManager,
  signalState: InteractiveSignalState,
  full = false,
  update = false,
): Promise<void> {
  const controller = signalState.beginRun()
  try {
    // /init 是交互命令，只有用户明确调用时才加载项目扫描和生成模块。
    const { ProjectInitializer } = await import('./project/project-initializer.js')
    const initializer = new ProjectInitializer({
      workspace: process.cwd(),
      model,
      permissionManager,
    })
    const snapshot = await initializer.inspect(full ? 'full' : 'quick', controller.signal)
    if (snapshot.targetExists && !update) {
      console.log('\n项目根目录已存在 PAWCODE.md，本次未覆盖。\n')
      return
    }
    if (update && !snapshot.targetExists) {
      console.log('\n项目根目录不存在 PAWCODE.md，无法执行安全更新；请先运行 /init。\n')
      return
    }

    renderProjectInitDiagnostics(snapshot)
    console.log(`\n正在${full ? '完整分析项目并' : ''}${update ? '更新' : '生成'} PAWCODE.md...`)
    if (update) {
      const result = await initializer.generateUpdate(
        snapshot,
        full,
        (event) => renderProjectInitEvent(event),
        controller.signal,
      )
      renderProjectUpdateDiff(result.current, result.updated)
      const writeResult = await initializer.writeUpdated(result.updated, controller.signal)
      console.log(`\n${writeResult}\n`)
      return
    }
    const content = full
      ? await initializer.generateFull(snapshot, (event) => renderProjectInitEvent(event), controller.signal)
      : await initializer.generate(snapshot)
    const preview = content.length > 1_500 ? `${content.slice(0, 1_500)}\n...` : content
    console.log(`\n生成预览：\n${preview}`)
    const result = await initializer.write(content, controller.signal)
    console.log(`\n${result}\n`)
  } catch (error) {
    if (controller.signal.aborted) {
      console.log('\n已取消 /init，未写入项目上下文。\n')
      return
    }
    if (signalState.shouldExit()) return
    console.error(`\n/init 失败：${error instanceof Error ? error.message : String(error)}\n`)
  } finally {
    signalState.endRun()
  }
}

function parseProjectInitCommand(input: string): { full: boolean; update: boolean } | undefined {
  const parts = input.split(/\s+/)
  if (parts[0] !== '/init' || parts.length > 3) return undefined
  const flags = new Set(parts.slice(1))
  if ([...flags].some((flag) => flag !== '--full' && flag !== '--update')) return undefined
  return { full: flags.has('--full'), update: flags.has('--update') }
}

type MemoryCommand =
  | { type: 'list' }
  | { type: 'add'; scope: MemoryScope; content: string }
  | { type: 'remove'; scope: MemoryScope; id: string }
  | { type: 'clear'; scope: MemoryScope }

function parseMemoryCommand(input: string): MemoryCommand | undefined {
  const parts = input.split(/\s+/)
  const action = parts[1]
  if (!action) return { type: 'list' }
  const scope: MemoryScope = parts.includes('--user') ? 'user' : 'project'
  if (action === 'add') {
    const content = parts
      .slice(2)
      .filter((part) => part !== '--user' && part !== '--project')
      .join(' ')
    return { type: 'add', scope, content }
  }
  if (action === 'remove')
    return { type: 'remove', scope, id: parts.find((part) => !part.startsWith('--') && part !== 'remove') ?? '' }
  if (action === 'clear') return { type: 'clear', scope }
  return undefined
}

async function runMemoryCommand(input: string, permissionManager: PermissionManager): Promise<void> {
  const command = parseMemoryCommand(input)
  if (!command) {
    console.log(
      '\n用法：/memory | /memory add [--user|--project] <内容> | /memory remove <id> [--user] | /memory clear [--user|--project]\n',
    )
    return
  }
  const store = PersistentMemoryStore.create(process.cwd())
  try {
    if (command.type === 'list') {
      const results = await store.list()
      console.log('\n持久化记忆：')
      for (const result of results) {
        console.log(`\n[${result.scope === 'user' ? '用户级' : '项目级'}] ${result.path}`)
        if (result.diagnostic) {
          console.log(`- ${result.diagnostic}`)
          continue
        }
        if (result.entries.length === 0) console.log('- 暂无记忆')
        for (const entry of result.entries) console.log(`- ${entry.id}：${entry.content}`)
      }
      console.log()
      return
    }

    const description =
      command.type === 'add' ? '添加持久化记忆' : command.type === 'remove' ? '删除持久化记忆' : '清空持久化记忆'
    const permission = await permissionManager.authorize({
      capability: 'write',
      tool: 'memory',
      description,
      resource: `${command.scope} memory`,
    })
    if (!permission.allowed) {
      console.log(`\n记忆操作未执行：${permission.reason ?? '权限被拒绝'}\n`)
      return
    }
    if (command.type === 'add') {
      const entry = await store.add(command.scope, command.content)
      console.log(`\n已添加${command.scope === 'user' ? '用户级' : '项目级'}记忆：${entry.id}\n`)
    } else if (command.type === 'remove') {
      await store.remove(command.scope, command.id)
      console.log(`\n已删除记忆：${command.id}\n`)
    } else {
      await store.clear(command.scope)
      console.log(`\n已清空${command.scope === 'user' ? '用户级' : '项目级'}记忆。\n`)
    }
  } catch (error) {
    console.error(`\n记忆操作失败：${error instanceof Error ? error.message : String(error)}\n`)
  }
}

function renderProjectUpdateDiff(current: string, updated: string): void {
  const oldLines = current.split(/\r?\n/)
  const newLines = updated.split(/\r?\n/)
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const removed = oldLines.slice(prefix, oldLines.length - suffix)
  const added = newLines.slice(prefix, newLines.length - suffix)
  console.log(`\n更新预览：-${removed.length} 行，+${added.length} 行`)
  for (const line of removed.slice(0, 80)) console.log(`- ${line}`)
  for (const line of added.slice(0, 80)) console.log(`+ ${line}`)
  if (removed.length > 80 || added.length > 80) console.log('... 其余变更未展开')
}

function printStartupReport(profiler: StartupProfiler): void {
  const report = profiler.report()
  if (report) console.error(report)
}

function renderProjectInitEvent(event: ProjectInitEvent): void {
  switch (event.type) {
    case 'init_scan_started':
      console.log(`扫描项目：${event.fileCount} 个文件进入完整分析，拆分为 ${event.chunkCount} 个分块`)
      return
    case 'init_chunk_completed':
      console.log(`生成摘要：${event.completed}/${event.total}（${event.chunkId}）`)
      return
    case 'init_chunk_failed':
      console.error(`摘要失败：${event.chunkId}（${event.reason}）`)
      return
    case 'init_generation_completed':
      console.log(`摘要完成：${event.completedChunks} 个成功，${event.failedChunks} 个失败`)
  }
}

function renderProjectInitDiagnostics(snapshot: ProjectSnapshot): void {
  const stats = snapshot.stats
  console.log(
    `\n扫描报告：${stats.mode === 'full' ? '完整' : '快速'}模式，发现 ${stats.discoveredFiles} 个文件，纳入分析 ${stats.includedFiles} 个，读取 ${stats.selectedFiles} 个，分块 ${stats.chunkCount} 个`,
  )
  const summary: string[] = []
  if (stats.ignoredFiles > 0) summary.push(`默认安全规则跳过 ${stats.ignoredFiles} 个`)
  if (stats.gitignoredFiles > 0) summary.push(`.gitignore 跳过 ${stats.gitignoredFiles} 个`)
  if (stats.treeTruncated) summary.push('项目树达到展示上限')
  if (summary.length > 0) console.log(`扫描限制：${summary.join('；')}`)

  const diagnostics = snapshot.diagnostics ?? []
  if (diagnostics.length === 0) {
    console.log('扫描诊断：未发现跳过、读取失败或截断项。')
    return
  }
  console.log(`扫描诊断：${diagnostics.length} 项`)
  const visible = diagnostics.slice(0, 80)
  for (const diagnostic of visible) console.log(`- ${diagnostic.path}：${diagnostic.reason}`)
  if (diagnostics.length > visible.length) console.log(`- 其余 ${diagnostics.length - visible.length} 项未展开`)
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

function renderHumanEvent(event: AgentEvent, state: RenderState, verboseTools = false): void {
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
      writeHumanToolLine(formatToolStarted(event.name, event.argumentsJson, verboseTools))
      return
    case 'tool_finished':
      writeHumanToolLine(formatToolFinished(event.name, event.result, verboseTools))
      return
    case 'context_updated':
      console.log(
        `\n📚 项目上下文已刷新：${event.targetPaths.join(', ')}${event.disabledTools.length > 0 ? `，禁用工具：${event.disabledTools.join(', ')}` : ''}`,
      )
      return
    case 'context_update_failed':
      console.error(`\n项目上下文刷新失败，已保留上一份上下文：${event.error.message}`)
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

function renderConfig(loaded: LoadedConfigFile, json: boolean): void {
  const payload = {
    sources: loaded.sources,
    warnings: loaded.warnings,
    config: redactConfig(loaded.config),
  }
  if (json) {
    writeJson({ version: 1, type: 'config', ...payload })
    return
  }
  console.log('PawCode 分层配置')
  for (const source of loaded.sources) {
    const status = source.loaded ? '已加载' : '未找到'
    const overridden = source.overriddenFields.length > 0 ? `，覆盖：${source.overriddenFields.join(', ')}` : ''
    console.log(`- [${source.kind}] ${status} ${source.path}${overridden}`)
  }
  if (loaded.warnings.length > 0) for (const warning of loaded.warnings) console.error(`警告：${warning}`)
  console.log(JSON.stringify(payload.config, null, 2))
}

function renderContext(context: ResolvedContext, configWarnings: string[], json: boolean): void {
  const payload = {
    sources: context.sources,
    disabledTools: context.disabledTools,
    diagnostics: [...configWarnings, ...context.diagnostics],
  }
  if (json) {
    writeJson({ version: 1, type: 'context', ...payload })
    return
  }
  console.log('PawCode 当前上下文')
  for (const source of context.sources) {
    console.log(`- [${source.kind}] ${source.path} (${source.bytes} bytes, sha256 ${source.hash.slice(0, 12)})`)
  }
  if (context.disabledTools.length > 0) console.log(`禁用工具：${context.disabledTools.join(', ')}`)
  for (const diagnostic of payload.diagnostics) console.error(`警告：${diagnostic}`)
}

function redactConfig(config: LoadedConfigFile['config']): LoadedConfigFile['config'] {
  if (!config.model?.apiKey) return config
  return { ...config, model: { ...config.model, apiKey: '<redacted>' } }
}

interface PickSessionOptions {
  readline?: ReturnType<typeof createInterface>
  signal?: AbortSignal
  onActiveChange?: (active: boolean) => void
}

async function pickSession(
  store: SessionStore,
  options: PickSessionOptions = {},
): Promise<SelectionResult<SessionSummary>> {
  // 选择器使用更新时间倒序的快照，序号只在本次提示期间有效；脚本应使用稳定 ID 或 name。
  const sessions = await store.list()
  if (sessions.length === 0) throw new Error('当前项目没有可恢复的会话')
  return selectFromList({
    items: sessions,
    heading: '\n选择会话：',
    prompt: '输入序号（Esc 取消）：',
    renderItem: (session) => {
      const label = session.name ? `${session.name} — ${session.title}` : session.title
      return `${label}  (${session.id})`
    },
    invalidMessage: (answer) => `无效的会话序号：${answer}，请重新输入。`,
    ...(options.readline ? { readline: options.readline } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onActiveChange ? { onActiveChange: options.onActiveChange } : {}),
  })
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
