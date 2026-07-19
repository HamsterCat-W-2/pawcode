import { describe, expect, it } from 'vitest'
import { isReadlineKeyboardInterrupt } from '../src/input/readline-errors.js'
import { InteractiveSignalState } from '../src/runtime/interactive-signal-state.js'

describe('interactive signal state', () => {
  it('等待输入时 Ctrl+C 请求退出会话', () => {
    const state = new InteractiveSignalState()

    expect(state.requestKeyboardExit()).toBe(true)
    expect(state.shouldExit()).toBe(true)
  })

  it('模型运行期间 Ctrl+C 不退出会话', () => {
    const state = new InteractiveSignalState()
    const controller = state.beginRun()

    expect(state.requestKeyboardExit()).toBe(false)
    expect(state.shouldExit()).toBe(false)
    expect(state.interruptRun()).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    expect(state.interruptRun()).toBe(false)

    state.endRun()
    expect(state.requestKeyboardExit()).toBe(true)
  })

  it('选择器等待期间 Ctrl+C 退出并释放 question', () => {
    const state = new InteractiveSignalState()
    const selection = state.beginSelection()

    expect(state.requestKeyboardExit()).toBe(true)
    expect(selection.signal.aborted).toBe(true)
    expect(state.shouldExit()).toBe(true)
  })

  it('重复 SIGINT 不会重复输出退出提示', () => {
    const state = new InteractiveSignalState()

    expect(state.requestKeyboardExit()).toBe(true)
    expect(state.requestKeyboardExit()).toBe(false)
  })

  it('识别 readline question 直接返回的 Ctrl+C 中断错误', () => {
    expect(isReadlineKeyboardInterrupt(new Error('Aborted with Ctrl+C'))).toBe(true)
    expect(isReadlineKeyboardInterrupt(new Error('其他错误'))).toBe(false)
  })
})
