import { Game } from '../engine/game.js';
import { Rng } from '../engine/rng.js';
import type { GameConfig, PlayerId } from '../engine/types.js';
import { HeuristicAgent, type PolicyParams } from '../agents/heuristic.js';
import { PERSONAS, personaFor, type Persona } from '../agents/personas.js';
import type { Agent } from '../agents/types.js';

export interface LineupOptions {
  players: number;
  seed: number;
  config?: Partial<GameConfig>;
  /** Seat for a human player, if any, and their display name. */
  human?: { seat: number; name: string };
  /** Build the agent for an AI seat. Defaults to a heuristic agent. */
  makeAgent?: (id: PlayerId, persona: Persona, seat: number) => Agent;
  policy?: Partial<PolicyParams>;
}

export interface Lineup {
  game: Game;
  agents: Map<PlayerId, Agent>;
  personas: Map<PlayerId, Persona>;
}

/** Create a game with personas assigned to AI seats and agents built for them. */
export function createLineup(opts: LineupOptions): Lineup {
  const rng = new Rng(opts.seed ^ 0x9e3779b9);
  const cast = rng.shuffle(PERSONAS).slice(0, opts.players);
  const names = cast.map((p, seat) => (opts.human && opts.human.seat === seat ? opts.human.name : p.name));
  const game = Game.create({ seed: opts.seed, names, config: opts.config });
  const agents = new Map<PlayerId, Agent>();
  const personas = new Map<PlayerId, Persona>();
  for (const p of game.state.players) {
    if (opts.human && opts.human.seat === p.seat) continue;
    const persona = personaFor(p.name);
    personas.set(p.id, persona);
    const agent = opts.makeAgent
      ? opts.makeAgent(p.id, persona, p.seat)
      : new HeuristicAgent({ id: p.id, persona, seed: opts.seed * 31 + p.seat, policy: opts.policy });
    agents.set(p.id, agent);
  }
  return { game, agents, personas };
}
