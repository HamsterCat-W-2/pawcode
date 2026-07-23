import { describe, expect, it, vi } from 'vitest'
import { performance } from 'node:perf_hooks'
import { loadMcpTools } from '../src/mcp/mcp-client.js'
import { PermissionManager } from '../src/permissions/permission-manager.js'
import { ToolRegistry } from '../src/tools/tool-registry.js'

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

describe('MCP stdio client', () => {
  it('完成 initialize、tools/list 和 tools/call，并映射为 PawCode 工具', async () => {
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
})
