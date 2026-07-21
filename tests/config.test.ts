import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config/config.js'
import { loadConfigFiles } from '../src/config/config-loader.js'

const temporaryDirectories: string[] = []

describe('分层配置', () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    )
  })

  it('读取用户级模型配置和运行参数', () => {
    expect(
      loadConfig({
        model: { provider: 'xiaomi-token-plan-cn', name: 'mimo-v2.5', apiKey: 'test-key' },
      }),
    ).toMatchObject({
      provider: 'xiaomi-token-plan-cn',
      model: 'mimo-v2.5',
      apiKey: 'test-key',
      maxAgentTurns: 10,
      maxToolOutputChars: 20_000,
      contextCompactThreshold: 0.8,
      contextKeepRecentTokens: 20_000,
      modelMaxRetries: 2,
      modelRetryBaseDelayMs: 500,
    })
  })

  it('自定义 base URL 自动转换为 custom Provider', () => {
    expect(
      loadConfig({
        model: { baseUrl: 'http://localhost:11434/v1/', name: 'qwen3-coder' },
      }),
    ).toMatchObject({
      provider: 'custom',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3-coder',
    })
  })

  it('恢复会话时可使用会话中的模型默认值', () => {
    expect(loadConfig({}, { provider: 'anthropic', model: 'saved-model' })).toMatchObject({
      provider: 'anthropic',
      model: 'saved-model',
    })
    expect(() => loadConfig({})).toThrow('model.name')
  })

  it('按用户、项目、本地顺序合并，且只允许用户级保存 API Key', async () => {
    const root = await createFixture()
    const home = path.join(root, 'home')
    await mkdir(path.join(home, '.pawcode'), { recursive: true, mode: 0o700 })
    await writeJson(path.join(home, '.pawcode/config.json'), {
      model: { provider: 'openai', name: 'user-model', apiKey: 'secret' },
      display: { verboseTools: false },
    })
    await writeJson(path.join(root, '.pawcode/config.json'), {
      model: { name: 'project-model' },
      display: { verboseTools: true },
    })
    await writeJson(path.join(root, '.pawcode/config.local.json'), { modelMaxRetries: 4 })

    const loaded = await loadConfigFiles(root, { homeDirectory: home })
    expect(loadConfig(loaded.config)).toMatchObject({
      provider: 'openai',
      model: 'project-model',
      apiKey: 'secret',
      modelMaxRetries: 4,
      display: { verboseTools: true },
    })
  })

  it('拒绝项目级 API Key', async () => {
    const root = await createFixture()
    await writeJson(path.join(root, '.pawcode/config.json'), { model: { apiKey: 'must-not-be-here' } })
    await expect(loadConfigFiles(root, { homeDirectory: path.join(root, 'home') })).rejects.toThrow('model.apiKey')
  })
})

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pawcode-config-'))
  temporaryDirectories.push(root)
  await mkdir(path.join(root, '.pawcode'), { recursive: true, mode: 0o700 })
  return root
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value), 'utf8')
  await chmod(filePath, 0o600)
}
