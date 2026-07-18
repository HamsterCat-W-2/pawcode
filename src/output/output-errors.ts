/** 判断 stdout 管道消费者提前关闭产生的标准 EPIPE 错误。 */
export function isBrokenPipeError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EPIPE'
}
