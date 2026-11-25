import { describe, expect, it } from 'vitest';
import { extractClaims } from '../src/web/claimParser.js';
import { renderSpeech } from '../src/agents/voice.js';
import { PERSONAS } from '../src/agents/personas.js';
import { Rng } from '../src/engine/rng.js';
import type { Claim } from '../src/engine/types.js';

const players = [
  { id: 'p0', name: 'You' },
  { id: 'p1', name: 'Ravi Mehta' },
  { id: 'p2', name: 'Hana Sato' },
  { id: 'p3', name: 'Bram Okafor' },
];

describe('Chinese claim extraction', () => {
  it('reads roles, scans and votes', () => {
    const claims = extractClaims('我是声呐员。我探测了Ravi，回声是暗流。投Hana。', players, 'p0', 2);
    expect(claims).toContainEqual({ type: 'role', role: 'sonar' });
    expect(claims).toContainEqual({ type: 'scan', round: 2, target: 'p1', result: 'undertow' });
    expect(claims).toContainEqual({ type: 'intend_vote', target: 'p2' });
  });
  it('tells accusing from vouching, including negation', () => {
    expect(extractClaims('Bram很可疑。', players, 'p0', 1)).toEqual([{ type: 'accuse', target: 'p3' }]);
    expect(extractClaims('Bram不是暗流，我信任他。', players, 'p0', 1)).toEqual([{ type: 'vouch', target: 'p3' }]);
    expect(extractClaims('Hana的回声干净。', players, 'p0', 1)).toEqual([{ type: 'scan', round: 1, target: 'p2', result: 'crew' }]);
  });
  it('reads a skip', () => {
    expect(extractClaims('这轮我弃票。', players, 'p0', 1)).toEqual([{ type: 'intend_vote', target: 'skip' }]);
  });
  it('still reads English', () => {
    expect(extractClaims('I am the medic. Vote Hana.', players, 'p0', 1)).toEqual([
      { type: 'role', role: 'medic' },
      { type: 'intend_vote', target: 'p2' },
    ]);
  });
});

describe('voice packs', () => {
  const claims: Claim[] = [
    { type: 'role', role: 'sonar' },
    { type: 'scan', round: 2, target: 'p1', result: 'undertow' },
    { type: 'intend_vote', target: 'p1' },
  ];
  const name = (id: string) => players.find((p) => p.id === id)!.name.split(' ')[0];
  it('speaks Chinese with the same claims', () => {
    const zh = renderSpeech(claims, PERSONAS[0], name, new Rng(4), undefined, undefined, 'zh');
    expect(zh).toMatch(/声呐员/);
    expect(zh).toMatch(/Ravi/);
    expect(zh).not.toMatch(/[a-z]{4,} [a-z]{4,}/);
  });
  it('draws the same random numbers in every language', () => {
    for (const persona of PERSONAS) {
      const a = new Rng(9);
      const b = new Rng(9);
      renderSpeech(claims, persona, name, a, 'defend', { lost: ['p2'], calm: false }, 'en');
      renderSpeech(claims, persona, name, b, 'defend', { lost: ['p2'], calm: false }, 'zh');
      expect(a.next()).toBe(b.next());
    }
  });
});

describe('a whole game in Chinese', () => {
  it('plays the same game as in English, spoken in Chinese', async () => {
    const { GameSession } = await import('../src/runner/session.js');
    const { makeAgentFactory } = await import('../src/agents/factory.js');
    const run = async (lang: 'en' | 'zh', kind: 'heuristic' | 'mock-llm') => {
      const session = new GameSession({ players: 7, seed: 11, makeAgent: makeAgentFactory({ kind, seed: 11, lang: () => lang }), omniscient: true });
      await session.start();
      return session.view();
    };
    for (const kind of ['heuristic', 'mock-llm'] as const) {
      const en = await run('en', kind);
      const zh = await run('zh', kind);
      expect(zh.winner).toBe(en.winner);
      expect(zh.events.length).toBe(en.events.length);
      const speeches = zh.events.flatMap((e) => (e.data.type === 'speech' ? [e.data.speech.text] : []));
      expect(speeches.length).toBeGreaterThan(5);
      for (const text of speeches) expect(text).toMatch(/[一-鿿]/);
      const thoughts = Object.values(zh.insights ?? {}).map((i) => i.thought).filter(Boolean);
      expect(thoughts.some((t) => /[一-鿿]/.test(t!))).toBe(true);
    }
  });
});
