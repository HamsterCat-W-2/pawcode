import type { ToolDefinition } from "../domain/types.js";
import type { Tool, ToolContext } from "./tool.js";

export class ToolRegistry {
  private readonly tools: Map<string, Tool>;

  constructor(tools: Tool[]) {
    this.tools = new Map();

    for (const tool of tools) {
      const name = tool.definition.function.name;
      if (this.tools.has(name)) {
        throw new Error(`工具名称重复：${name}`);
      }
      this.tools.set(name, tool);
    }
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  async execute(
    name: string,
    argumentsJson: string,
    context: ToolContext,
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `工具执行失败：未知工具 ${name}`;
    }

    try {
      const result = await tool.execute(argumentsJson, context);
      return truncate(result, context.maxOutputChars);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `工具执行失败：${message}`;
    }
  }
}

function truncate(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  return `${value.slice(0, maxCharacters)}\n\n[工具输出已截断]`;
}
