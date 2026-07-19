import { createInterface } from 'node:readline/promises'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { selectFromList } from '../src/input/cancelable-selector.js'

type ReadlineInterface = ReturnType<typeof createInterface>

describe('cancelable selector', () => {
  it('无效序号继续询问，直到返回有效选项', async () => {
    const answers = ['0', '2']
    const readline = createReadlineStub(async () => answers.shift() ?? '')
    const output = new PassThrough()

    const result = await selectFromList({
      items: ['first', 'second'],
      heading: '选择：',
      renderItem: (item) => item,
      readline,
      input: new PassThrough(),
      output,
    })

    expect(result).toEqual({ status: 'selected', value: 'second' })
    expect(readline.question).toHaveBeenCalledTimes(2)
    expect(output.read().toString()).toContain('无效的序号：0')
  })

  it('Esc 返回 cancelled，并清理临时键盘监听', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const activeChanges = vi.fn()
    const readline = createReadlineStub(
      async (_query, options) =>
        new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    )

    const pending = selectFromList({
      items: ['only'],
      heading: '选择：',
      renderItem: (item) => item,
      readline,
      input,
      output,
      onActiveChange: activeChanges,
    })
    input.emit('keypress', '', { name: 'escape' })

    await expect(pending).resolves.toEqual({ status: 'cancelled' })
    expect(input.listenerCount('keypress')).toBe(0)
    expect(activeChanges.mock.calls).toEqual([[true], [false]])
  })

  it('readline 的 Ctrl+C rejection 也作为用户取消返回', async () => {
    const readline = createReadlineStub(async () => {
      throw new Error('Aborted with Ctrl+C')
    })

    const result = await selectFromList({
      items: ['only'],
      heading: '选择：',
      renderItem: (item) => item,
      readline,
      input: new PassThrough(),
      output: new PassThrough(),
    })

    expect(result).toEqual({ status: 'cancelled' })
  })

  it('列表渲染失败时仍清理监听和 active 状态', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const activeChanges = vi.fn()
    const readline = createReadlineStub(async () => '1')

    await expect(
      selectFromList({
        items: ['broken'],
        heading: '选择：',
        renderItem: () => {
          throw new Error('render failed')
        },
        readline,
        input,
        output,
        onActiveChange: activeChanges,
      }),
    ).rejects.toThrow('render failed')

    expect(input.listenerCount('keypress')).toBe(0)
    expect(activeChanges.mock.calls).toEqual([[true], [false]])
  })

  it('外部信号已经取消时不渲染也不注册监听', async () => {
    const controller = new AbortController()
    controller.abort()
    const input = new PassThrough()
    const output = new PassThrough()
    const renderItem = vi.fn((item: string) => item)
    const activeChanges = vi.fn()
    const readline = createReadlineStub(async () => '1')

    await expect(
      selectFromList({
        items: ['unused'],
        heading: '选择：',
        renderItem,
        readline,
        input,
        output,
        signal: controller.signal,
        onActiveChange: activeChanges,
      }),
    ).resolves.toEqual({ status: 'cancelled' })

    expect(renderItem).not.toHaveBeenCalled()
    expect(readline.question).not.toHaveBeenCalled()
    expect(input.listenerCount('keypress')).toBe(0)
    expect(activeChanges).not.toHaveBeenCalled()
  })

  it('通过索引边界选择值为 undefined 的合法选项', async () => {
    const readline = createReadlineStub(async () => '1')

    await expect(
      selectFromList({
        items: [undefined],
        heading: '选择：',
        renderItem: () => 'undefined item',
        readline,
        input: new PassThrough(),
        output: new PassThrough(),
      }),
    ).resolves.toEqual({ status: 'selected', value: undefined })
  })

  it('active=true 回调抛错后仍发送对应的 false 通知', async () => {
    const input = new PassThrough()
    const activeStates: boolean[] = []

    await expect(
      selectFromList({
        items: ['unused'],
        heading: '选择：',
        renderItem: (item) => item,
        readline: createReadlineStub(async () => '1'),
        input,
        output: new PassThrough(),
        onActiveChange: (active) => {
          activeStates.push(active)
          if (active) throw new Error('activate failed')
        },
      }),
    ).rejects.toThrow('activate failed')

    expect(activeStates).toEqual([true, false])
    expect(input.listenerCount('keypress')).toBe(0)
  })

  it('清理回调异常不会覆盖原始渲染错误', async () => {
    await expect(
      selectFromList({
        items: ['broken'],
        heading: '选择：',
        renderItem: () => {
          throw new Error('render failed')
        },
        readline: createReadlineStub(async () => '1'),
        input: new PassThrough(),
        output: new PassThrough(),
        onActiveChange: (active) => {
          if (!active) throw new Error('deactivate failed')
        },
      }),
    ).rejects.toThrow('render failed')
  })
})

function createReadlineStub(
  question: (query: string, options?: { signal?: AbortSignal }) => Promise<string>,
): ReadlineInterface {
  return {
    question: vi.fn(question),
    close: vi.fn(),
  } as unknown as ReadlineInterface
}
