import { describe, expect, it } from 'vitest'
import { renderBanner, type BannerOptions } from '../src/output/banner-renderer.js'

const baseOptions: BannerOptions = {
  version: '0.4.1',
  provider: 'test-provider',
  model: 'test-model',
  workspace: '/workspace/pawcode',
  session: 'v04-check (12345678)',
  columns: 120,
  isTty: true,
  color: false,
}

describe('banner renderer', () => {
  it('宽终端显示完整 PAWCODE 艺术字和运行信息', () => {
    const banner = renderBanner(baseOptions)

    expect(banner).toContain('██████╗  █████╗ ██╗    ██╗')
    expect(banner).toContain('YOUR TERMINAL CODING COMPANION')
    expect(banner).toContain('test-provider / test-model')
    expect(banner).toContain('/workspace/pawcode')
  })

  it('窄终端降级为紧凑标题', () => {
    const banner = renderBanner({ ...baseOptions, columns: 50 })

    expect(banner).toContain('🐾 PAWCODE v0.4.1')
    expect(banner).not.toContain('██████╗')
  })

  it('非 TTY 不输出 Banner，颜色关闭时不包含 ANSI 控制符', () => {
    expect(renderBanner({ ...baseOptions, isTty: false })).toBe('')
    expect(renderBanner(baseOptions)).not.toContain('\u001B[')
    expect(renderBanner({ ...baseOptions, color: true })).toContain('\u001B[')
  })
})
