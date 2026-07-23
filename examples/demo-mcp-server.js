import readline from 'node:readline'

// 这个 Demo Server 用于本地验证 PawCode 的 MCP stdio Client，不依赖额外 npm 包。
// stdout 只能输出 JSON-RPC 消息；调试信息应写入 stderr，避免污染 MCP 通信通道。
const input = readline.createInterface({ input: process.stdin })

const tools = [
  {
    name: 'echo',
    description: '原样返回传入的 text，用于验证 PawCode 是否成功调用 MCP 工具。',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '需要返回的文本。',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'project_info',
    description: '返回 MCP Server 启动时收到的工作目录，用于验证 cwd 配置。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
]

function send(message) {
  // 每条消息独占一行，这是 PawCode McpStdioClient 的 readline 消息边界。
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function sendResult(id, result) {
  send({ id, result })
}

function sendError(id, code, message) {
  send({ id, error: { code, message } })
}

input.on('line', (line) => {
  if (!line.trim()) return

  let request
  try {
    request = JSON.parse(line)
  } catch {
    // 协议输入非法时无法可靠判断请求 ID，只能通过 stderr 留下诊断并忽略该行。
    console.error('demo-mcp-server: received invalid JSON')
    return
  }

  // notifications/initialized 没有 id，不需要返回 JSON-RPC 响应。
  if (request.method === 'notifications/initialized') return
  if (request.id === undefined) return

  if (request.method === 'initialize') {
    sendResult(request.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'pawcode-demo-server', version: '0.5.0' },
    })
    return
  }

  if (request.method === 'tools/list') {
    sendResult(request.id, { tools })
    return
  }

  if (request.method === 'tools/call') {
    const name = request.params?.name
    const args = request.params?.arguments ?? {}

    if (name === 'echo') {
      if (typeof args.text !== 'string') {
        sendResult(request.id, {
          isError: true,
          content: [{ type: 'text', text: 'text 参数必须是字符串' }],
        })
        return
      }
      sendResult(request.id, { content: [{ type: 'text', text: `echo: ${args.text}` }] })
      return
    }

    if (name === 'project_info') {
      sendResult(request.id, {
        content: [{ type: 'text', text: `cwd: ${process.cwd()}` }],
      })
      return
    }

    sendError(request.id, -32602, `未知的工具：${String(name)}`)
    return
  }

  sendError(request.id, -32601, `未知的方法：${String(request.method)}`)
})
