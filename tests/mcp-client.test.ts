import { describe, expect, it, vi } from 'vitest'
import { performance } from 'node:perf_hooks'
import { loadMcpTools } from '../src/mcp/mcp-client.js'
import { PermissionManager } from '../src/permissions/permission-manager.js'
import { ToolRegistry } from '../src/tools/tool-registry.js'

// 基础 fixture 覆盖完整握手、工具发现和工具调用成功路径。
const serverScript = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const request = JSON.parse(line)
  if (!request.id) return
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } }) + '\\n')
  } else if (request.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'echo', description: '回显参数', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } }) + '\\n')
  } else if (request.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'echo:' + request.params.arguments.text }] } }) + '\\n')
  }
})
`

// 延迟 fixture 让两个独立 Server 同时等待，验证并行加载而不是串行累加。
const delayedServerScript = `
const readline = require('node:readline')
const delay = Number(process.env.DELAY_MS || 0)
const rl = readline.createInterface({ input: process.stdin })
const respond = (message) => setTimeout(() => process.stdout.write(JSON.stringify(message) + '\\n'), delay)
rl.on('line', (line) => {
  const request = JSON.parse(line)
  if (!request.id) return
  if (request.method === 'initialize') {
    respond({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'delayed', version: '1' } } })
  } else if (request.method === 'tools/list') {
    respond({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'echo', description: '延迟回显', inputSchema: { type: 'object' } }] } })
  }
})
`

// 该 fixture 故意污染 stdout，验证 Client 会关闭不可靠的协议通道。
const invalidJsonServerScript = `process.stdout.write('this is not JSON-RPC\\n')`

// 该 fixture 对任意 request 返回 JSON-RPC error，验证错误不会被当作成功 result。
const rpcErrorServerScript = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'fixture failure' } }) + '\\n')
})
`

// 该 fixture 完全不响应，分别用于验证 initialize 超时和 pending 清理。
const hangingServerScript = `
const readline = require('node:readline')
readline.createInterface({ input: process.stdin }).on('line', () => {})
`

// 进程在处理第一条请求前退出，验证 close code 能进入 Server 诊断。
const exitingServerScript = `process.exit(7)`

// 该 fixture 只让 tools/call 挂起，验证运行期超时不会误判为启动失败。
const callHangingServerScript = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } }) + '\\n')
  } else if (request.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'hang', inputSchema: { type: 'object' } }] } }) + '\\n')
  }
})
`

// 返回一个合法工具和两个非法描述，验证单个坏工具不会拖垮整页发现。
const invalidSchemaServerScript = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } }) + '\\n')
  } else if (request.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [
      { name: 'valid', inputSchema: { type: 'object', properties: {} } },
      { name: 'invalid-schema', inputSchema: { type: 'string' } },
      { name: 42 },
    ] } }) + '\\n')
  }
})
`

describe('MCP stdio client', () => {
  it('完成 initialize、tools/list 和 tools/call，并映射为 PawCode 工具', async () => {
    // 成功路径同时验证 MCP 名称映射和 ToolRegistry 权限入口。
    const { tools, clients, diagnostics } = await loadMcpTools(
      {
        fixture: {
          command: process.execPath,
          args: ['-e', serverScript],
          env: {},
          enabled: true,
          timeoutMs: 5_000,
        },
      },
      process.cwd(),
    )
    expect(diagnostics).toEqual([])
    expect(tools.map((tool) => tool.definition.function.name)).toEqual(['mcp_fixture_echo'])

    const confirm = vi.fn(async () => 'allow_once' as const)
    // 通过 Registry 调用，而不是直接调用 McpTool，确保测试覆盖真实权限链路。
    const result = await new ToolRegistry(tools).execute('mcp_fixture_echo', JSON.stringify({ text: 'hello' }), {
      workspace: process.cwd(),
      maxOutputChars: 1_000,
      permissionManager: new PermissionManager({ confirm }),
    })
    expect(result).toBe('echo:hello')
    expect(confirm).toHaveBeenCalledTimes(1)
    await Promise.all(clients.map((client) => client.close()))
  })

  it('权限被拒绝时不会调用 MCP 工具', async () => {
    // 没有 confirm 配置时 PermissionManager 默认拒绝外部执行能力。
    const { tools, clients } = await loadMcpTools(
      {
        fixture: {
          command: process.execPath,
          args: ['-e', serverScript],
          env: {},
          enabled: true,
          timeoutMs: 5_000,
        },
      },
      process.cwd(),
    )
    const result = await new ToolRegistry(tools).execute('mcp_fixture_echo', JSON.stringify({ text: 'blocked' }), {
      workspace: process.cwd(),
      maxOutputChars: 1_000,
      permissionManager: new PermissionManager(),
    })
    expect(result).toContain('权限被拒绝')
    await Promise.all(clients.map((client) => client.close()))
  })

  it('并行加载不同 Server，并保留配置顺序和阶段耗时', async () => {
    // 两个 Server 都延迟 100ms；并行结果应接近单个 Server 的耗时而非两者相加。
    const startedAt = performance.now()
    const result = await loadMcpTools(
      {
        first: {
          command: process.execPath,
          args: ['-e', delayedServerScript],
          env: { DELAY_MS: '100' },
          enabled: true,
          timeoutMs: 5_000,
        },
        second: {
          command: process.execPath,
          args: ['-e', delayedServerScript],
          env: { DELAY_MS: '100' },
          enabled: true,
          timeoutMs: 5_000,
        },
      },
      process.cwd(),
    )

    expect(result.diagnostics).toEqual([])
    expect(result.tools.map((tool) => tool.definition.function.name)).toEqual(['mcp_first_echo', 'mcp_second_echo'])
    expect(result.timings.map((timing) => timing.phase)).toEqual([
      'spawn',
      'initialize',
      'tools/list',
      'total',
      'spawn',
      'initialize',
      'tools/list',
      'total',
    ])
    expect(result.elapsedMs).toBeLessThan(performance.now() - startedAt)
    expect(result.elapsedMs).toBeLessThan(
      result.timings.filter((timing) => timing.phase === 'total').reduce((sum, timing) => sum + timing.elapsedMs, 0),
    )
    await Promise.all(result.clients.map((client) => client.close()))
  })

  it('隔离启动失败、JSON-RPC 错误和 initialize 超时', async () => {
    // 四种 Server 同时启动，只有健康 Server 才应进入 clients/tools；这里全部故意失败。
    const result = await loadMcpTools(
      {
        missing: {
          command: '/path/that/does/not/exist',
          args: [],
          env: {},
          enabled: true,
          timeoutMs: 100,
        },
        rpcError: {
          command: process.execPath,
          args: ['-e', rpcErrorServerScript],
          env: {},
          enabled: true,
          timeoutMs: 100,
        },
        hanging: {
          command: process.execPath,
          args: ['-e', hangingServerScript],
          env: {},
          enabled: true,
          timeoutMs: 100,
        },
        exited: {
          command: process.execPath,
          args: ['-e', exitingServerScript],
          env: {},
          enabled: true,
          timeoutMs: 500,
        },
      },
      process.cwd(),
    )

    expect(result.tools).toEqual([])
    expect(result.clients).toEqual([])
    expect(result.diagnostics.join('\n')).toContain('missing')
    expect(result.diagnostics.join('\n')).toContain('fixture failure')
    expect(result.diagnostics.join('\n')).toContain('initialize 超时')
    expect(result.diagnostics.join('\n')).toContain('exited')
  })

  it('非法 stdout 和无效工具 schema 不会进入 ToolRegistry', async () => {
    // 先验证通道级非法输出，再验证工具级 schema 过滤。
    const invalidJson = await loadMcpTools(
      {
        invalidJson: {
          command: process.execPath,
          args: ['-e', invalidJsonServerScript],
          env: {},
          enabled: true,
          timeoutMs: 500,
        },
      },
      process.cwd(),
    )
    expect(invalidJson.tools).toEqual([])
    expect(invalidJson.diagnostics.join('\n')).toContain('非法 JSON-RPC')

    const invalidSchema = await loadMcpTools(
      {
        schema: {
          command: process.execPath,
          args: ['-e', invalidSchemaServerScript],
          env: {},
          enabled: true,
          timeoutMs: 500,
        },
      },
      process.cwd(),
    )
    expect(invalidSchema.tools.map((tool) => tool.definition.function.name)).toEqual(['mcp_schema_valid'])
    expect(invalidSchema.diagnostics).toHaveLength(2)
    await Promise.all(invalidSchema.clients.map((client) => client.close()))
  })

  it('跳过与预留工具名称冲突的 MCP 工具', async () => {
    // reservedToolNames 模拟内置工具名称，冲突项应产生诊断而不是让 Registry 整体抛错。
    const result = await loadMcpTools(
      {
        fixture: {
          command: process.execPath,
          args: ['-e', serverScript],
          env: {},
          enabled: true,
          timeoutMs: 500,
        },
      },
      process.cwd(),
      ['mcp_fixture_echo'],
    )
    expect(result.tools).toEqual([])
    expect(result.diagnostics).toContain('MCP 工具名称重复：mcp_fixture_echo，已跳过该工具')
    await Promise.all(result.clients.map((client) => client.close()))
  })

  it('tools/call 超时只失败当前调用，Client 仍可被显式关闭', async () => {
    // Server 已经 ready，只有 tools/call 不响应；这与启动阶段超时的处理语义不同。
    const result = await loadMcpTools(
      {
        fixture: {
          command: process.execPath,
          args: ['-e', callHangingServerScript],
          env: {},
          enabled: true,
          timeoutMs: 500,
        },
      },
      process.cwd(),
    )
    expect(result.diagnostics).toEqual([])
    expect(result.tools.map((tool) => tool.definition.function.name)).toEqual(['mcp_fixture_hang'])
    const callResult = await new ToolRegistry(result.tools).execute('mcp_fixture_hang', '{}', {
      workspace: process.cwd(),
      maxOutputChars: 1_000,
      permissionManager: new PermissionManager({ confirm: vi.fn(async () => 'allow_once' as const) }),
    })
    expect(callResult).toContain('MCP tools/call 超时')
    await Promise.all(result.clients.map((client) => client.close()))
  })
})
