import { describe, expect, it, vi } from 'vitest'
import { PermissionManager, type PermissionRequest } from '../src/permissions/permission-manager.js'

const writeRequest: PermissionRequest = {
  capability: 'write',
  tool: 'write_file',
  description: '写入文件 src/a.ts',
  resource: 'src/a.ts',
}

describe('PermissionManager', () => {
  it('非交互模式默认拒绝副作用，显式写入规则允许', async () => {
    await expect(new PermissionManager().authorize(writeRequest)).resolves.toMatchObject({ allowed: false })
    await expect(new PermissionManager({ allowWrite: true }).authorize(writeRequest)).resolves.toEqual({
      allowed: true,
    })
  })

  it('交互确认可允许一次或记住当前会话的同一操作', async () => {
    const confirm = vi.fn(async () => 'allow_session' as const)
    const manager = new PermissionManager({ confirm })

    await expect(manager.authorize(writeRequest)).resolves.toEqual({ allowed: true })
    await expect(manager.authorize(writeRequest)).resolves.toEqual({ allowed: true })
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('危险操作即使命中规则也硬拒绝', async () => {
    const manager = new PermissionManager({ allowedCommandPrefixes: ['rm'] })
    await expect(
      manager.authorize({
        capability: 'execute',
        tool: 'run_command',
        description: '删除文件',
        resource: 'rm -rf temp',
        forbiddenReason: '禁止执行危险程序 rm',
      }),
    ).resolves.toEqual({ allowed: false, reason: '禁止执行危险程序 rm' })
  })
})
