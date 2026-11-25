import Anthropic from '@anthropic-ai/sdk';
import { ProviderError, type CompletionRequest, type CompletionResult, type LLMProvider } from './provider.js';

export interface AnthropicOptions {
  apiKey?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/**
 * Claude via the official SDK. Configure with env vars:
 *   ANTHROPIC_API_KEY        (or any credential the SDK resolves)
 *   UNDERTOW_ANTHROPIC_MODEL (default claude-opus-5-5)
 *   UNDERTOW_ANTHROPIC_EFFORT (default low: a game turn is short)
 */
export class AnthropicProvider implements LLMProvider {
  readonly name: string;
  private client: Anthropic;
  private model: string;
  private effort: NonNullable<AnthropicOptions['effort']>;

  constructor(opts: AnthropicOptions = {}) {
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.model = opts.model ?? process.env.UNDERTOW_ANTHROPIC_MODEL ?? 'claude-opus-5-5';
    this.effort = opts.effort ?? (process.env.UNDERTOW_ANTHROPIC_EFFORT as AnthropicOptions['effort']) ?? 'low';
    this.name = `anthropic:${this.model}`;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    try {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: Math.max(req.maxTokens, 4000),
        // The system prompt is identical across a seat's turns, so cache it.
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        output_config: { effort: this.effort },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
      if (response.stop_reason === 'refusal') throw new ProviderError('model declined this turn', false);
      const text = response.content
        .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return {
        text,
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err instanceof Anthropic.RateLimitError) throw new ProviderError('rate limited', true);
      if (err instanceof Anthropic.AuthenticationError) throw new ProviderError('invalid Anthropic credentials', false);
      if (err instanceof Anthropic.BadRequestError) throw new ProviderError(`bad request: ${err.message}`, false);
      if (err instanceof Anthropic.APIError) throw new ProviderError(`Anthropic API error ${err.status}: ${err.message}`, true);
      throw new ProviderError(`Anthropic request failed: ${String(err)}`, true);
    }
  }
}
