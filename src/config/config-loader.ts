import { chmod, mkdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pawCodeConfigFileSchema, type PawCodeConfigFile } from './config-schema.js'

export type ConfigSourceKind = 'user' | 'project' | 'local'

export interface ConfigSource {
  kind: ConfigSourceKind
  path: string
  loaded: boolean
  overriddenFields: string[]
}

export interface LoadedConfigFile {
  config: PawCodeConfigFile
  sources: ConfigSource[]
  warnings: string[]
}

interface ConfigLoaderOptions {
  homeDirectory?: string
}

const configFileName = 'config.json'

/**
 * 分层配置的唯一读取入口。用户级配置可以保存凭据；项目级和本地级配置出现敏感字段时直接拒绝，
 * 这样项目文件即使被提交也不能改变个人模型认证信息。
 */
export async function loadConfigFiles(workspace: string, options: ConfigLoaderOptions = {}): Promise<LoadedConfigFile> {
  const resolvedWorkspace = path.resolve(workspace)
  const homeDirectory = path.resolve(options.homeDirectory ?? os.homedir())
  const userPath = path.join(homeDirectory, '.pawcode', configFileName)
  const projectPath = path.join(resolvedWorkspace, '.pawcode', configFileName)
  const localPath = path.join(resolvedWorkspace, '.pawcode', 'config.local.json')
  const sources: ConfigSource[] = []
  const warnings: string[] = []
  let merged: PawCodeConfigFile = {}

  try {
    await ensureUserConfigDirectory(homeDirectory)
  } catch (error) {
    warnings.push(
      `用户级配置目录无法创建：${path.join(homeDirectory, '.pawcode')}：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  for (const [kind, filePath] of [
    ['user', userPath],
    ['project', projectPath],
    ['local', localPath],
  ] as const) {
    const result = await readConfigFile(kind, filePath, warnings)
    sources.push({ kind, path: filePath, loaded: result !== undefined, overriddenFields: [] })
    if (!result) continue
    // 项目/本地配置可以共享行为，但不能携带个人凭据或 MCP Server 环境凭据。
    if (kind !== 'user' && result.model?.apiKey) {
      throw new Error(`配置文件 ${filePath} 不允许保存 model.apiKey；请迁移到 ${userPath}`)
    }
    if (kind !== 'user' && Object.values(result.mcp?.servers ?? {}).some((server) => server.env)) {
      throw new Error(`配置文件 ${filePath} 不允许保存 mcp.servers.*.env；请迁移到 ${userPath}`)
    }
    const before = flattenFields(merged)
    merged = mergeConfig(merged, result)
    const after = flattenFields(merged)
    sources.at(-1)?.overriddenFields.push(...after.filter((field) => before.includes(field)))
  }

  return { config: merged, sources, warnings }
}

async function readConfigFile(
  kind: ConfigSourceKind,
  filePath: string,
  warnings: string[],
): Promise<PawCodeConfigFile | undefined> {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error('目标不是普通文件')
    if (kind === 'user') {
      const mode = info.mode & 0o777
      if ((mode & 0o077) !== 0) {
        warnings.push(`用户级配置权限过宽：${filePath}，建议设置为 0600`)
        if (mode & 0o004) throw new Error('用户级配置对其他用户可读，拒绝读取')
      }
    }
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
    const result = pawCodeConfigFileSchema.safeParse(parsed)
    if (!result.success) {
      const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')
      throw new Error(`schema 校验失败：\n${details}`)
    }
    return result.data
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    if (kind === 'user') {
      warnings.push(`用户级配置未加载：${filePath}：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    throw new Error(`配置文件 ${filePath} 无效：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 创建用户级配置目录并固定权限；保存逻辑后续复用同一安全边界。 */
export async function ensureUserConfigDirectory(homeDirectory = os.homedir()): Promise<string> {
  const directory = path.join(path.resolve(homeDirectory), '.pawcode')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  return directory
}

function mergeConfig(base: PawCodeConfigFile, next: PawCodeConfigFile): PawCodeConfigFile {
  // 配置按层级覆盖标量字段；嵌套对象和 MCP Server 集合则逐层合并，避免覆盖未修改的字段。
  return {
    ...base,
    ...next,
    ...(base.model || next.model ? { model: { ...base.model, ...next.model } } : {}),
    ...(base.instructions || next.instructions ? { instructions: { ...base.instructions, ...next.instructions } } : {}),
    ...(base.context || next.context ? { context: { ...base.context, ...next.context } } : {}),
    ...(base.display || next.display ? { display: { ...base.display, ...next.display } } : {}),
    ...(base.mcp || next.mcp
      ? {
          mcp: {
            ...base.mcp,
            ...next.mcp,
            ...(base.mcp?.servers || next.mcp?.servers
              ? { servers: { ...base.mcp?.servers, ...next.mcp?.servers } }
              : {}),
          },
        }
      : {}),
  }
}

function flattenFields(config: PawCodeConfigFile): string[] {
  return Object.entries(config).flatMap(([key, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [key]
    return Object.keys(value).map((child) => `${key}.${child}`)
  })
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
