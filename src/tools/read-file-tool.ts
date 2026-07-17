import { z } from "zod";
import type { Tool, ToolContext } from "./tool.js";
import { WorkspaceFiles } from "./workspace-files.js";

const argumentsSchema = z.object({
  path: z.string().min(1),
  start_line: z.number().int().positive().default(1),
  line_count: z.number().int().positive().max(1_000).default(300),
});

export class ReadFileTool implements Tool {
  readonly definition = {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "读取工作区内文本文件的指定行",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对工作区的文件路径" },
          start_line: { type: "integer", minimum: 1 },
          line_count: { type: "integer", minimum: 1, maximum: 1_000 },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  };

  async execute(argumentsJson: string, context: ToolContext): Promise<string> {
    const args = argumentsSchema.parse(JSON.parse(argumentsJson || "{}"));
    const files = await WorkspaceFiles.create(context.workspace);
    return files.read(args.path, args.start_line, args.line_count);
  }
}
