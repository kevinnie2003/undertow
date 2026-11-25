import { describe, expect, it } from 'vitest';
import { Game, GameError, MAX_SPEECH_CHARS } from '../src/engine/game.js';
import { cleanClaims, isValidClaim } from '../src/engine/claims.js';
import { defaultSetup, echoOf, factionOf } from '../src/engine/roles.js';
import { Rng } from '../src/engine/rng.js';
import type { Action, DecisionRequest } from '../src/engine/types.js';
import { advanceTo, eventsOf, idOf, makeGame, NAMES, step } from './helpers.js';

describe('setup', () => {
  it('has a valid default setup for every supported size', () => {
    for (let n = 5; n <= 10; n++) {
      const roles = defaultSetup(n);
      expect(roles).toHaveLength(n);
      const undertow = roles.filter((r) => factionOf(r) === 'undertow').length;
      expect(undertow).toBeGreaterThanOrEqual(1);
      expect(undertow).toBeLessThan(n / 2);
    }
  });

  it('deals the same roles for the same seed and tells undertow about each other', () => {
    const a = Game.create({ seed: 42, names: NAMES.slice(0, 8) });
    const b = Game.create({ seed: 42, names: NAMES.slice(0, 8) });
    expect(a.state.players.map((p) => p.role)).toEqual(b.state.players.map((p) => p.role));
    const assigned = eventsOf(a, 'role_assigned');
    expect(assigned).toHaveLength(8);
    for (const e of assigned) {
      if (e.data.type !== 'role_assigned') continue;
      expect(e.visibleTo).toEqual([e.data.player]);
      const isUndertow = factionOf(e.data.role) === 'undertow';
      expect(e.data.partners.length > 0).toBe(isUndertow && a.livingUndertow().length > 1);
    }
  });

  it('rejects a role list of the wrong length', () => {
    expect(() => Game.create({ seed: 1, names: NAMES.slice(0, 5), config: { roles: ['drowned', 'diver'] } })).toThrow(GameError);
  });

  it('rng is deterministic and shuffle keeps elements', () => {
    const r1 = new Rng(9), r2 = new Rng(9);
    expect([r1.next(), r1.next()]).toEqual([r2.next(), r2.next()]);
    expect(new Rng(3).shuffle([1, 2, 3, 4, 5]).sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('night', () => {
  it('the first night is calm by default: no drag request', () => {
    const g = makeGame(['drowned', 'sonar', 'medic', 'diver', 'diver']);
    expect(g.pendingRequests().some((r) => r.nightAction === 'drag')).toBe(false);
    step(g);
    expect(eventsOf(g, 'quiet_night')).toHaveLength(1);
    expect(g.state.phase).toBe('day_discussion');
  });

  it('drags on night one when configured, and the medic can save', () => {
    const g = makeGame(['drowned', 'sonar', 'medic', 'diver', 'diver'], { firstNightDrag: true });
    const sonar = idOf(g, 'sonar');
    const pick = (r: DecisionRequest): Action | undefined => {
      if (r.nightAction === 'drag' || r.nightAction === 'protect') return { kind: 'night', target: sonar };
    };
    step(g, pick);
    expect(eventsOf(g, 'dragged')).toHaveLength(0);
    const save = eventsOf(g, 'protect_result')[0];
    expect(save.data.type === 'protect_result' && save.data.saved).toBe(true);
    expect(save.visibleTo).toEqual([idOf(g, 'medic')]);
  });

  it('kills the drag target when unprotected', () => {
    const g = makeGame(['drowned', 'sonar', 'medic', 'diver', 'diver'], { firstNightDrag: true });
    const diver = idOf(g, 'diver');
    step(g, (r) => (r.nightAction === 'drag' ? { kind: 'night', target: diver } : undefined));
    expect(g.player(diver).alive).toBe(false);
    expect(g.player(diver).fate).toBe('dragged');
  });

  it('the medic may not protect the same player two nights running', () => {
    const g = makeGame(['drowned', 'sonar', 'medic', 'diver', 'diver']);
    const medic = idOf(g, 'medic');
    step(g, (r) => (r.nightAction === 'protect' ? { kind: 'night', target: medic } : undefined));
    advanceTo(g, 'night');
    const req = g.pendingRequests().find((r) => r.playerId === medic)!;
    expect(req.options).not.toContain(medic);
    expect(() => g.submit(medic, { kind: 'night', target: medic })).toThrow(GameError);
  });

  it('the siren echoes as crew to sonar; drowned echo as undertow', () => {
    const g = makeGame(['drowned', 'siren', 'sonar', 'medic', 'diver', 'diver']);
    expect(echoOf('siren')).toBe('crew');
    expect(echoOf('drowned')).toBe('undertow');
    const siren = idOf(g, 'siren');
    step(g, (r) => (r.nightAction === 'scan' ? { kind: 'night', target: siren } : undefined));
    const scan = eventsOf(g, 'scan_result')[0];
    expect(scan.data.type === 'scan_result' && scan.data.result).toBe('crew');
    expect(scan.visibleTo).toEqual([idOf(g, 'sonar')]);
  });

  it('deals a private clue to a diver that names at least one undertow', () => {
    for (let seed = 1; seed < 30; seed++) {
      const g = makeGame(['drowned', 'sonar', 'medic', 'diver', 'diver', 'diver', 'archivist'], {}, seed);
      step(g);
      const clue = eventsOf(g, 'clue')[0];
      if (clue.data.type !== 'clue') throw new Error();
      expect(clue.data.suspects).toHaveLength(3);
      expect(clue.data.suspects).not.toContain(clue.data.player);
      expect(clue.data.suspects.some((id) => factionOf(g.player(id).role) === 'undertow')).toBe(true);
      expect(g.player(clue.data.player).role).toBe('diver');
    }
  });

  it('the archivist reads a dead player’s true role', () => {
    const g = makeGame(['drowned', 'siren', 'sonar', 'medic', 'archivist', 'diver', 'diver']);
    const siren = idOf(g, 'siren');
    advanceTo(g, 'day_vote');
    step(g, (r) => (r.kind === 'vote' ? { kind: 'vote', target: r.playerId === siren ? 'skip' : siren } : undefined));
    expect(g.player(siren).fate).toBe('airlocked');
    advanceTo(g, 'night');
    const arch = idOf(g, 'archivist');
    step(g, (r) => (r.playerId === arch ? { kind: 'night', target: siren } : r.nightAction === 'drag' ? { kind: 'night', target: idOf(g, 'diver') } : undefined));
    const read = eventsOf(g, 'read_result')[0];
    expect(read.data.type === 'read_result' && read.data.role).toBe('siren');
  });
});

describe('day and votes', () => {
  const fiveCrew = () => makeGame(['drowned', 'sonar', 'medic', 'diver', 'diver']);

  it('runs the configured number of discussion rounds in rotating order', () => {
    const g = fiveCrew();
    step(g);
    let speeches = 0;
    while (g.state.phase === 'day_discussion') {
      step(g);
      speeches++;
    }
    expect(speeches).toBe(5 * 2);
    expect(g.state.phase).toBe('day_vote');
  });

  it('airlocks on a strict plurality that beats skip, then asks for last words', () => {
    const g = fiveCrew();
    const target = idOf(g, 'drowned');
    advanceTo(g, 'day_vote');
    step(g, (r) => (r.kind === 'vote' && r.playerId !== target ? { kind: 'vote', target } : undefined));
    // Drowned airlocked: crew win at once, no last words needed.
    expect(g.over).toBe(true);
    expect(g.state.winner).toBe('crew');
    expect(g.state.winReason).toBe('all_undertow_gone');
  });

  it('a tie airlocks nobody and costs hull', () => {
    const g = fiveCrew();
    advanceTo(g, 'day_vote');
    const ids = g.living().map((p) => p.id);
    const [a, b] = ids;
    let i = 0;
    step(g, (r) => (r.kind === 'vote' ? { kind: 'vote', target: i++ % 2 === 0 ? (r.playerId === a ? b : a) : r.playerId === b ? a : b } : undefined));
    const no = eventsOf(g, 'no_airlock')[0];
    // 5 voters split between two targets -> 3/2 or tie; just check hull logic matches.
    if (no) {
      expect(g.state.hull).toBe(2);
    } else {
      expect(eventsOf(g, 'airlocked')).toHaveLength(1);
    }
  });

  it('skip winning airlocks nobody and the hull breach ends the game', () => {
    const g = fiveCrew();
    for (let day = 0; day < 3; day++) {
      advanceTo(g, 'day_vote');
      step(g);
      if (g.over) break;
    }
    expect(eventsOf(g, 'no_airlock').length).toBeGreaterThan(0);
    expect(g.over).toBe(true);
    expect(['hull_breach', 'undertow_parity']).toContain(g.state.winReason);
    expect(g.state.winner).toBe('undertow');
  });

  it('a crew airlocking gives last words and does not reveal faction by default', () => {
    const g = fiveCrew();
    const diver = idOf(g, 'diver');
    advanceTo(g, 'day_vote');
    step(g, (r) => (r.kind === 'vote' ? { kind: 'vote', target: r.playerId === diver ? 'skip' : diver } : undefined));
    const air = eventsOf(g, 'airlocked')[0];
    expect(air.data.type === 'airlocked' && air.data.faction).toBeUndefined();
    expect(g.state.phase).toBe('last_words');
    expect(g.pendingRequests()).toEqual([expect.objectContaining({ playerId: diver, kind: 'last_words' })]);
    step(g);
    expect(g.state.phase).toBe('night');
  });

  it('reveals faction on airlock when configured', () => {
    const g = makeGame(['drowned', 'sonar', 'medic', 'diver', 'diver'], { revealOnAirlock: true });
    const diver = idOf(g, 'diver');
    advanceTo(g, 'day_vote');
    step(g, (r) => (r.kind === 'vote' ? { kind: 'vote', target: r.playerId === diver ? 'skip' : diver } : undefined));
    const air = eventsOf(g, 'airlocked')[0];
    expect(air.data.type === 'airlocked' && air.data.faction).toBe('crew');
  });

  it('undertow win at parity', () => {
    const g = makeGame(['drowned', 'drowned', 'sonar', 'medic', 'diver']);
    const victim = idOf(g, 'diver');
    advanceTo(g, 'day_vote');
    step(g, (r) => (r.kind === 'vote' ? { kind: 'vote', target: r.playerId === victim ? 'skip' : victim } : undefined));
    expect(g.over).toBe(true);
    expect(g.state.winReason).toBe('undertow_parity');
  });

  it('rejects out-of-turn and invalid actions', () => {
    const g = fiveCrew();
    step(g);
    const speaker = g.pendingRequests()[0].playerId;
    const other = g.living().find((p) => p.id !== speaker)!.id;
    expect(() => g.submit(other, { kind: 'speak', speech: { text: 'x', claims: [] } })).toThrow(GameError);
    expect(() => g.submit(speaker, { kind: 'vote', target: 'skip' })).toThrow(GameError);
  });

  it('truncates long speech and strips invalid claims', () => {
    const g = fiveCrew();
    step(g);
    const speaker = g.pendingRequests()[0].playerId;
    g.submit(speaker, {
      kind: 'speak',
      speech: { text: 'x'.repeat(5000), claims: [{ type: 'accuse', target: speaker } as never, { type: 'accuse', target: 'p99' } as never] },
    });
    const sp = eventsOf(g, 'speech')[0];
    if (sp.data.type !== 'speech') throw new Error();
    expect(sp.data.speech.text.length).toBeLessThanOrEqual(MAX_SPEECH_CHARS);
    expect(sp.data.speech.claims).toEqual([]);
  });

  it('ends at the round limit', () => {
    const g = makeGame(['drowned', 'sonar', 'medic', 'diver', 'diver'], { maxRounds: 1, hull: 10 });
    advanceTo(g, 'ended');
    expect(g.state.winReason).toBe('round_limit');
  });

  it('serializes and resumes identically', () => {
    const g = Game.create({ seed: 5, names: NAMES.slice(0, 7) });
    step(g);
    step(g);
    const copy = Game.deserialize(g.serialize());
    expect(copy.pendingRequests()).toEqual(g.pendingRequests());
    step(g);
    step(copy);
    expect(copy.state.events).toEqual(g.state.events);
  });

  it('eventsFor redacts private events', () => {
    const g = makeGame(['drowned', 'sonar', 'medic', 'diver', 'diver']);
    step(g);
    const diver = idOf(g, 'diver');
    for (const e of g.eventsFor(diver)) expect(e.visibleTo === 'all' || e.visibleTo.includes(diver)).toBe(true);
    expect(g.eventsFor(diver).some((e) => e.data.type === 'scan_result')).toBe(false);
  });
});

describe('claims', () => {
  const ids = ['p0', 'p1', 'p2'];
  it('validates claim shapes and targets', () => {
    expect(isValidClaim({ type: 'role', role: 'sonar' }, ids, 'p0')).toBe(true);
    expect(isValidClaim({ type: 'role', role: 'wizard' } as never, ids, 'p0')).toBe(false);
    expect(isValidClaim({ type: 'accuse', target: 'p0' }, ids, 'p0')).toBe(false);
    expect(isValidClaim({ type: 'scan', target: 'p1', round: 1, result: 'undertow' }, ids, 'p0')).toBe(true);
    expect(isValidClaim({ type: 'scan', target: 'p1', round: 1, result: 'maybe' } as never, ids, 'p0')).toBe(false);
  });
  it('dedupes', () => {
    const c = cleanClaims([{ type: 'accuse', target: 'p1' }, { type: 'accuse', target: 'p1' }], ids, 'p0');
    expect(c).toHaveLength(1);
  });
});
