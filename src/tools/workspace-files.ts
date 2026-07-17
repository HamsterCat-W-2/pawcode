import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
]);

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

// 文件路径安全、符号链接检查和递归遍历都隐藏在这个深模块中。
export class WorkspaceFiles {
  private constructor(private readonly root: string) {}

  static async create(workspace: string): Promise<WorkspaceFiles> {
    return new WorkspaceFiles(await realpath(workspace));
  }

  async list(relativePath = ".", maxDepth = 2): Promise<string[]> {
    const target = await this.resolve(relativePath);
    const info = await stat(target);
    if (!info.isDirectory()) throw new Error("目标不是目录");

    const entries = await this.walk(target, Math.max(0, Math.min(maxDepth, 5)));
    return entries.map((entry) => path.relative(this.root, entry));
  }

  async read(
    relativePath: string,
    startLine = 1,
    lineCount = 300,
  ): Promise<string> {
    const target = await this.resolve(relativePath);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("目标不是文件");
    if (info.size > 2_000_000) throw new Error("文件超过 2MB，拒绝读取");

    const content = await readFile(target, "utf8");
    const lines = content.split(/\r?\n/);
    const start = Math.max(1, startLine);
    const count = Math.max(1, Math.min(lineCount, 1_000));

    return lines
      .slice(start - 1, start - 1 + count)
      .map((line, index) => `${start + index}: ${line}`)
      .join("\n");
  }

  async grep(
    query: string,
    relativePath = ".",
    maxResults = 50,
  ): Promise<GrepMatch[]> {
    if (!query) throw new Error("搜索文本不能为空");

    const target = await this.resolve(relativePath);
    const files = (await stat(target)).isFile()
      ? [target]
      : await this.walk(target, 20, false);
    const matches: GrepMatch[] = [];

    for (const file of files) {
      try {
        const info = await stat(file);
        if (!info.isFile() || info.size > 1_000_000) continue;

        const content = await readFile(file, "utf8");
        if (content.includes("\u0000")) continue;

        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (line?.includes(query)) {
            matches.push({
              path: path.relative(this.root, file),
              line: index + 1,
              text: line.trim(),
            });
          }
          if (matches.length >= maxResults) return matches;
        }
      } catch {
        continue;
      }
    }

    return matches;
  }

  private async resolve(input: string): Promise<string> {
    const candidate = path.resolve(this.root, input || ".");
    if (!this.isInside(candidate)) {
      throw new Error(`路径越过工作区边界：${input}`);
    }

    const target = await realpath(candidate);
    if (!this.isInside(target)) {
      throw new Error(`符号链接越过工作区边界：${input}`);
    }
    return target;
  }

  private isInside(target: string): boolean {
    const relative = path.relative(this.root, target);
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative))
    );
  }

  private async walk(
    directory: string,
    maxDepth: number,
    includeDirectories = true,
    currentDepth = 0,
  ): Promise<string[]> {
    if (currentDepth > maxDepth) return [];

    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const output: string[] = [];

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;

      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (includeDirectories) output.push(`${absolute}${path.sep}`);
        output.push(
          ...(await this.walk(
            absolute,
            maxDepth,
            includeDirectories,
            currentDepth + 1,
          )),
        );
      } else if (entry.isFile()) {
        output.push(absolute);
      }
    }

    return output;
  }
}
