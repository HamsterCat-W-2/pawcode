import type { ModelRequest, ModelResponse, ToolCall } from "../domain/types.js";
import type { ModelAdapter } from "./model-adapter.js";

interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

interface ChatCompletionPayload {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
  error?: {
    message?: string;
  };
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const forwardAbort = () => controller.abort();
    request.signal?.addEventListener("abort", forwardAbort, { once: true });

    try {
      const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: request.messages,
          tools: request.tools,
          tool_choice: "auto",
          temperature: 0,
        }),
        signal: controller.signal,
      });

      const raw = await response.text();
      let payload: ChatCompletionPayload;

      try {
        payload = JSON.parse(raw) as ChatCompletionPayload;
      } catch {
        throw new Error(`模型返回了非 JSON 内容：${raw.slice(0, 500)}`);
      }

      if (!response.ok) {
        const reason = payload.error?.message ?? raw.slice(0, 500);
        throw new Error(`模型请求失败 (${response.status})：${reason}`);
      }

      const message = payload.choices?.[0]?.message;
      if (!message) {
        throw new Error("模型响应中缺少 choices[0].message");
      }

      return {
        content: message.content ?? null,
        toolCalls: message.tool_calls ?? [],
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`模型请求已取消或超过 ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", forwardAbort);
    }
  }
}
