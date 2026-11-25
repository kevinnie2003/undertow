import { factionOf } from '../engine/roles.js';
import type { Faction, GameConfig, GameEvent, PlayerId, RoleId, WinReason } from '../engine/types.js';
import type { PolicyParams } from '../agents/heuristic.js';
import type { Agent } from '../agents/types.js';
import type { Persona } from '../agents/personas.js';
import { createLineup } from '../runner/lineup.js';
import { Match } from '../runner/match.js';

export interface GameSummary {
  seed: number;
  winner: Faction;
  reason: WinReason;
  rounds: number;
  airlocks: { round: number; faction: Faction; role: RoleId }[];
  drags: number;
  saves: number;
  skippedDays: number;
  sonarClaims: number;
  fakeSonarClaims: number;
  fakeClues: number;
  sonarSurvivedToDay2: boolean;
  errors: number;
}

export interface SimOptions {
  games: number;
  players: number;
  seed: number;
  config?: Partial<GameConfig>;
  policy?: Partial<PolicyParams>;
  /** Policy override for Undertow seats only, to test one side's changes. */
  makeAgent?: (id: PlayerId, persona: Persona, seat: number, gameSeed: number) => Agent;
}

export async function simulateOne(seed: number, opts: Omit<SimOptions, 'games' | 'seed'>): Promise<GameSummary> {
  const { game, agents } = createLineup({
    players: opts.players,
    seed,
    config: opts.config,
    policy: opts.policy,
    makeAgent: opts.makeAgent ? (id, persona, seat) => opts.makeAgent!(id, persona, seat, seed) : undefined,
  });
  let errors = 0;
  const match = new Match(game, agents, { onError: () => errors++ });
  await match.run();
  return summarize(seed, game.state.events, game.state.players.map((p) => ({ id: p.id, role: p.role })), errors);
}

export function summarize(seed: number, events: GameEvent[], players: { id: PlayerId; role: RoleId }[], errors = 0): GameSummary {
  const role = new Map(players.map((p) => [p.id, p.role] as const));
  const s: GameSummary = {
    seed,
    winner: 'crew',
    reason: 'all_undertow_gone',
    rounds: 0,
    airlocks: [],
    drags: 0,
    saves: 0,
    skippedDays: 0,
    sonarClaims: 0,
    fakeSonarClaims: 0,
    fakeClues: 0,
    sonarSurvivedToDay2: false,
    errors,
  };
  const sonar = players.find((p) => p.role === 'sonar')?.id;
  const sonarClaimed = new Set<PlayerId>();
  for (const e of events) {
    const d = e.data;
    s.rounds = Math.max(s.rounds, e.round);
    switch (d.type) {
      case 'airlocked': {
        const r = role.get(d.player)!;
        s.airlocks.push({ round: e.round, faction: factionOf(r), role: r });
        break;
      }
      case 'dragged':
        s.drags++;
        break;
      case 'protect_result':
        if (d.saved) s.saves++;
        break;
      case 'no_airlock':
        s.skippedDays++;
        break;
      case 'speech':
      case 'last_words':
        for (const c of d.speech.claims) {
          if ((c.type === 'role' && c.role === 'sonar') || c.type === 'scan') {
            if (!sonarClaimed.has(d.player)) {
              sonarClaimed.add(d.player);
              s.sonarClaims++;
              if (role.get(d.player) !== 'sonar') s.fakeSonarClaims++;
            }
          }
          if (c.type === 'clue' && role.get(d.player) !== 'diver') s.fakeClues++;
        }
        break;
      case 'phase':
        if (d.phase === 'day_discussion' && e.round === 2 && sonar) {
          s.sonarSurvivedToDay2 = !events.some((x) => x.seq < e.seq && (x.data.type === 'dragged' || x.data.type === 'airlocked') && x.data.player === sonar);
        }
        break;
      case 'game_end':
        s.winner = d.winner;
        s.reason = d.reason;
        break;
    }
  }
  return s;
}

export interface SimReport {
  games: number;
  players: number;
  crewWinRate: number;
  byReason: Record<string, number>;
  avgRounds: number;
  airlockAccuracy: number;
  day1AirlockAccuracy: number;
  skipRate: number;
  savesPerGame: number;
  fakeSonarRate: number;
  fakeCluesPerGame: number;
  sonarSurvivalDay2: number;
  errors: number;
}

export async function simulate(opts: SimOptions): Promise<{ report: SimReport; games: GameSummary[] }> {
  const games: GameSummary[] = [];
  for (let i = 0; i < opts.games; i++) games.push(await simulateOne(opts.seed + i, opts));
  return { report: aggregate(games, opts.players), games };
}

export function aggregate(games: GameSummary[], players: number): SimReport {
  const n = games.length || 1;
  const airlocks = games.flatMap((g) => g.airlocks);
  const day1 = airlocks.filter((a) => a.round === 1);
  const byReason: Record<string, number> = {};
  for (const g of games) byReason[g.reason] = (byReason[g.reason] ?? 0) + 1 / n;
  const days = games.reduce((s, g) => s + g.airlocks.length + g.skippedDays, 0);
  return {
    games: games.length,
    players,
    crewWinRate: games.filter((g) => g.winner === 'crew').length / n,
    byReason,
    avgRounds: games.reduce((s, g) => s + g.rounds, 0) / n,
    airlockAccuracy: airlocks.length ? airlocks.filter((a) => a.faction === 'undertow').length / airlocks.length : 0,
    day1AirlockAccuracy: day1.length ? day1.filter((a) => a.faction === 'undertow').length / day1.length : 0,
    skipRate: days ? games.reduce((s, g) => s + g.skippedDays, 0) / days : 0,
    savesPerGame: games.reduce((s, g) => s + g.saves, 0) / n,
    fakeSonarRate: games.filter((g) => g.fakeSonarClaims > 0).length / n,
    fakeCluesPerGame: games.reduce((s, g) => s + g.fakeClues, 0) / n,
    sonarSurvivalDay2: games.filter((g) => g.sonarSurvivedToDay2).length / n,
    errors: games.reduce((s, g) => s + g.errors, 0),
  };
}

export function formatReport(r: SimReport): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    `Undertow simulation: ${r.games} games, ${r.players} players`,
    `  crew win rate          ${pct(r.crewWinRate)}`,
    `  outcomes               ${Object.entries(r.byReason).map(([k, v]) => `${k} ${pct(v)}`).join(', ')}`,
    `  avg rounds             ${r.avgRounds.toFixed(2)}`,
    `  airlock accuracy       ${pct(r.airlockAccuracy)} (day 1: ${pct(r.day1AirlockAccuracy)})`,
    `  days without airlock   ${pct(r.skipRate)}`,
    `  medic saves / game     ${r.savesPerGame.toFixed(2)}`,
    `  games with fake sonar  ${pct(r.fakeSonarRate)}`,
    `  fake clues / game      ${r.fakeCluesPerGame.toFixed(2)}`,
    `  sonar alive on day 2   ${pct(r.sonarSurvivalDay2)}`,
    `  controller errors      ${r.errors}`,
  ];
  return lines.join('\n');
}
