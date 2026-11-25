import { cleanClaims } from '../../engine/claims.js';
import type { Action, PlayerId } from '../../engine/types.js';
import { HeuristicAgent } from '../heuristic.js';
import type { Persona } from '../personas.js';
import type { Agent, AgentInsight, Observation } from '../types.js';
import { parseStep, type AgentStep } from './parse.js';
import { describeClaims, describeVotes, stateDigest, systemPrompt, taskText } from './prompts.js';
import type { Lang } from '../../i18n/lang.js';
import { ProviderError, type ChatMessage, type LLMProvider, type UsageMeter } from './provider.js';

export interface LLMAgentOptions {
  id: PlayerId;
  persona: Persona;
  provider: LLMProvider;
  seed?: number;
  /** Max model calls per decision (information tools + final action). */
  maxSteps?: number;
  meter?: UsageMeter;
  /** Base delay before retrying a rate-limited or overloaded provider call. */
  retryDelayMs?: number;
  /** Called after every decision with its full reasoning trace (for spectators/logs). */
  onTrace?: (trace: DecisionTrace) => void;
  /** The table's language, read at every decision. Defaults to English. */
  lang?: () => Lang;
}

export interface TraceStep extends AgentStep {
  observation?: string;
  error?: string;
}

export interface DecisionTrace {
  player: PlayerId;
  round: number;
  kind: Action['kind'];
  steps: TraceStep[];
  action: Action;
  fallback: boolean;
}

const FINAL_TOOL: Record<Action['kind'], string> = {
  night: 'night_action',
  speak: 'speak',
  vote: 'vote',
  last_words: 'last_words',
};

/**
 * An LLM-driven player using a ReAct loop over a provider-agnostic JSON
 * protocol: each model turn is {thought, tool, args}. Information tools return
 * observations; a final tool ends the decision. Invalid output is fed back as
 * an error so the model can repair it; after `maxSteps` or a provider failure
 * the agent falls back to its heuristic twin, so a game never stalls.
 *
 * Private memory lives in two places: the structured `Memory` (shared with the
 * heuristic twin) rendered into every prompt, and free-text notes the model
 * writes for itself with the `note` tool.
 */
export class LLMAgent implements Agent {
  readonly kind: string;
  readonly id: PlayerId;
  private twin: HeuristicAgent;
  private notes: string[] = [];
  private lastThought = '';
  private maxSteps: number;
  private retryDelayMs: number;
  traces: DecisionTrace[] = [];

  constructor(private opts: LLMAgentOptions) {
    this.id = opts.id;
    this.kind = `llm:${opts.provider.name}`;
    this.twin = new HeuristicAgent({ id: opts.id, persona: opts.persona, seed: opts.seed, lang: opts.lang });
    this.maxSteps = opts.maxSteps ?? 4;
    this.retryDelayMs = opts.retryDelayMs ?? 750;
  }

  get memory() {
    return this.twin.memory;
  }

  insight(): AgentInsight {
    const base = this.twin.insight();
    return { beliefs: base.beliefs, thought: this.lastThought, notes: [...this.notes] };
  }

  async decide(obs: Observation): Promise<Action> {
    // Keep the twin's memory and beliefs current; they power the `estimate` tool and the fallback.
    const ctx = this.twin.context(obs);
    const m = this.twin.memory;
    const partnerNames = obs.partners.map((id) => m.name(id));
    const lang = this.opts.lang?.() ?? 'en';
    const system = systemPrompt(this.opts.persona, m.name(obs.me), obs.role, partnerNames, lang);
    const messages: ChatMessage[] = [
      { role: 'user', content: `${stateDigest(obs, m, this.notes)}\n\nTASK: ${taskText(obs, m)}` },
    ];
    const steps: TraceStep[] = [];
    const finalTool = FINAL_TOOL[obs.request.kind];

    for (let step = 0; step < this.maxSteps; step++) {
      const lastChance = step === this.maxSteps - 1;
      let text: string;
      try {
        const res = await this.opts.provider.complete({ system, messages, maxTokens: 700, meta: { observation: obs, step } });
        this.opts.meter?.record(res);
        text = res.text;
      } catch (err) {
        if (this.opts.meter) this.opts.meter.failures++;
        if (err instanceof ProviderError && err.retryable && !lastChance) {
          steps.push({ thought: '', tool: '', args: {}, error: `retrying: ${err.message}` });
          await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** step));
          continue;
        }
        steps.push({ thought: '', tool: '', args: {}, error: String(err instanceof Error ? err.message : err) });
        break;
      }
      messages.push({ role: 'assistant', content: text });
      let parsed: AgentStep;
      try {
        parsed = parseStep(text);
      } catch (err) {
        const error = `Your reply was not valid: ${(err as Error).message}. Reply with exactly one JSON object.`;
        steps.push({ thought: '', tool: '', args: {}, error });
        messages.push({ role: 'user', content: error });
        continue;
      }
      if (parsed.thought) this.lastThought = parsed.thought;
      if (parsed.tool === finalTool) {
        const result = this.toAction(parsed, obs);
        if ('error' in result) {
          steps.push({ ...parsed, error: result.error });
          messages.push({ role: 'user', content: `Error: ${result.error} Try again.` });
          continue;
        }
        steps.push(parsed);
        return this.finish(obs, steps, result.action, false);
      }
      const observation = this.runTool(parsed, obs, ctx.priv.p, finalTool, lastChance);
      steps.push({ ...parsed, observation });
      messages.push({ role: 'user', content: `OBSERVATION: ${observation}` });
    }
    return this.finish(obs, steps, this.twin.decideSync(obs), true);
  }

  private finish(obs: Observation, steps: TraceStep[], action: Action, fallback: boolean): Action {
    const trace: DecisionTrace = { player: this.id, round: obs.round, kind: obs.request.kind, steps, action, fallback };
    this.traces.push(trace);
    this.opts.onTrace?.(trace);
    return action;
  }

  private runTool(step: AgentStep, obs: Observation, beliefs: Map<PlayerId, number>, finalTool: string, lastChance: boolean): string {
    const m = this.twin.memory;
    switch (step.tool) {
      case 'review_claims': {
        const who = typeof step.args.player === 'string' ? this.resolvePlayer(step.args.player, obs) : null;
        return describeClaims(m, who ?? undefined);
      }
      case 'review_votes':
        return describeVotes(m);
      case 'estimate': {
        const rows = obs.players
          .filter((p) => p.alive && p.id !== obs.me)
          .map((p) => ({ p, v: beliefs.get(p.id) ?? 0 }))
          .sort((a, b) => b.v - a.v)
          .map(({ p, v }) => `${p.name} (${p.id}): ${(v * 100).toFixed(0)}%`);
        return `Estimated chance each living player is Undertow, from what you know: ${rows.join(', ')}.`;
      }
      case 'note': {
        const text = String(step.args.text ?? '').trim().slice(0, 300);
        if (text) this.notes.push(this.opts.lang?.() === 'zh' ? `第${obs.round}天：${text}` : `Day ${obs.round}: ${text}`);
        return text ? 'Noted.' : 'Nothing to note.';
      }
      default:
        return `Unknown tool "${step.tool}". For this decision finish with "${finalTool}".`;
    }
  }

  /** Map a model-supplied reference ("p3", "Ravi", "Ravi Mehta") to a player id. */
  private resolvePlayer(ref: unknown, obs: Observation): PlayerId | null {
    if (typeof ref !== 'string') return null;
    const r = ref.trim().toLowerCase();
    const byId = obs.players.find((p) => p.id.toLowerCase() === r);
    if (byId) return byId.id;
    const byName = obs.players.find((p) => p.name.toLowerCase() === r);
    if (byName) return byName.id;
    const byFirst = obs.players.filter((p) => p.name.toLowerCase().split(' ')[0] === r.split(' ')[0]);
    if (byFirst.length === 1) return byFirst[0].id;
    const embedded = r.match(/\bp\d+\b/);
    return embedded ? this.resolvePlayer(embedded[0], obs) : null;
  }

  private resolveClaims(raw: unknown, obs: Observation) {
    const list = Array.isArray(raw) ? raw : [];
    const fixed = list.map((c) => {
      if (!c || typeof c !== 'object') return c;
      const o = { ...(c as Record<string, unknown>) };
      if (typeof o.target === 'string' && o.target !== 'skip') o.target = this.resolvePlayer(o.target, obs) ?? o.target;
      if (Array.isArray(o.suspects)) o.suspects = o.suspects.map((s) => this.resolvePlayer(s, obs) ?? s);
      if (typeof o.round === 'string') o.round = Number(o.round);
      return o;
    });
    return cleanClaims(fixed, obs.players.map((p) => p.id), obs.me);
  }

  private toAction(step: AgentStep, obs: Observation): { action: Action } | { error: string } {
    const req = obs.request;
    const a = step.args;
    switch (req.kind) {
      case 'speak':
      case 'last_words': {
        const text = typeof a.text === 'string' ? a.text.trim() : '';
        if (!text) return { error: '"text" must be a non-empty string.' };
        const claims = this.resolveClaims(a.claims, obs);
        return { action: req.kind === 'speak' ? { kind: 'speak', speech: { text, claims } } : { kind: 'last_words', speech: { text, claims } } };
      }
      case 'vote': {
        const raw = a.target;
        const target = raw === 'skip' || raw === null ? 'skip' : this.resolvePlayer(raw, obs);
        if (!target || !req.options!.includes(target)) {
          return { error: `"target" must be one of: ${req.options!.join(', ')}.` };
        }
        return { action: { kind: 'vote', target } };
      }
      case 'night': {
        if (a.target === null || a.target === undefined || a.target === 'none') {
          if (req.allowNone) return { action: { kind: 'night', target: null } };
          return { error: 'You must choose a target tonight.' };
        }
        const target = this.resolvePlayer(a.target, obs);
        if (!target || !req.options!.includes(target)) return { error: `"target" must be one of: ${req.options!.join(', ')}.` };
        const note = typeof a.note === 'string' ? a.note : undefined;
        return { action: { kind: 'night', target, note } };
      }
    }
  }
}
