import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'
import type { McpServerConfig } from '../config/config.js'
import type { ToolDefinition } from '../domain/tool.js'
import type { PermissionRequest } from '../permissions/permission-manager.js'
import type { Tool, ToolContext } from '../tools/tool.js'

interface JsonRpcResponse {
  /** JSON-RPC 版本字段；业务层只进一步解释 result/error。 */
  jsonrpc?: string
  /** 用于把异步 stdout 响应匹配回对应的 Promise；通知没有 id。 */
  id?: string | number
  /** initialize、tools/list 或 tools/call 的成功结果。 */
  result?: unknown
  /** 协议层错误，与工具执行结果中的 isError 不是同一层级。 */
  error?: { code?: number; message?: string; data?: unknown }
}

interface McpToolDescription {
  /** MCP Server 的原始工具名，tools/call 时必须使用该名称。 */
  name: string
  /** 给模型看的用途说明；缺失时由 McpTool 生成兜底描述。 */
  description?: string
  /** 直接作为模型函数参数约束的 JSON Schema。 */
  inputSchema?: Record<string, unknown>
}

interface McpToolDiscoveryResult {
  /** 当前 Server 返回的全部合法工具描述；非法项不会进入该数组。 */
  tools: McpToolDescription[]
  /** 不阻断健康工具的发现阶段问题，例如单个工具 schema 无效。 */
  diagnostics: string[]
}

interface PendingRequest {
  /** 收到相同 id 的成功响应时完成调用方 Promise。 */
  resolve: (value: unknown) => void
  /** 协议错误、进程退出或超时时通知调用方。 */
  reject: (error: Error) => void
  /** 当前请求独立的计时器，避免一个请求拖住所有请求。 */
  timer: NodeJS.Timeout
}

export type McpTimingPhase = 'spawn' | 'initialize' | 'tools/list' | 'total'

export interface McpTiming {
  /** 配置中的 Server 名称，用于把诊断归属到具体子进程。 */
  serverName: string
  /** 当前耗时所对应的生命周期阶段。 */
  phase: McpTimingPhase
  /** 使用 performance.now() 计算的墙钟耗时，单位是毫秒。 */
  elapsedMs: number
}

export interface McpLoadResult {
  /** 经过协议和 schema 校验后可以交给 ToolRegistry 的 MCP 工具。 */
  tools: McpTool[]
  /** 成功完成 initialize 和 tools/list 的 Client，供 Runtime 关闭。 */
  clients: McpStdioClient[]
  /** Server、协议和工具发现诊断，展示时不会包含敏感配置。 */
  diagnostics: string[]
  /** 各 Server 的分阶段耗时；并行阶段不能简单相加为总耗时。 */
  timings: McpTiming[]
  /** 所有启用 Server 并行加载的实际墙钟时间。 */
  elapsedMs: number
}

export interface McpDiscoveredTool {
  /** 工具所属的配置名称。 */
  serverName: string
  /** 提供该工具调用通道的 Client。 */
  client: McpStdioClient
  /** Server 返回的原始工具描述。 */
  description: McpToolDescription
}

export class McpStdioClient {
  /** 按 request id 保存等待中的 JSON-RPC 调用，响应到达后删除。 */
  private readonly pending = new Map<string, PendingRequest>()
  /** MCP Server 的子进程句柄，stdin/stdout 组成协议通道。 */
  private readonly process: ChildProcessWithoutNullStreams
  /** 把 stdout 按换行拆成独立 JSON-RPC 消息。 */
  private readonly output: ReturnType<typeof createInterface>
  /** Client 是否已经不可再接收新请求。 */
  private closed = false
  /** 资源是否已经执行过最终释放；与 closed 区分以支持错误后的幂等 close。 */
  private disposed = false

  /**
   * 只接收已启动的子进程；启动和握手由 connect() 统一管理，
   * 避免调用方拿到“进程已启动但 MCP 尚未初始化”的半成品 Client。
   */
  private constructor(
    private readonly serverName: string,
    private readonly config: McpServerConfig,
    process: ChildProcessWithoutNullStreams,
  ) {
    // 保存子进程句柄，后续 close 需要同时结束输入流和进程本身。
    this.process = process
    // MCP stdio 的 stdout 只承载协议消息；readline 负责按行交付完整 JSON-RPC 消息。
    this.output = createInterface({ input: process.stdout })
    this.output.on('line', (line) => this.handleLine(line))
    // 子进程错误或退出时，所有尚未收到响应的请求都必须结束，避免 Runtime 永久等待。
    process.on('error', (error) => {
      // error 表示当前通道不可继续使用，所有等待中的调用必须尽快结束。
      this.closed = true
      this.failPending(error)
    })
    process.on('close', (code, signal) => {
      // close 可能发生在 initialize、tools/list 或 tools/call 的任意阶段。
      this.closed = true
      this.failPending(
        new Error(`MCP Server ${serverName} 已退出（code=${code ?? 'none'}, signal=${signal ?? 'none'}）`),
      )
    })
  }

  /**
   * 启动并完成单个 Server 的 MCP 会话。
   * @param serverName 配置中的稳定名称，用于诊断、工具命名空间和权限资源标识。
   * @param config 已经经过 schema 校验和默认值填充的 Server 配置。
   * @param workspace 子进程的工作目录，使相对路径和项目本地命令按当前项目解析。
   */
  static async connect(
    serverName: string,
    config: McpServerConfig,
    workspace: string,
    onTiming?: (phase: 'spawn' | 'initialize', elapsedMs: number) => void,
  ): Promise<McpStdioClient> {
    // MCP stdio 必须使用纯 JSON-RPC stdin/stdout 通道；shell=false 防止配置参数被重新解释。
    // 只测量 spawn 调用本身，initialize 的等待时间单独记录，便于定位慢 Server。
    const spawnStartedAt = performance.now()
    const child = spawn(config.command, config.args, {
      cwd: workspace,
      env: { ...process.env, ...config.env },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    onTiming?.('spawn', performance.now() - spawnStartedAt)
    // 构造 Client 会立即挂载 stdout 和进程事件监听器，避免错过 Server 的早期输出。
    const client = new McpStdioClient(serverName, config, child)
    try {
      // initialize 成功是进入 MCP 会话的前置条件，失败时不能继续发现工具。
      const initializeStartedAt = performance.now()
      await client.initialize()
      onTiming?.('initialize', performance.now() - initializeStartedAt)
      return client
    } catch (error) {
      await client.close()
      throw error
    }
  }

  /**
   * 获取 Server 暴露的全部工具；分页 cursor 由本方法内部消费，调用方只接收完整数组。
   */
  async listTools(): Promise<McpToolDiscoveryResult> {
    // tools/list 的请求结果按页聚合；诊断单独返回，以便保留其他合法工具。
    const tools: McpToolDescription[] = []
    const diagnostics: string[] = []
    // undefined 表示第一页；有值时表示继续请求上一次响应返回的 cursor。
    let cursor: string | undefined
    // 防止异常 Server 永远返回同一个 cursor 导致客户端无限循环。
    const seenCursors = new Set<string>()
    do {
      // Server 可以分页返回工具；必须持续使用 nextCursor，否则模型会看不到完整工具集。
      const result = await this.request('tools/list', cursor ? { cursor } : {})
      if (!isRecord(result)) throw new Error(`MCP Server ${this.serverName} 返回了无效的 tools/list 结果`)
      // 缺失 tools 数组表示整页协议结构无效，不能把它误认为“这一页没有工具”。
      if (!Array.isArray(result.tools)) throw new Error(`MCP Server ${this.serverName} 的 tools/list 缺少 tools 数组`)
      for (const candidate of result.tools) {
        // 单个坏描述只跳过自身，保持同一页中其他合法工具可用。
        if (isToolDescription(candidate)) tools.push(candidate)
        else diagnostics.push(`MCP Server ${this.serverName} 返回了无效工具描述，已跳过`)
      }
      // nextCursor 如果存在必须是字符串，否则无法安全地发起下一页请求。
      if (result.nextCursor !== undefined && typeof result.nextCursor !== 'string') {
        throw new Error(`MCP Server ${this.serverName} 返回了无效的 tools/list cursor`)
      }
      cursor = result.nextCursor || undefined
      if (cursor) {
        // 重复 cursor 代表 Server 分页逻辑异常，继续请求会造成启动永久卡住。
        if (seenCursors.has(cursor)) throw new Error(`MCP Server ${this.serverName} 返回了重复的 tools/list cursor`)
        seenCursors.add(cursor)
      }
    } while (cursor)
    return { tools, diagnostics }
  }

  /**
   * 调用工具并转换为 PawCode 能处理的文本结果。
   * @param name MCP Server 原始工具名，而不是带 mcp_ 前缀的 PawCode 名称。
   * @param args 模型生成的对象参数，发送到 MCP tools/call 的 arguments 字段。
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    // name 使用 Server 原始名称；PawCode 前缀只存在于 ToolRegistry 的外部工具名中。
    const result = await this.request('tools/call', { name, arguments: args })
    if (!isRecord(result)) throw new Error(`MCP Server ${this.serverName} 返回了无效的 tools/call 结果`)
    // content 不是数组时按空内容处理，让调用方得到稳定错误文本而不是 undefined。
    const content = Array.isArray(result.content) ? result.content : []
    // PawCode Tool 合约返回字符串，因此 text block 直接拼接，其余类型保留类型提示。
    const text = content
      .filter(isContentBlock)
      .map((block) => (block.type === 'text' ? block.text : `[${block.type} 内容]`))
      .join('\n')
    // isError 是工具业务层错误，不代表 JSON-RPC 通道或 Server 进程已经损坏。
    if (result.isError === true) return `MCP 工具返回错误：${text || '未提供错误详情'}`
    return text || 'MCP 工具未返回文本内容'
  }

  /** 关闭当前 Server，并结束所有尚未完成的请求。重复调用是安全的。 */
  async close(): Promise<void> {
    // disposed 而不是 closed 作为幂等条件，因为错误路径可能已经先标记 closed。
    if (this.disposed) return
    this.closed = true
    this.disposed = true
    for (const pending of this.pending.values()) {
      // 关闭时所有等待者都必须结束；否则 AgentRuntime 会永久等待工具结果。
      clearTimeout(pending.timer)
      pending.reject(new Error(`MCP Server ${this.serverName} 已关闭`))
    }
    this.pending.clear()
    // 先拒绝等待者，再关闭输入和进程，避免会话切换后留下孤儿 Server。
    this.output.close()
    this.process.stdin.end()
    // close 事件可能已经先于这里触发；只有进程仍未退出时才等待 close，避免重复等待永不到来的事件。
    if (this.process.exitCode === null && this.process.signalCode === null) {
      if (!this.process.killed) this.process.kill()
      await once(this.process, 'close').catch(() => undefined)
    }
  }

  private async initialize(): Promise<void> {
    // 只有握手成功后才发现工具；失败的 Server 会在 connect() 中被完整清理。
    const result = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'pawcode', version: '0.5.0' },
    })
    // 只检查 PawCode 后续依赖的最小字段，不在此处复制完整 MCP schema validator。
    if (!isInitializeResult(result)) {
      throw new Error(`MCP Server ${this.serverName} 返回了无效的 initialize 结果`)
    }
    this.notify('notifications/initialized', {})
  }

  private notify(method: string, params: Record<string, unknown>): void {
    // 通知没有响应 id，因此不进入 pending map，也不创建超时计时器。
    // Client 已失效时丢弃通知，避免向已关闭 stdin 写入协议数据。
    if (this.closed) return
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  /**
   * 发送需要响应的 JSON-RPC 请求。
   * @param method MCP 方法名，例如 initialize、tools/list、tools/call。
   * @param params 当前方法的参数对象；不同方法的具体结构由上层调用点保证。
   */
  private request(method: string, params: Record<string, unknown>): Promise<any> {
    // 运行期调用在发送前再次检查状态，防止进程退出与新工具调用竞态。
    if (this.closed) return Promise.reject(new Error(`MCP Server ${this.serverName} 已关闭`))
    // 使用随机 ID 允许同一 Client 上存在多个并发请求且不会互相覆盖。
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      // 每个请求独立计时，避免一个失控的 Server 阻塞整个 Agent 工具循环。
      const timer = setTimeout(() => {
        // 超时只结束当前 Promise；tools/call 可继续保留健康 Client，启动阶段则由上层关闭。
        this.pending.delete(id)
        reject(new Error(`MCP ${method} 超时（${this.config.timeoutMs}ms）`))
      }, this.config.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        // 每条消息单独占一行，不能把 MCP 协议数据和 PawCode 的人类输出混入同一 stdout。
        this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      } catch (error) {
        // stdin 写入失败时必须同步删除 pending 和 timer，避免后续收到迟到响应时误完成调用。
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private handleLine(line: string): void {
    // 空行不是协议消息，忽略它不会影响后续按行解析。
    if (!line.trim()) return
    let message: JsonRpcResponse
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed)) throw new Error('JSON-RPC 消息必须是对象')
      message = parsed as JsonRpcResponse
    } catch {
      // 一旦 stdout 被日志或截断 JSON 污染，无法安全区分后续消息归属，因此使整个 Client 失效。
      const error = new Error(`MCP Server ${this.serverName} 输出了非法 JSON-RPC 消息`)
      this.closed = true
      this.failPending(error)
      void this.close()
      return
    }
    // 没有 id 的消息是 notification，不会完成任何 pending request。
    if (message.id === undefined) return
    const id = String(message.id)
    const pending = this.pending.get(id)
    // 通知没有 id；未知 id 可能是延迟响应，不能影响其他仍在等待的请求。
    // 迟到或未知 id 的响应不能影响仍在等待的其他请求。
    if (!pending) return
    if (!('result' in message) && !message.error) {
      // 有 id 却没有 result/error 不是可完成的 JSON-RPC 响应，关闭通道避免继续误解析。
      const error = new Error(`MCP Server ${this.serverName} 返回了不完整的 JSON-RPC 响应`)
      this.closed = true
      this.failPending(error)
      void this.close()
      return
    }
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (message.error)
      // 协议错误只拒绝对应请求；initialize/tools/list 的上层会据此决定是否关闭 Client。
      pending.reject(new Error(`MCP ${message.error.code ?? 'error'}：${message.error.message ?? '未知错误'}`))
    else pending.resolve(message.result)
  }

  private failPending(error: Error): void {
    // 同一个底层错误广播给所有等待者，保证 pending map 最终为空。
    // 通道出错后无法可靠匹配后续响应，统一结束所有 pending 请求。
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export class McpTool implements Tool {
  /** PawCode 给模型展示和 ToolRegistry 查找的完整定义。 */
  readonly definition: ToolDefinition

  /**
   * 将一个 MCP 工具包装成 PawCode Tool。
   * @param serverName 配置名，用于生成唯一工具名和权限资源。
   * @param client 已完成 initialize 的 Server Client，确保 execute 时通道可用。
   * @param remoteName MCP Server 原始工具名，调用时不能使用 PawCode 的命名空间名称。
   * @param description Server 返回的工具描述和输入 schema。
   */
  constructor(
    private readonly serverName: string,
    private readonly client: McpStdioClient,
    private readonly remoteName: string,
    description: McpToolDescription,
  ) {
    // 远端名称只用于调用；完整名称必须加入 Server 命名空间后才交给模型。
    // 加上 Server 命名空间，避免不同 MCP Server 暴露同名工具时互相覆盖。
    this.definition = {
      type: 'function',
      function: {
        name: `mcp_${serverName}_${remoteName}`,
        description: description.description ?? `MCP Server ${serverName} 提供的工具 ${remoteName}`,
        parameters: description.inputSchema ?? { type: 'object', additionalProperties: true },
      },
    }
  }

  /** MCP 工具都视为外部执行能力，统一经过 PermissionManager 的 execute 授权。 */
  permissionRequest(_argumentsJson: string, _context: ToolContext): PermissionRequest {
    // 外部工具默认按 execute 处理；ToolRegistry 会在 execute 前统一询问用户。
    return {
      capability: 'execute',
      tool: this.definition.function.name,
      description: `调用 MCP 工具 ${this.serverName}/${this.remoteName}`,
      resource: `mcp://${this.serverName}/${this.remoteName}`,
    }
  }

  async execute(argumentsJson: string): Promise<string> {
    // 模型传入的是 ToolRegistry 约定的 JSON 字符串，MCP tools/call 要求 arguments 为对象。
    // 空字符串按空对象处理，其他非法 JSON 交给 ToolRegistry 统一转换为工具失败。
    const parsed: unknown = JSON.parse(argumentsJson || '{}')
    if (!isRecord(parsed)) throw new Error('MCP 工具参数必须是 JSON 对象')
    return this.client.callTool(this.remoteName, parsed)
  }
}

/**
 * 按配置加载所有启用 Server；返回 diagnostics 而不是直接抛出，
 * 这样一个 MCP Server 故障不会让 PawCode 的内置工具全部不可用。
 * @param servers 已按用户级、项目级、本地级合并后的 Server 集合。
 * @param workspace 所有 Server 的工作目录，通常是当前项目根目录。
 * @param reservedToolNames 已被内置工具或上游工具占用的完整名称，冲突的 MCP 工具会被跳过。
 */
export async function loadMcpTools(
  servers: Record<string, McpServerConfig>,
  workspace: string,
  reservedToolNames: string[] = [],
): Promise<McpLoadResult> {
  // 返回 clients 供 Runtime 在结束或切换会话时显式回收子进程。
  // 总计时覆盖并行任务的墙钟时间，而不是所有 Server 阶段耗时的简单累加。
  const startedAt = performance.now()
  // disabled Server 完全不 spawn，也不会影响耗时和诊断。
  const entries = Object.entries(servers).filter(([, config]) => config.enabled)
  // 不同 Server 互不依赖，可以并行启动；单个任务内部仍保持握手和发现的顺序。
  const results = await Promise.all(entries.map(([serverName, config]) => loadMcpServer(serverName, config, workspace)))
  const occupiedNames = new Set(reservedToolNames)
  const diagnostics = results.flatMap((result) => result.diagnostics)
  const tools: McpTool[] = []
  for (const result of results) {
    for (const tool of result.tools) {
      // 先占用内置名称，再按配置顺序占用 MCP 名称，保证冲突结果稳定。
      const name = tool.definition.function.name
      if (occupiedNames.has(name)) {
        diagnostics.push(`MCP 工具名称重复：${name}，已跳过该工具`)
        continue
      }
      occupiedNames.add(name)
      tools.push(tool)
    }
  }
  return {
    // Promise.all 按输入顺序返回结果，保证并行后工具列表顺序仍然稳定。
    tools,
    clients: results.flatMap((result) => (result.client ? [result.client] : [])),
    diagnostics,
    timings: results.flatMap((result) => result.timings),
    elapsedMs: performance.now() - startedAt,
  }
}

interface McpServerLoadResult {
  tools: McpTool[]
  client?: McpStdioClient
  diagnostics: string[]
  timings: McpTiming[]
}

async function loadMcpServer(
  serverName: string,
  config: McpServerConfig,
  workspace: string,
): Promise<McpServerLoadResult> {
  // 每个 Server 独立返回结果，Promise.all 不会因为某一个 Server 失败而提前 reject。
  const startedAt = performance.now()
  // 阶段数组用于 --verbose-startup；失败阶段之前已记录的时间仍然保留。
  const timings: McpTiming[] = []
  const recordTiming = (phase: McpTimingPhase, elapsedMs: number): void => {
    timings.push({ serverName, phase, elapsedMs })
  }
  let client: McpStdioClient | undefined
  try {
    client = await McpStdioClient.connect(serverName, config, workspace, (phase, elapsedMs) =>
      recordTiming(phase, elapsedMs),
    )
    const discoveryStartedAt = performance.now()
    // 发现失败只隔离当前 Server，内置工具和其他 MCP Server 仍可继续启动。
    const discovery = await client.listTools()
    recordTiming('tools/list', performance.now() - discoveryStartedAt)
    return {
      tools: discovery.tools.map((description) => new McpTool(serverName, client!, description.name, description)),
      client,
      diagnostics: discovery.diagnostics,
      timings,
    }
  } catch (error) {
    // 如果 Client 已经创建，当前任务负责立即回收；未创建时只返回启动错误。
    await client?.close()
    return {
      tools: [],
      diagnostics: [`MCP Server ${serverName} 加载失败：${error instanceof Error ? error.message : String(error)}`],
      timings,
    }
  } finally {
    // 成功和失败都记录 total，便于发现“等待超时”与“快速启动失败”的差异。
    recordTiming('total', performance.now() - startedAt)
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  // MCP 返回值可能来自完全无类型的外部进程，所有深层字段读取前先通过此守卫。
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isToolDescription(value: unknown): value is McpToolDescription {
  // name 是唯一不可缺失的字段；其他字段按兼容策略做最小校验。
  if (!isRecord(value) || typeof value.name !== 'string' || value.name.length === 0) return false
  if (value.description !== undefined && typeof value.description !== 'string') return false
  return value.inputSchema === undefined || isInputSchema(value.inputSchema)
}

function isInputSchema(value: unknown): value is Record<string, unknown> {
  // 不实现完整 JSON Schema，只校验 PawCode 传给模型时必需的对象形状。
  if (!isRecord(value)) return false
  if (value.type !== undefined && value.type !== 'object') return false
  if (value.properties !== undefined && !isRecord(value.properties)) return false
  if (
    value.required !== undefined &&
    (!Array.isArray(value.required) || value.required.some((item) => typeof item !== 'string'))
  ) {
    return false
  }
  return true
}

function isInitializeResult(value: unknown): boolean {
  // initialize 是建立会话的协议边界，至少需要版本、能力和 Server 身份。
  if (!isRecord(value)) return false
  if (typeof value.protocolVersion !== 'string' || !isRecord(value.capabilities)) return false
  if (!isRecord(value.serverInfo)) return false
  return typeof value.serverInfo.name === 'string' && typeof value.serverInfo.version === 'string'
}

function isContentBlock(value: unknown): value is { type: string; text?: string } {
  // 非 text block 只展示类型占位，不猜测或伪造其真实内容。
  return isRecord(value) && typeof value.type === 'string'
}
