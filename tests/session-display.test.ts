import { describe, expect, it } from 'vitest'
import type { Message } from '../src/domain/message.js'
import { renderResumeHint, renderSessionHistory } from '../src/output/session-display.js'
import type { SessionRecord } from '../src/sessions/session-schema.js'

describe('session display', () => {
  it('只回放用户、助手和压缩摘要，隐藏运行协议细节', () => {
    const messages: Message[] = [
      { role: 'system', content: '内部 system prompt' },
      { role: 'system', content: '[PawCode 历史摘要]\n完成了旧任务' },
      { role: 'user', content: '继续处理登录问题' },
      { role: 'assistant', content: null, tool_calls: [] },
      { role: 'tool', content: '私有工具结果', tool_call_id: 'call-1' },
      { role: 'assistant', content: '已经修复', providerData: { private: true } },
    ]

    const history = renderSessionHistory(messages)
    expect(history).toContain('历史摘要 > 完成了旧任务')
    expect(history).toContain('你 > 继续处理登录问题')
    expect(history).toContain('PawCode > 已经修复')
    expect(history).not.toContain('内部 system prompt')
    expect(history).not.toContain('私有工具结果')
    expect(history).not.toContain('providerData')
  })

  it('没有可读对话时不输出空的历史区块', () => {
    expect(renderSessionHistory([{ role: 'system', content: '内部 system prompt' }])).toBe('')
  })

  it('退出提示优先使用安全名称，复杂名称回退到会话 ID', () => {
    const record = createRecord('continue-check')
    expect(renderResumeHint(record)).toContain('pawcode --resume continue-check')
    expect(renderResumeHint({ ...record, name: '包含 空格' })).toContain('pawcode --resume session-123')
    expect(renderResumeHint(record)).toContain('pawcode --continue')
  })
})

function createRecord(name: string): SessionRecord {
  return {
    schemaVersion: 1,
    id: 'session-123',
    title: '测试会话',
    name,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    workspace: '/workspace/pawcode',
    provider: 'test-provider',
    model: 'test-model',
    messages: [{ role: 'system', content: 'system' }],
    lastRunStatus: 'idle',
    compactionCount: 0,
  }
}
