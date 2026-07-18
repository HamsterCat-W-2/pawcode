export type PermissionCapability = 'write' | 'execute'
export type PermissionDecision = 'allow' | 'ask' | 'deny'
export type PermissionConfirmation = 'allow_once' | 'allow_session' | 'deny'

export interface PermissionRequest {
  capability: PermissionCapability
  tool: string
  description: string
  resource: string
  // 硬拒绝不能被 CLI 参数或会话规则覆盖，用于明显危险的操作。
  forbiddenReason?: string
}

export interface PermissionResult {
  allowed: boolean
  reason?: string
}

export interface PermissionManagerOptions {
  allowWrite?: boolean
  allowedCommandPrefixes?: string[]
  confirm?: (request: PermissionRequest) => Promise<PermissionConfirmation>
}

export class PermissionManager {
  // 会话规则只存在内存中；退出 PawCode 后不会留下隐式的永久授权。
  private readonly sessionRules = new Set<string>()
  private readonly allowedCommandPrefixes: string[]

  constructor(private readonly options: PermissionManagerOptions = {}) {
    this.allowedCommandPrefixes = (options.allowedCommandPrefixes ?? []).map(normalizeResource).filter(Boolean)
  }

  evaluate(request: PermissionRequest): PermissionDecision {
    // 顺序属于安全边界：硬拒绝必须先于所有 allow 规则判断。
    if (request.forbiddenReason) return 'deny'
    if (this.sessionRules.has(ruleKey(request))) return 'allow'
    if (request.capability === 'write' && this.options.allowWrite) return 'allow'
    if (
      request.capability === 'execute' &&
      this.allowedCommandPrefixes.some((prefix) => commandPrefixMatches(request.resource, prefix))
    ) {
      return 'allow'
    }
    return this.options.confirm ? 'ask' : 'deny'
  }

  async authorize(request: PermissionRequest): Promise<PermissionResult> {
    const decision = this.evaluate(request)
    if (decision === 'allow') return { allowed: true }
    if (decision === 'deny') {
      return {
        allowed: false,
        reason: request.forbiddenReason ?? '当前模式没有允许该操作，且无法进行交互确认',
      }
    }

    const confirmation = await this.options.confirm?.(request)
    if (confirmation === 'allow_session') {
      // 精确到 capability、tool 和 resource，避免允许一个文件后放开所有写入。
      this.sessionRules.add(ruleKey(request))
      return { allowed: true }
    }
    if (confirmation === 'allow_once') return { allowed: true }
    return { allowed: false, reason: '用户拒绝了该操作' }
  }

  clearSessionRules(): void {
    this.sessionRules.clear()
  }
}

function ruleKey(request: PermissionRequest): string {
  return `${request.capability}:${request.tool}:${normalizeResource(request.resource)}`
}

function normalizeResource(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function commandPrefixMatches(resource: string, prefix: string): boolean {
  const normalized = normalizeResource(resource)
  // 要求空格边界，避免规则 `pnpm test` 意外匹配 `pnpm testing`。
  return normalized === prefix || normalized.startsWith(`${prefix} `)
}
