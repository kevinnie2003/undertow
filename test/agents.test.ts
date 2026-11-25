import { describe, expect, it } from 'vitest';
import { Game } from '../src/engine/game.js';
import { factionOf } from '../src/engine/roles.js';
import { Memory } from '../src/agents/memory.js';
import { computeBeliefs, forEachCombination } from '../src/agents/beliefs.js';
import { HeuristicAgent } from '../src/agents/heuristic.js';
import { PERSONAS } from '../src/agents/personas.js';
import { observe } from '../src/runner/match.js';
import { simulate, simulateOne } from '../src/sim/simulate.js';
import { idOf, makeGame, NAMES, step } from './helpers.js';

function beliefsFor(game: Game, id: string, perspective: 'private' | 'public' = 'private') {
  const m = new Memory(id);
  m.ingest(game.eventsFor(id));
  const start = game.state.events[0].data;
  if (start.type !== 'game_start') throw new Error();
  return computeBeliefs({
    players: game.state.players.map((p) => p.id),
    alive: new Set(game.living().map((p) => p.id)),
    setup: start.setup,
    memory: m,
    perspective,
  });
}

describe('beliefs', () => {
  it('enumerates combinations exactly', () => {
    let count = 0;
    forEachCombination(7, 2, () => count++);
    expect(count).toBe(21);
  });

  it('probabilities sum to the number of undertow, and a crew member is sure of themself', () => {
    const g = Game.create({ seed: 3, names: NAMES.slice(0, 8) });
    const crew = g.state.players.find((p) => factionOf(p.role) === 'crew')!.id;
    const b = beliefsFor(g, crew);
    const sum = [...b.p.values()].reduce((a, x) => a + x, 0);
    expect(sum).toBeCloseTo(3, 5);
    expect(b.p.get(crew)).toBe(0);
  });

  it('undertow know the whole team privately but not publicly', () => {
    const g = makeGame(['drowned', 'siren', 'sonar', 'medic', 'diver', 'diver']);
    const drowned = idOf(g, 'drowned');
    const siren = idOf(g, 'siren');
    const priv = beliefsFor(g, drowned);
    for (const [id, p] of priv.p) expect(p).toBe(id === drowned || id === siren ? 1 : 0);
    const pub = beliefsFor(g, drowned, 'public');
    expect(pub.p.get(siren)!).toBeGreaterThan(0);
    expect(pub.p.get(siren)!).toBeLessThan(1);
  });

  it('a sonar that pinged a drowned is certain', () => {
    const g = makeGame(['drowned', 'sonar', 'medic', 'diver', 'diver']);
    const drowned = idOf(g, 'drowned');
    step(g, (r) => (r.nightAction === 'scan' ? { kind: 'night', target: drowned } : undefined));
    expect(beliefsFor(g, idOf(g, 'sonar')).p.get(drowned)).toBe(1);
  });

  it('dragged players are known crew to everyone', () => {
    const g = makeGame(['drowned', 'sonar', 'medic', 'diver', 'diver', 'diver', 'archivist'], { firstNightDrag: true });
    const victim = idOf(g, 'diver', 2);
    step(g, (r) => (r.nightAction === 'drag' ? { kind: 'night', target: victim } : undefined));
    expect(g.player(victim).alive).toBe(false);
    const b = beliefsFor(g, idOf(g, 'diver'), 'public');
    expect(b.p.get(victim)).toBe(0);
  });
});

describe('heuristic agents', () => {
  it('produce only legal actions and every game terminates', async () => {
    for (const players of [5, 6, 7, 8, 9, 10]) {
      for (let seed = 1; seed <= 15; seed++) {
        const s = await simulateOne(seed * 101 + players, { players });
        expect(s.errors).toBe(0);
        expect(['crew', 'undertow']).toContain(s.winner);
      }
    }
  });

  it('are deterministic for a seed', async () => {
    const a = await simulateOne(77, { players: 8 });
    const b = await simulateOne(77, { players: 8 });
    expect(a).toEqual(b);
  });

  it('a sonar reports a real undertow scan', async () => {
    const g = makeGame(['drowned', 'sonar', 'medic', 'diver', 'diver']);
    const drowned = idOf(g, 'drowned');
    const sonar = idOf(g, 'sonar');
    step(g, (r) => (r.nightAction === 'scan' ? { kind: 'night', target: drowned } : undefined));
    const agent = new HeuristicAgent({ id: sonar, persona: PERSONAS[0], seed: 1 });
    // Speak until the sonar has spoken (crew policies may wait a round).
    let said = false;
    for (let i = 0; i < 12 && !said && g.state.phase === 'day_discussion'; i++) {
      const req = g.pendingRequests()[0];
      if (req.playerId !== sonar) {
        step(g);
        continue;
      }
      const action = await agent.decide(observe(g, sonar, req));
      if (action.kind !== 'speak') throw new Error();
      said = action.speech.claims.some((c) => c.type === 'scan' && c.target === drowned && c.result === 'undertow') || action.speech.claims.some((c) => c.type === 'accuse' && c.target === drowned);
      g.submit(sonar, action);
    }
    expect(said).toBe(true);
  });

  it('the simulation report is sane', async () => {
    const { report } = await simulate({ games: 60, players: 7, seed: 5 });
    expect(report.games).toBe(60);
    expect(report.crewWinRate).toBeGreaterThan(0.1);
    expect(report.crewWinRate).toBeLessThan(0.95);
  });
});

describe('beliefs: one clue per night', () => {
  it('the real clue holder knows a second clue claim for the same night is a lie', () => {
    const g = makeGame(['drowned', 'drowned', 'sonar', 'medic', 'diver', 'diver'], { clueChance: 1 });
    step(g);
    const clue = g.state.events.find((e) => e.data.type === 'clue')!;
    if (clue.data.type !== 'clue') throw new Error();
    const holder = clue.data.player;
    const faker = idOf(g, 'drowned');
    // The holder shares the real clue, a drowned claims a different one for the same night.
    const speak = (id: string, claims: unknown[]) => {
      while (g.pendingRequests()[0]?.playerId !== id) step(g);
      g.submit(id, { kind: 'speak', speech: { text: '...', claims: claims as never } });
    };
    const others = g.living().filter((p) => p.id !== faker && p.id !== holder).map((p) => p.id);
    speak(holder, [{ type: 'clue', round: 1, suspects: clue.data.suspects }]);
    speak(faker, [{ type: 'clue', round: 1, suspects: others.slice(0, 3) }]);
    expect(beliefsFor(g, holder).p.get(faker)!).toBeGreaterThan(0.9);
  });
});
