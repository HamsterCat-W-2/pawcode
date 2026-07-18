import { describe, expect, it } from 'vitest'
import { formatToolFinished, formatToolStarted } from '../src/output/tool-event-renderer.js'

describe('human tool event renderer', () => {
  it('普通模式隐藏成功工具的调用和完成明细', () => {
    expect(formatToolStarted('read_file', '{"path":"README.md"}', false)).toBeUndefined()
    expect(formatToolFinished('read_file', '文件内容', false)).toBeUndefined()
  })

  it('verbose 模式展示工具参数和成功结果字符数', () => {
    expect(formatToolStarted('read_file', '{"path":"README.md"}', true)).toEqual({
      level: 'info',
      text: '\n🔧 read_file {"path":"README.md"}',
    })
    expect(formatToolFinished('read_file', '文件内容', true)).toEqual({
      level: 'info',
      text: '✓ read_file 返回 4 个字符',
    })
  })

  it('工具失败时无论是否 verbose 都展示错误', () => {
    expect(formatToolFinished('read_file', '工具执行失败：目标是目录', false)).toEqual({
      level: 'error',
      text: '✗ read_file 工具执行失败：目标是目录',
    })
  })
})
