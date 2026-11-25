import type { PlayerId } from '../engine/types.js';
import { HeuristicAgent, type PolicyParams } from './heuristic.js';
import { LLMAgent, type DecisionTrace } from './llm/llmAgent.js';
import { MockLLMProvider } from './llm/mock.js';
import { UsageMeter, type LLMProvider } from './llm/provider.js';
import type { Persona } from './personas.js';
import type { Agent } from './types.js';

export type AgentKind = 'heuristic' | 'mock-llm' | 'anthropic' | 'openai';

export interface AgentFactoryOptions {
  kind: AgentKind;
  seed: number;
  policy?: Partial<PolicyParams>;
  meter?: UsageMeter;
  onTrace?: (t: DecisionTrace) => void;
  /** Lazily create the shared provider for real LLM kinds (keeps SDK imports out of the browser). */
  provider?: () => LLMProvider;
}

export function makeAgentFactory(opts: AgentFactoryOptions) {
  let shared: LLMProvider | null = null;
  return (id: PlayerId, persona: Persona, seat: number): Agent => {
    const seed = opts.seed * 31 + seat;
    switch (opts.kind) {
      case 'heuristic':
        return new HeuristicAgent({ id, persona, seed, policy: opts.policy });
      case 'mock-llm':
        return new LLMAgent({ id, persona, seed, provider: new MockLLMProvider(id, persona, { seed }), meter: opts.meter, onTrace: opts.onTrace });
      case 'anthropic':
      case 'openai': {
        if (!opts.provider) throw new Error(`agent kind ${opts.kind} needs a provider`);
        shared ??= opts.provider();
        return new LLMAgent({ id, persona, seed, provider: shared, meter: opts.meter ?? new UsageMeter(), onTrace: opts.onTrace });
      }
    }
  };
}
