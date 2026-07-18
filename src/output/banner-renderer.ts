const reset = '\u001B[0m'
const dim = '\u001B[90m'
const yellow = '\u001B[33m'
const cyan = '\u001B[36m'
const white = '\u001B[37m'

const logoLines = [
  '██████╗  █████╗ ██╗    ██╗ ██████╗ ██████╗ ██████╗ ███████╗',
  '██╔══██╗██╔══██╗██║    ██║██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '██████╔╝███████║██║ █╗ ██║██║     ██║   ██║██║  ██║█████╗  ',
  '██╔═══╝ ██╔══██║██║███╗██║██║     ██║   ██║██║  ██║██╔══╝  ',
  '██║     ██║  ██║╚███╔███╔╝╚██████╗╚██████╔╝██████╔╝███████╗',
  '╚═╝     ╚═╝  ╚═╝ ╚══╝╚══╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
] as const

// 每行使用不同的 256 色，使标题形成从青色到紫色的纵向渐变，同时避免引入颜色库。
const logoColors = [51, 45, 39, 99, 135, 171] as const

export interface BannerOptions {
  version: string
  provider: string
  model: string
  workspace: string
  session: string
  columns: number
  isTty: boolean
  color: boolean
}

/**
 * 生成交互模式欢迎页。非 TTY 返回空字符串，避免 Banner 污染重定向或管道输出。
 */
export function renderBanner(options: BannerOptions): string {
  if (!options.isTty) return ''

  const contentWidth = Math.max(...logoLines.map((line) => line.length), 58)
  const fullBannerWidth = contentWidth + 4
  if (options.columns < fullBannerWidth) return renderCompactBanner(options)

  const border = `╭${'─'.repeat(contentWidth + 2)}╮`
  const bottomBorder = `╰${'─'.repeat(contentWidth + 2)}╯`
  const body = logoLines.map((line, index) => {
    const padded = line.padEnd(contentWidth)
    const colored = options.color ? color256(logoColors[index] ?? logoColors[0], padded) : padded
    return `${paint(dim, '│', options.color)} ${colored} ${paint(dim, '│', options.color)}`
  })
  const tagline = center('🐾  YOUR TERMINAL CODING COMPANION', contentWidth)

  return [
    paint(dim, border, options.color),
    `${paint(dim, '│', options.color)} ${' '.repeat(contentWidth)} ${paint(dim, '│', options.color)}`,
    ...body,
    `${paint(dim, '│', options.color)} ${' '.repeat(contentWidth)} ${paint(dim, '│', options.color)}`,
    `${paint(dim, '│', options.color)} ${paint(yellow, tagline, options.color)} ${paint(dim, '│', options.color)}`,
    `${paint(dim, '│', options.color)} ${' '.repeat(contentWidth)} ${paint(dim, '│', options.color)}`,
    paint(dim, bottomBorder, options.color),
    '',
    metadataLine('VERSION', options.version, options.color),
    metadataLine('MODEL', `${options.provider} / ${options.model}`, options.color),
    metadataLine('WORKSPACE', options.workspace, options.color),
    metadataLine('SESSION', options.session, options.color),
    metadataLine('COMMANDS', '/new  /resume  /status  /clear  /exit', options.color, true),
  ].join('\n')
}

function renderCompactBanner(options: BannerOptions): string {
  return [
    `${paint(yellow, '🐾', options.color)} ${paint(cyan, `PAWCODE v${options.version}`, options.color)}`,
    paint(dim, 'Your terminal coding companion', options.color),
    '',
    metadataLine('MODEL', `${options.provider} / ${options.model}`, options.color),
    metadataLine('WORKSPACE', options.workspace, options.color),
    metadataLine('SESSION', options.session, options.color),
  ].join('\n')
}

function metadataLine(label: string, value: string, color: boolean, subdued = false): string {
  const paddedLabel = label.padEnd(10)
  return `  ${paint(cyan, paddedLabel, color)} ${paint(subdued ? dim : white, value, color)}`
}

function center(value: string, width: number): string {
  // Emoji 在常见终端占两列；这里额外计入一列，使左右留白视觉上保持居中。
  const visualWidth = value.length + 1
  const left = Math.max(0, Math.floor((width - visualWidth) / 2))
  return `${' '.repeat(left)}${value}`.padEnd(width - 1)
}

function color256(code: number, value: string): string {
  return `\u001B[38;5;${code}m${value}${reset}`
}

function paint(code: string, value: string, enabled: boolean): string {
  return enabled ? `${code}${value}${reset}` : value
}
