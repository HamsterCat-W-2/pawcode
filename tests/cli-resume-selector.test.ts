import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createInitialMessages } from '../src/runtime/agent-runtime.js'
import { SessionManager } from '../src/sessions/session-manager.js'
import { SessionStore } from '../src/sessions/session-store.js'

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const tsxImport = createRequire(import.meta.url).resolve('tsx')
const cliWaitTimeoutMs = 10_000
const temporaryWorkspaces: string[] = []

describe('CLI resume selector', () => {
  afterEach(async () => {
    await Promise.all(temporaryWorkspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })))
  })

  it('启动参数 --resume 中按 Esc 正常返回 shell', async () => {
    const workspace = await createWorkspaceWithSession()
    const cli = startCli(workspace, ['--resume'])

    try {
      await cli.waitFor('输入序号（Esc 取消）：')
      cli.process.stdin.write('\u001b')

      await expect(cli.waitForExit()).resolves.toBe(0)
      expect(cli.stderr).not.toContain('PawCode 启动失败')
    } finally {
      await cli.stop()
    }
  }, 15_000)

  it('交互 /resume 中按 Esc 返回原会话输入提示', async () => {
    const workspace = await createWorkspaceWithSession()
    const cli = startCli(workspace, ['--resume', 'selector-current'])

    try {
      const firstPrompt = await cli.waitFor('你 > ')
      cli.process.stdin.write('/resume\n')
      const selectorPrompt = await cli.waitFor('输入序号（Esc 取消）：', firstPrompt)
      cli.process.stdin.write('\u001b')

      const cancelled = await cli.waitFor('已取消恢复会话。', selectorPrompt)
      await cli.waitFor('你 > ', cancelled)
      expect(cli.stderr).not.toContain('恢复失败')
    } finally {
      // pipe 不是完整 PTY，Esc 字节可能留在 readline 缓冲区；验证提示后使用跨平台清理结束进程。
      await cli.stop()
    }
  }, 15_000)
})

async function createWorkspaceWithSession(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), 'pawcode-cli-selector-'))
  temporaryWorkspaces.push(workspace)
  const store = await SessionStore.create(workspace)
  const session = await SessionManager.create(store, 'custom', 'selector-test', createInitialMessages())
  await session.rename('selector-current')
  return workspace
}

function startCli(workspace: string, args: string[]): CliHarness {
  // 自定义 Provider 只用于完成 CLI 依赖组装；测试不发送 prompt，因此不会产生网络请求。
  const child = spawn(process.execPath, ['--import', tsxImport, cliPath, ...args], {
    cwd: workspace,
    env: {
      ...process.env,
      MODEL_PROVIDER: 'custom',
      MODEL_NAME: 'selector-test',
      MODEL_BASE_URL: 'http://127.0.0.1:1/v1',
      MODEL_API_KEY: 'selector-test-key',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return new CliHarness(child)
}

class CliHarness {
  stdout = ''
  stderr = ''
  private readonly outputWaiters = new Set<() => void>()

  constructor(readonly process: ChildProcessWithoutNullStreams) {
    process.stdout.on('data', (chunk: Buffer) => {
      this.stdout += chunk.toString('utf8')
      this.notifyOutput()
    })
    process.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8')
      this.notifyOutput()
    })
  }

  async waitFor(text: string, fromIndex = 0): Promise<number> {
    const deadline = Date.now() + cliWaitTimeoutMs
    while (true) {
      const index = this.stdout.indexOf(text, fromIndex)
      if (index >= 0) return index + text.length
      if (this.process.exitCode !== null) throw new Error(this.failureMessage(`进程提前退出，未看到：${text}`))
      if (Date.now() >= deadline) throw new Error(this.failureMessage(`等待输出超时：${text}`))
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.outputWaiters.delete(wake)
          resolve()
        }, 100)
        const wake = () => {
          clearTimeout(timer)
          this.outputWaiters.delete(wake)
          resolve()
        }
        this.outputWaiters.add(wake)
      })
    }
  }

  waitForExit(): Promise<number | null> {
    if (this.process.exitCode !== null) return Promise.resolve(this.process.exitCode)
    return new Promise((resolve, reject) => {
      const onExit = (code: number | null) => {
        clearTimeout(timer)
        resolve(code)
      }
      const timer = setTimeout(() => {
        this.process.removeListener('exit', onExit)
        reject(new Error(this.failureMessage('等待进程退出超时')))
      }, cliWaitTimeoutMs)
      this.process.once('exit', onExit)
    })
  }

  async stop(): Promise<void> {
    if (this.process.exitCode !== null) return
    // 失败路径也必须等子进程退出后再删除临时工作区，避免 CI 中出现目录竞争和孤儿进程。
    const exited = new Promise<void>((resolve) => this.process.once('exit', () => resolve()))
    this.process.kill('SIGTERM')
    const forceKill = setTimeout(() => this.process.kill('SIGKILL'), 1_000)
    await exited
    clearTimeout(forceKill)
  }

  private notifyOutput(): void {
    for (const wake of this.outputWaiters) wake()
  }

  private failureMessage(message: string): string {
    return `${message}\nstdout:\n${this.stdout}\nstderr:\n${this.stderr}`
  }
}
