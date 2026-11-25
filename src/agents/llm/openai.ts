import { ProviderError, type CompletionRequest, type CompletionResult, type LLMProvider } from './provider.js';

export interface OpenAICompatibleOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

/**
 * Any OpenAI-compatible chat completions endpoint (OpenAI, a local vLLM or
 * Ollama server, OpenRouter, ...). Configure with env vars:
 *   OPENAI_BASE_URL (default https://api.openai.com/v1)
 *   OPENAI_API_KEY
 *   OPENAI_MODEL    (required)
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private baseUrl: string;
  private apiKey: string | undefined;
  private model: string;

  constructor(opts: OpenAICompatibleOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    const model = opts.model ?? process.env.OPENAI_MODEL;
    if (!model) throw new ProviderError('set OPENAI_MODEL to use the OpenAI-compatible provider', false);
    this.model = model;
    this.name = `openai-compatible:${this.model}`;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: req.maxTokens,
          messages: [{ role: 'system', content: req.system }, ...req.messages],
          response_format: { type: 'json_object' },
        }),
      });
    } catch (err) {
      throw new ProviderError(`request failed: ${String(err)}`, true);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ProviderError(`HTTP ${res.status}: ${body.slice(0, 200)}`, res.status === 429 || res.status >= 500);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: data.choices?.[0]?.message?.content ?? '',
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
    };
  }
}
