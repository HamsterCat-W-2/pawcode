import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config/config.js'

describe('loadConfig', () => {
  it('读取 pi-ai 内置 Provider 配置', () => {
    expect(
      loadConfig({
        MODEL_PROVIDER: 'xiaomi-token-plan-cn',
        MODEL_NAME: 'mimo-v2.5',
        MODEL_API_KEY: 'test-key',
      }),
    ).toMatchObject({
      provider: 'xiaomi-token-plan-cn',
      model: 'mimo-v2.5',
      apiKey: 'test-key',
      maxAgentTurns: 10,
      maxToolOutputChars: 20_000,
    })
  })

  it('旧版 base URL 配置自动转换为 custom Provider', () => {
    expect(
      loadConfig({
        MODEL_BASE_URL: 'http://localhost:11434/v1/',
        MODEL_NAME: 'qwen3-coder',
      }),
    ).toMatchObject({
      provider: 'custom',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3-coder',
    })
  })
})
