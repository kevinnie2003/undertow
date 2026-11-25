import type { Observation } from '../types.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  /**
   * Out-of-band context for offline providers (the scripted/mock provider uses
   * it to act sensibly). Real providers never send it anywhere.
   */
  meta?: { observation: Observation; step: number };
}

export interface CompletionResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/** The one interface every model backend implements. */
export interface LLMProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Running token totals, shared across agents in a match. */
export class UsageMeter {
  inputTokens = 0;
  outputTokens = 0;
  calls = 0;
  failures = 0;
  record(r: CompletionResult): void {
    this.calls++;
    this.inputTokens += r.usage?.inputTokens ?? 0;
    this.outputTokens += r.usage?.outputTokens ?? 0;
  }
}
