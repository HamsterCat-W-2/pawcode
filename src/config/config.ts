import { z } from "zod";

const environmentSchema = z.object({
  MODEL_BASE_URL: z.url(),
  MODEL_API_KEY: z.string().min(1),
  MODEL_NAME: z.string().min(1),
  MAX_AGENT_TURNS: z.coerce.number().int().positive().default(10),
  MAX_TOOL_OUTPUT_CHARS: z.coerce.number().int().positive().default(20_000),
});

export interface PawCodeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxAgentTurns: number;
  maxToolOutputChars: number;
}

// 配置校验集中在这里，其他模块只接收已经合法的强类型配置。
export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PawCodeConfig {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`PawCode 配置无效：\n${details}`);
  }

  return {
    baseUrl: result.data.MODEL_BASE_URL.replace(/\/$/, ""),
    apiKey: result.data.MODEL_API_KEY,
    model: result.data.MODEL_NAME,
    maxAgentTurns: result.data.MAX_AGENT_TURNS,
    maxToolOutputChars: result.data.MAX_TOOL_OUTPUT_CHARS,
  };
}
