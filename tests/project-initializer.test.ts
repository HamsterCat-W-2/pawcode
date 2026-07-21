import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelAdapter } from '../src/models/model-adapter.js'
import type { ModelEvent } from '../src/models/model-event.js'
import type { ModelResponse } from '../src/domain/model.js'
import { PermissionManager } from '../src/permissions/permission-manager.js'
import { ProjectInitializer } from '../src/project/project-initializer.js'

const temporaryDirectories: string[] = []

class FixedModel implements ModelAdapter {
  constructor(private readonly response: ModelResponse) {}

  async *stream(): AsyncGenerator<ModelEvent> {
    yield { type: 'completed', response: this.response }
  }
}

describe('ProjectInitializer', () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    )
  })

  it('扫描项目元数据时跳过敏感文件和忽略目录', async () => {
    const root = await fixture()
    await mkdir(path.join(root, 'src'), { recursive: true })
    await mkdir(path.join(root, 'node_modules/pkg'), { recursive: true })
    await mkdir(path.join(root, '.github/workflows'), { recursive: true })
    await writeFile(path.join(root, 'README.md'), '# Demo')
    await writeFile(path.join(root, 'pom.xml'), '<project />')
    await writeFile(path.join(root, '.github/workflows/ci.yml'), 'name: CI')
    await writeFile(path.join(root, 'project.metadata'), 'version = "1.0.0"\ndependencies = []')
    await writeFile(path.join(root, 'src/index.ts'), 'import { value } from "./value.js"')
    await writeFile(path.join(root, '.env'), 'API_KEY=secret')
    await writeFile(path.join(root, 'credentials.json'), '{"token":"secret"}')
    await writeFile(path.join(root, 'node_modules/pkg/package.json'), '{}')

    const initializer = createInitializer(root)
    const snapshot = await initializer.inspect()

    expect(snapshot.files.map((file) => file.path).sort()).toEqual([
      '.github/workflows/ci.yml',
      'README.md',
      'pom.xml',
      'project.metadata',
    ])
    expect(snapshot.files.some((file) => file.path === 'src/index.ts')).toBe(false)
    expect(snapshot.tree.some((entry) => entry.includes('node_modules'))).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain('secret')
  })

  it('使用 .gitignore 过滤项目生成物，同时保留 negation 规则恢复的路径', async () => {
    const root = await fixture()
    await mkdir(path.join(root, 'generated'), { recursive: true })
    await writeFile(path.join(root, '.gitignore'), 'generated/\n!generated/keep.md\n')
    await writeFile(path.join(root, 'generated/skip.txt'), 'skip')
    await writeFile(path.join(root, 'generated/keep.md'), 'keep')

    const snapshot = await createInitializer(root).inspect()

    expect(snapshot.tree).not.toContain('generated/skip.txt')
    expect(snapshot.tree).toContain('generated/keep.md')
  })

  it('生成 Markdown 并通过权限后写入项目根目录', async () => {
    const root = await fixture()
    const content = '# Demo\n\n## 项目用途\n示例项目\n'
    const initializer = new ProjectInitializer({
      workspace: root,
      model: new FixedModel({ content, toolCalls: [] }),
      permissionManager: new PermissionManager({ allowWrite: true }),
    })

    const generated = await initializer.generate(await initializer.inspect())
    await initializer.write(generated)

    await expect(readFile(path.join(root, 'PAWCODE.md'), 'utf8')).resolves.toBe(content)
  })

  it('已有 PAWCODE.md 时拒绝生成，避免覆盖用户规则', async () => {
    const root = await fixture()
    await writeFile(path.join(root, 'PAWCODE.md'), '# 用户规则')
    const initializer = createInitializer(root)

    await expect(initializer.generate(await initializer.inspect())).rejects.toThrow('已存在 PAWCODE.md')
  })

  it('生成结果疑似包含凭据时拒绝写入', async () => {
    const root = await fixture()
    const initializer = new ProjectInitializer({
      workspace: root,
      model: new FixedModel({ content: '# Demo\n\napi_key: sk-test-secret-value\n', toolCalls: [] }),
      permissionManager: new PermissionManager({ allowWrite: true }),
    })

    await expect(initializer.generate(await initializer.inspect())).rejects.toThrow('敏感凭据')
  })
})

function createInitializer(root: string): ProjectInitializer {
  return new ProjectInitializer({
    workspace: root,
    model: new FixedModel({ content: '# Demo\n', toolCalls: [] }),
    permissionManager: new PermissionManager({ allowWrite: true }),
  })
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pawcode-init-'))
  temporaryDirectories.push(root)
  return root
}
