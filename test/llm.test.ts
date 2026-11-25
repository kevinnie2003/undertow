import { describe, expect, it } from 'vitest';
import { extractJson, parseStep } from '../src/agents/llm/parse.js';
import { LLMAgent, type DecisionTrace } from '../src/agents/llm/llmAgent.js';
import { MockLLMProvider } from '../src/agents/llm/mock.js';
import { ProviderError, UsageMeter, type CompletionRequest, type LLMProvider } from '../src/agents/llm/provider.js';
import { systemPrompt } from '../src/agents/llm/prompts.js';
import { makeAgentFactory } from '../src/agents/factory.js';
import { PERSONAS } from '../src/agents/personas.js';
import { createLineup } from '../src/runner/lineup.js';
import { Match, observe } from '../src/runner/match.js';
import { advanceTo, idOf, makeGame } from './helpers.js';

class Scripted implements LLMProvider {
  readonly name = 'scripted';
  calls: CompletionRequest[] = [];
  constructor(private replies: (string | Error)[]) {}
  async complete(req: CompletionRequest) {
    this.calls.push(structuredClone({ system: req.system, messages: req.messages, maxTokens: req.maxTokens }));
    const r = this.replies.shift() ?? 'nothing left';
    if (r instanceof Error) throw r;
    return { text: r, usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

function voteSetup() {
  const g = makeGame(['drowned', 'sonar', 'medic', 'diver', 'diver']);
  advanceTo(g, 'day_vote');
  const me = idOf(g, 'diver');
  const req = g.pendingRequests().find((r) => r.playerId === me)!;
  return { g, me, obs: observe(g, me, req), drowned: idOf(g, 'drowned') };
}

describe('parse', () => {
  it('extracts JSON from prose and fences', () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('x {"a":"}{"} y {"b":2}')).toEqual({ a: '}{' });
    expect(() => extractJson('no json here')).toThrow();
  });
  it('parses a step and accepts "action" as an alias for "tool"', () => {
    expect(parseStep('{"thought":"t","tool":"vote","args":{"target":"p1"}}')).toEqual({ thought: 't', tool: 'vote', args: { target: 'p1' } });
    expect(parseStep('{"action":"estimate"}').tool).toBe('estimate');
    expect(() => parseStep('{"thought":"x"}')).toThrow(/tool/);
  });
});

describe('LLMAgent', () => {
  it('uses info tools, then returns the final action, resolving names to ids', async () => {
    const { obs, me, drowned, g } = voteSetup();
    const name = g.player(drowned).name;
    const provider = new Scripted([
      '{"thought":"check","tool":"estimate","args":{}}',
      '{"thought":"remember","tool":"note","args":{"text":"watch them"}}',
      `{"thought":"vote","tool":"vote","args":{"target":"${name}"}}`,
    ]);
    const traces: DecisionTrace[] = [];
    const meter = new UsageMeter();
    const agent = new LLMAgent({ id: me, persona: PERSONAS[1], provider, meter, onTrace: (t) => traces.push(t), retryDelayMs: 0 });
    const action = await agent.decide(obs);
    expect(action).toEqual({ kind: 'vote', target: drowned });
    expect(traces[0].fallback).toBe(false);
    expect(traces[0].steps.map((s) => s.tool)).toEqual(['estimate', 'note', 'vote']);
    expect(provider.calls[1].messages.at(-1)!.content).toMatch(/^OBSERVATION: Estimated chance/);
    expect(agent.insight().notes?.[0]).toMatch(/watch them/);
    expect(meter.calls).toBe(3);
  });

  it('repairs malformed and illegal output', async () => {
    const { obs, me } = voteSetup();
    const provider = new Scripted(['I think I will vote for...', '{"tool":"vote","args":{"target":"nobody"}}', '{"tool":"vote","args":{"target":"skip"}}']);
    const agent = new LLMAgent({ id: me, persona: PERSONAS[2], provider, retryDelayMs: 0 });
    expect(await agent.decide(obs)).toEqual({ kind: 'vote', target: 'skip' });
    const t = agent.traces[0];
    expect(t.steps[0].error).toMatch(/not valid/);
    expect(t.steps[1].error).toBeTruthy();
    expect(provider.calls[2].messages.at(-1)!.content).toMatch(/Error/);
  });

  it('falls back to its heuristic twin after too many bad steps', async () => {
    const { obs, me } = voteSetup();
    const agent = new LLMAgent({ id: me, persona: PERSONAS[3], provider: new Scripted(['x', 'y', 'z', 'w']), retryDelayMs: 0 });
    const action = await agent.decide(obs);
    expect(action.kind).toBe('vote');
    expect(obs.request.options).toContain(action.kind === 'vote' && action.target);
    expect(agent.traces[0].fallback).toBe(true);
  });

  it('retries retryable provider errors and falls back on fatal ones', async () => {
    const { obs, me } = voteSetup();
    const retry = new Scripted([new ProviderError('overloaded', true), '{"tool":"vote","args":{"target":"skip"}}']);
    const a1 = new LLMAgent({ id: me, persona: PERSONAS[4], provider: retry, retryDelayMs: 0 });
    expect(await a1.decide(obs)).toEqual({ kind: 'vote', target: 'skip' });
    const fatal = new Scripted([new ProviderError('bad key', false)]);
    const a2 = new LLMAgent({ id: me, persona: PERSONAS[4], provider: fatal, retryDelayMs: 0 });
    await a2.decide(obs);
    expect(a2.traces[0].fallback).toBe(true);
    expect(fatal.calls).toHaveLength(1);
  });

  it('speech claims are validated and names resolved', async () => {
    const g = makeGame(['drowned', 'sonar', 'medic', 'diver', 'diver']);
    advanceTo(g, 'day_discussion');
    const me = g.pendingRequests()[0].playerId;
    const other = g.living().find((p) => p.id !== me)!;
    const provider = new Scripted([
      JSON.stringify({ thought: 'push', tool: 'speak', args: { text: 'I am suspicious.', claims: [{ type: 'accuse', target: other.name.split(' ')[0] }, { type: 'role', role: 'king' }] } }),
    ]);
    const agent = new LLMAgent({ id: me, persona: PERSONAS[5], provider });
    const action = await agent.decide(observe(g, me, g.pendingRequests()[0]));
    expect(action).toEqual({ kind: 'speak', speech: { text: 'I am suspicious.', claims: [{ type: 'accuse', target: other.id }] } });
  });

  it('prompts tell undertow who their partners are and never leak other roles', () => {
    const s = systemPrompt(PERSONAS[0], 'Ines', 'drowned', ['Bram']);
    expect(s).toMatch(/Bram/);
    expect(s).toMatch(/JSON/);
    const crew = systemPrompt(PERSONAS[0], 'Ines', 'diver', []);
    expect(crew).not.toMatch(/partner/i);
  });

  it('a full game of mock-LLM agents completes, even with noisy output', async () => {
    for (const seed of [1, 2, 3]) {
      let errors = 0;
      const meter = new UsageMeter();
      const { game, agents } = createLineup({
        players: 7,
        seed,
        makeAgent: (id, persona, seat) =>
          new LLMAgent({ id, persona, seed: seat, meter, retryDelayMs: 0, provider: new MockLLMProvider(id, persona, { seed: seed * 10 + seat, noise: 0.3 }) }),
      });
      await new Match(game, agents, { onError: () => errors++ }).run();
      expect(game.over).toBe(true);
      expect(errors).toBe(0);
      expect(meter.calls).toBeGreaterThan(20);
    }
  });

  it('the factory builds each offline kind and refuses a real kind without a provider', () => {
    const f = makeAgentFactory({ kind: 'mock-llm', seed: 1 });
    expect(f('p0', PERSONAS[0], 0).kind).toBe('llm:mock');
    expect(makeAgentFactory({ kind: 'heuristic', seed: 1 })('p0', PERSONAS[0], 0).kind).toBe('heuristic');
    expect(() => makeAgentFactory({ kind: 'anthropic', seed: 1 })('p0', PERSONAS[0], 0)).toThrow();
  });
});
