const toolFailurePrefix = '工具执行失败：'

export interface HumanToolLine {
  level: 'info' | 'error'
  text: string
}

/**
 * 普通模式隐藏工具参数，避免只读工具产生大量调试噪声；verbose 模式才返回完整调用明细。
 */
export function formatToolStarted(name: string, argumentsJson: string, verbose: boolean): HumanToolLine | undefined {
  if (!verbose) return undefined
  return { level: 'info', text: `\n🔧 ${name} ${argumentsJson}` }
}

/**
 * 成功结果的字符数只对调试有价值，因此默认隐藏；失败必须始终显示，不能因关闭 verbose 而静默。
 */
export function formatToolFinished(name: string, result: string, verbose: boolean): HumanToolLine | undefined {
  if (result.startsWith(toolFailurePrefix)) {
    return { level: 'error', text: `✗ ${name} ${result}` }
  }
  if (!verbose) return undefined
  return { level: 'info', text: `✓ ${name} 返回 ${result.length} 个字符` }
}
