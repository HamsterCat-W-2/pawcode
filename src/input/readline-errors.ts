/** Node readline/promises 在 question 等待期间收到 Ctrl+C 时会直接 reject，而不一定触发 SIGINT。 */
export function isReadlineKeyboardInterrupt(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Ctrl+C')
}
