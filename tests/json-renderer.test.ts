import { describe, expect, it } from 'vitest'
import { encodeJsonLine, toJsonEvent } from '../src/output/json-renderer.js'

describe('JSON renderer', () => {
  it('将错误转换为可序列化对象且每行都能 JSON.parse', () => {
    const events = [
      toJsonEvent({ type: 'turn_started', turn: 1 }),
      toJsonEvent({ type: 'text_delta', text: '你好 🐾' }),
      toJsonEvent({ type: 'failed', error: new Error('模型失败') }),
    ]
    const lines = events.map(encodeJsonLine)

    expect(lines.every((line) => line.endsWith('\n'))).toBe(true)
    expect(lines.map((line) => JSON.parse(line))).toEqual(events)
    expect(events.at(-1)).toEqual({ version: 1, type: 'failed', error: { message: '模型失败' } })
  })
})
