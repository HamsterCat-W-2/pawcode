export interface ContextSource {
  kind: 'user' | 'project' | 'local' | 'memory-user' | 'memory-project'
  path: string
  relativePath?: string
  bytes: number
  hash: string
  enabled: boolean
  reason?: string
}

export interface ResolvedContext {
  systemPrompt: string
  sources: ContextSource[]
  disabledTools: string[]
  diagnostics: string[]
}
