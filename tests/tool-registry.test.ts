import { describe, expect, it } from "vitest";
import type { Tool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

function createTool(name: string, result: string): Tool {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description: name,
        parameters: { type: "object" },
      },
    },
    async execute() {
      return result;
    },
  };
}

describe("ToolRegistry", () => {
  it("拒绝重复工具名称", () => {
    expect(
      () => new ToolRegistry([createTool("read", "a"), createTool("read", "b")]),
    ).toThrow("工具名称重复");
  });

  it("未知工具返回可供模型理解的错误", async () => {
    const registry = new ToolRegistry([]);
    const result = await registry.execute("missing", "{}", {
      workspace: process.cwd(),
      maxOutputChars: 1_000,
    });
    expect(result).toContain("未知工具 missing");
  });

  it("截断超长工具输出", async () => {
    const registry = new ToolRegistry([createTool("long", "123456789")]);
    const result = await registry.execute("long", "{}", {
      workspace: process.cwd(),
      maxOutputChars: 5,
    });
    expect(result).toBe("12345\n\n[工具输出已截断]");
  });
});
