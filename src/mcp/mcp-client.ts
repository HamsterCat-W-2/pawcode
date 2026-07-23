import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
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

interface PendingRequest {
  /** 收到相同 id 的成功响应时完成调用方 Promise。 */
  resolve: (value: unknown) => void
  /** 协议错误、进程退出或超时时通知调用方。 */
  reject: (error: Error) => void
  /** 当前请求独立的计时器，避免一个请求拖住所有请求。 */
  timer: NodeJS.Timeout
}

export interface McpDiscoveredTool {
  serverName: string
  client: McpStdioClient
  description: McpToolDescription
}

export class McpStdioClient {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly process: ChildProcessWithoutNullStreams
  private readonly output: ReturnType<typeof createInterface>
  private closed = false

  /**
   * 只接收已启动的子进程；启动和握手由 connect() 统一管理，
   * 避免调用方拿到“进程已启动但 MCP 尚未初始化”的半成品 Client。
   */
  private constructor(
    private readonly serverName: string,
    private readonly config: McpServerConfig,
    process: ChildProcessWithoutNullStreams,
  ) {
    this.process = process
    // MCP stdio 的 stdout 只承载协议消息；readline 负责按行交付完整 JSON-RPC 消息。
    this.output = createInterface({ input: process.stdout })
    this.output.on('line', (line) => this.handleLine(line))
    // 子进程错误或退出时，所有尚未收到响应的请求都必须结束，避免 Runtime 永久等待。
    process.on('error', (error) => this.failPending(error))
    process.on('close', (code, signal) => {
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
  static async connect(serverName: string, config: McpServerConfig, workspace: string): Promise<McpStdioClient> {
    // MCP stdio 必须使用纯 JSON-RPC stdin/stdout 通道；shell=false 防止配置参数被重新解释。
    const child = spawn(config.command, config.args, {
      cwd: workspace,
      env: { ...process.env, ...config.env },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const client = new McpStdioClient(serverName, config, child)
    try {
      await client.initialize()
      return client
    } catch (error) {
      await client.close()
      throw error
    }
  }

  /**
   * 获取 Server 暴露的全部工具；分页 cursor 由本方法内部消费，调用方只接收完整数组。
   */
  async listTools(): Promise<McpToolDescription[]> {
    const tools: McpToolDescription[] = []
    let cursor: string | undefined
    do {
      // Server 可以分页返回工具；必须持续使用 nextCursor，否则模型会看不到完整工具集。
      const result = await this.request('tools/list', cursor ? { cursor } : {})
      if (!isRecord(result)) throw new Error(`MCP Server ${this.serverName} 返回了无效的 tools/list 结果`)
      const batch = Array.isArray(result.tools) ? result.tools.filter(isToolDescription) : []
      tools.push(...batch)
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
    } while (cursor)
    return tools
  }

  /**
   * 调用工具并转换为 PawCode 能处理的文本结果。
   * @param name MCP Server 原始工具名，而不是带 mcp_ 前缀的 PawCode 名称。
   * @param args 模型生成的对象参数，发送到 MCP tools/call 的 arguments 字段。
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.request('tools/call', { name, arguments: args })
    if (!isRecord(result)) throw new Error(`MCP Server ${this.serverName} 返回了无效的 tools/call 结果`)
    const content = Array.isArray(result.content) ? result.content : []
    // PawCode Tool 合约返回字符串，因此 text block 直接拼接，其余类型保留类型提示。
    const text = content
      .filter(isContentBlock)
      .map((block) => (block.type === 'text' ? block.text : `[${block.type} 内容]`))
      .join('\n')
    if (result.isError === true) return `MCP 工具返回错误：${text || '未提供错误详情'}`
    return text || 'MCP 工具未返回文本内容'
  }

  /** 关闭当前 Server，并结束所有尚未完成的请求。重复调用是安全的。 */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`MCP Server ${this.serverName} 已关闭`))
    }
    this.pending.clear()
    // 先拒绝等待者，再关闭输入和进程，避免会话切换后留下孤儿 Server。
    this.output.close()
    this.process.stdin.end()
    if (!this.process.killed) {
      this.process.kill()
      await once(this.process, 'close').catch(() => undefined)
    }
  }

  private async initialize(): Promise<void> {
    // 只有握手成功后才发现工具；失败的 Server 会在 connect() 中被完整清理。
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'pawcode', version: '0.5.0' },
    })
    this.notify('notifications/initialized', {})
  }

  private notify(method: string, params: Record<string, unknown>): void {
    // 通知没有响应 id，因此不进入 pending map，也不创建超时计时器。
    if (this.closed) return
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  /**
   * 发送需要响应的 JSON-RPC 请求。
   * @param method MCP 方法名，例如 initialize、tools/list、tools/call。
   * @param params 当前方法的参数对象；不同方法的具体结构由上层调用点保证。
   */
  private request(method: string, params: Record<string, unknown>): Promise<any> {
    if (this.closed) return Promise.reject(new Error(`MCP Server ${this.serverName} 已关闭`))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      // 每个请求独立计时，避免一个失控的 Server 阻塞整个 Agent 工具循环。
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP ${method} 超时（${this.config.timeoutMs}ms）`))
      }, this.config.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        // 每条消息单独占一行，不能把 MCP 协议数据和 PawCode 的人类输出混入同一 stdout。
        this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let message: JsonRpcResponse
    try {
      message = JSON.parse(line) as JsonRpcResponse
    } catch {
      this.failPending(new Error(`MCP Server ${this.serverName} 输出了非法 JSON`))
      return
    }
    if (message.id === undefined) return
    const id = String(message.id)
    const pending = this.pending.get(id)
    // 通知没有 id；未知 id 可能是延迟响应，不能影响其他仍在等待的请求。
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (message.error)
      pending.reject(new Error(`MCP ${message.error.code ?? 'error'}：${message.error.message ?? '未知错误'}`))
    else pending.resolve(message.result)
  }

  private failPending(error: Error): void {
    // 通道出错后无法可靠匹配后续响应，统一结束所有 pending 请求。
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export class McpTool implements Tool {
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
 */
export async function loadMcpTools(
  servers: Record<string, McpServerConfig>,
  workspace: string,
): Promise<{ tools: McpTool[]; clients: McpStdioClient[]; diagnostics: string[] }> {
  // 返回 clients 供 Runtime 在结束或切换会话时显式回收子进程。
  const tools: McpTool[] = []
  const clients: McpStdioClient[] = []
  const diagnostics: string[] = []
  for (const [serverName, config] of Object.entries(servers)) {
    if (!config.enabled) continue
    let client: McpStdioClient | undefined
    try {
      client = await McpStdioClient.connect(serverName, config, workspace)
      // 发现失败只隔离当前 Server，内置工具和其他 MCP Server 仍可继续启动。
      const descriptions = await client.listTools()
      clients.push(client)
      // 发现阶段只创建合法描述；单个 Server 的异常由外层 catch 隔离，不影响其他 Server。
      for (const description of descriptions) tools.push(new McpTool(serverName, client, description.name, description))
    } catch (error) {
      await client?.close()
      diagnostics.push(`MCP Server ${serverName} 加载失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { tools, clients, diagnostics }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isToolDescription(value: unknown): value is McpToolDescription {
  return isRecord(value) && typeof value.name === 'string' && value.name.length > 0
}

function isContentBlock(value: unknown): value is { type: string; text?: string } {
  return isRecord(value) && typeof value.type === 'string'
}
