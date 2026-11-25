import { HeuristicAgent } from '../heuristic.js';
import type { Persona } from '../personas.js';
import { Rng } from '../../engine/rng.js';
import type { Action, PlayerId } from '../../engine/types.js';
import type { CompletionRequest, CompletionResult, LLMProvider } from './provider.js';

/**
 * An offline stand-in for a real model. It speaks the exact JSON protocol a
 * real LLM must use, so the whole LLM agent pipeline (prompting, ReAct steps,
 * parsing, repair, validation, fallback) runs in tests and demos without an API
 * key. Its "brain" is a heuristic agent. `noise` makes it occasionally produce
 * malformed or illegal output to exercise the repair path.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';
  private brain: HeuristicAgent;
  private rng: Rng;

  constructor(
    id: PlayerId,
    persona: Persona,
    private opts: { seed?: number; noise?: number } = {},
  ) {
    this.brain = new HeuristicAgent({ id, persona, seed: opts.seed });
    this.rng = new Rng((opts.seed ?? 7) ^ 0x5bd1e995);
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const obs = req.meta?.observation;
    if (!obs) return { text: '{"thought":"no context","tool":"note","args":{"text":"?"}}' };
    const step = req.meta!.step;
    const usage = { inputTokens: Math.round((req.system.length + req.messages.reduce((s, m) => s + m.content.length, 0)) / 4), outputTokens: 60 };
    const noise = this.opts.noise ?? 0;
    if (noise > 0 && step === 0 && this.rng.chance(noise)) {
      return { text: this.rng.chance(0.5) ? 'Hmm, let me think about this...' : '{"thought":"oops","tool":"vote","args":{"target":"nobody"}}', usage };
    }
    // Look at the numbers once before speaking, the way a careful player would.
    const lastUser = req.messages[req.messages.length - 1]?.content ?? '';
    if (obs.request.kind === 'speak' && step === 0 && !lastUser.startsWith('OBSERVATION')) {
      return { text: JSON.stringify({ thought: 'Let me check the odds first.', tool: 'estimate', args: {} }), usage };
    }
    const action = this.brain.decideSync(obs);
    return { text: JSON.stringify(toStep(action, this.brain.insight().thought ?? '')), usage };
  }
}

function toStep(action: Action, thought: string) {
  switch (action.kind) {
    case 'speak':
      return { thought, tool: 'speak', args: { text: action.speech.text, claims: action.speech.claims } };
    case 'last_words':
      return { thought, tool: 'last_words', args: { text: action.speech.text, claims: action.speech.claims } };
    case 'vote':
      return { thought, tool: 'vote', args: { target: action.target } };
    case 'night':
      return { thought, tool: 'night_action', args: { target: action.target, note: action.note } };
  }
}
