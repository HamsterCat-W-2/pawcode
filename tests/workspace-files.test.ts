import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceFiles } from "../src/tools/workspace-files.js";

describe("WorkspaceFiles", () => {
  it("读取指定行并添加行号", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pawcode-files-"));
    await writeFile(path.join(root, "hello.txt"), "one\ntwo\nthree", "utf8");
    const files = await WorkspaceFiles.create(root);

    await expect(files.read("hello.txt", 2, 2)).resolves.toBe("2: two\n3: three");
  });

  it("搜索文本并返回文件与行号", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pawcode-grep-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "answer.ts"), "export const answer = 42;\n");
    const files = await WorkspaceFiles.create(root);

    await expect(files.grep("answer")).resolves.toEqual([
      { path: "src/answer.ts", line: 1, text: "export const answer = 42;" },
    ]);
  });

  it("阻止路径和符号链接逃逸", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pawcode-safe-"));
    await symlink(tmpdir(), path.join(root, "outside"));
    const files = await WorkspaceFiles.create(root);

    await expect(files.read("../secret.txt")).rejects.toThrow("路径越过工作区边界");
    await expect(files.list("outside")).rejects.toThrow("符号链接越过工作区边界");
  });
});
