import type { Message } from '../domain/message.js'
import type { SessionRecord } from '../sessions/session-schema.js'

const summaryPrefix = '[PawCode 历史摘要]'
const shellSafeIdentifier = /^[A-Za-z0-9._-]+$/

/**
 * 把持久化消息投影为适合终端回放的对话文本。
 *
 * system prompt、工具结果和 providerData 属于运行协议细节，不应混入用户看到的历史；
 * 上下文压缩生成的摘要是旧对话的唯一可读表示，因此作为单独角色保留。
 */
export function renderSessionHistory(messages: Message[]): string {
  const entries = messages.flatMap((message) => {
    const content = message.content?.trim()
    if (!content) return []

    if (message.role === 'user') return [`你 > ${content}`]
    if (message.role === 'assistant') return [`PawCode > ${content}`]
    if (message.role === 'system' && content.startsWith(summaryPrefix)) {
      const summary = content.slice(summaryPrefix.length).trim()
      return summary ? [`历史摘要 > ${summary}`] : []
    }
    return []
  })

  if (entries.length === 0) return ''
  return `\n── 已恢复的对话历史 ──\n\n${entries.join('\n\n')}\n\n── 继续对话 ──\n`
}

/** 生成退出时可直接复制的恢复命令；复杂名称回退到始终安全的 Session ID。 */
export function renderResumeHint(record: SessionRecord): string {
  const identifier = record.name && shellSafeIdentifier.test(record.name) ? record.name : record.id
  return [
    '',
    '会话已保存。下次可运行：',
    `  pawcode --resume ${identifier}`,
    '',
    '或恢复当前项目最近更新的会话：',
    '  pawcode --continue',
    '',
  ].join('\n')
}
