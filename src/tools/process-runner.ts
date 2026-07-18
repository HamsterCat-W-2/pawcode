import { spawn } from 'node:child_process'

export interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

export interface ProcessOptions {
  cwd: string
  timeoutMs: number
  signal?: AbortSignal
  maxCaptureChars: number
}

export function runProcess(command: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let aborted = false
    let forceKill: NodeJS.Timeout | undefined
    // shell:false 是这里的核心安全属性：模型参数不会被解释为管道、重定向或命令替换。
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // Registry 还会做最终截断；这里先限制内存占用，避免超大输出全部堆在进程内。
    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= options.maxCaptureChars) return current
      return current + chunk.toString('utf8').slice(0, options.maxCaptureChars - current.length)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })

    const stop = () => {
      // 先给程序清理机会；不响应 SIGTERM 时再强制结束，保证 timeout 真正有上界。
      child.kill('SIGTERM')
      forceKill ??= setTimeout(() => child.kill('SIGKILL'), 1_000)
    }
    const stopForAbort = () => {
      aborted = true
      stop()
    }
    if (options.signal?.aborted) stopForAbort()
    else options.signal?.addEventListener('abort', stopForAbort, { once: true })

    const timeout = setTimeout(() => {
      timedOut = true
      stop()
    }, options.timeoutMs)

    const cleanup = () => {
      clearTimeout(timeout)
      if (forceKill) clearTimeout(forceKill)
      options.signal?.removeEventListener('abort', stopForAbort)
    }

    child.once('error', (error) => {
      // spawn 失败（例如命令不存在）不会可靠地产生可用的 close 结果，单独处理。
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
    child.once('close', (exitCode) => {
      if (settled) return
      settled = true
      cleanup()
      if (aborted) {
        reject(new Error('命令已取消；进程可能已经产生部分副作用，请使用 git_diff 检查'))
        return
      }
      if (timedOut) {
        reject(new Error(`命令超过 ${options.timeoutMs}ms；进程可能已经产生部分副作用，请使用 git_diff 检查`))
        return
      }
      resolve({ stdout, stderr, exitCode })
    })
  })
}
