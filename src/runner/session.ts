import type { Action, DecisionRequest, Faction, GameEvent, Phase, PlayerId, RoleId, WinReason } from '../engine/types.js';
import { factionOf } from '../engine/roles.js';
import type { Agent, AgentInsight, Observation } from '../agents/types.js';
import type { Persona } from '../agents/personas.js';
import type { DecisionTrace } from '../agents/llm/llmAgent.js';
import { createLineup } from './lineup.js';
import { Match, observe } from './match.js';
import type { Game } from '../engine/game.js';

/** Bridges a human (UI) into the match: decide() waits until the UI calls resolve(). */
export class HumanAgent implements Agent {
  readonly kind = 'human';
  pending: { obs: Observation; resolve: (a: Action) => void } | null = null;
  onPending?: () => void;
  constructor(readonly id: PlayerId) {}
  decide(obs: Observation): Promise<Action> {
    return new Promise((resolve) => {
      this.pending = { obs, resolve };
      this.onPending?.();
    });
  }
  act(action: Action): boolean {
    if (!this.pending) return false;
    const { resolve } = this.pending;
    this.pending = null;
    resolve(action);
    return true;
  }
}

export interface SessionPlayer {
  id: PlayerId;
  name: string;
  seat: number;
  job: string;
  alive: boolean;
  fate?: 'dragged' | 'airlocked';
  human: boolean;
}

/** Everything a client UI needs, already redacted for the viewer. */
export interface ClientView {
  you: PlayerId | null;
  yourRole: RoleId | null;
  partners: PlayerId[];
  players: SessionPlayer[];
  round: number;
  phase: Phase;
  hull: number;
  maxHull: number;
  setup: Record<RoleId, number>;
  events: GameEvent[];
  pending: DecisionRequest | null;
  /** Only for spectators, or once the game is over. */
  roles: Record<PlayerId, RoleId> | null;
  insights: Record<PlayerId, AgentInsight> | null;
  traces: DecisionTrace[] | null;
  thinking: PlayerId[];
  winner: Faction | null;
  winReason: WinReason | null;
  agentKind: string;
}

export interface SessionOptions {
  players: number;
  seed: number;
  /** Omit for an all-AI match you watch as a spectator. */
  human?: { seat: number; name: string };
  makeAgent?: (id: PlayerId, persona: Persona, seat: number) => Agent;
  agentKind?: string;
  /** Delay before AI actions become visible, so humans can follow along. */
  paceMs?: number;
  /** Spectators see roles and agent minds. */
  omniscient?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A running game plus its seat controllers, usable both in the browser (local,
 * offline play) and on the server (LLM play over HTTP/SSE).
 */
export class GameSession {
  readonly game: Game;
  readonly human: HumanAgent | null;
  private agents: Map<PlayerId, Agent>;
  private personas: Map<PlayerId, Persona>;
  private listeners = new Set<(v: ClientView) => void>();
  private thinking = new Set<PlayerId>();
  private traces: DecisionTrace[] = [];
  private match: Match;
  paceMs: number;
  readonly omniscient: boolean;
  readonly agentKind: string;
  error: string | null = null;

  constructor(opts: SessionOptions) {
    this.paceMs = opts.paceMs ?? 0;
    this.omniscient = opts.omniscient ?? !opts.human;
    this.agentKind = opts.agentKind ?? 'heuristic';
    const lineup = createLineup({ players: opts.players, seed: opts.seed, human: opts.human, makeAgent: opts.makeAgent });
    this.game = lineup.game;
    this.personas = lineup.personas;
    this.agents = new Map();
    this.human = opts.human ? new HumanAgent(`p${opts.human.seat}`) : null;
    if (this.human) {
      this.human.onPending = () => this.publish();
      this.agents.set(this.human.id, this.human);
    }
    for (const [id, agent] of lineup.agents) this.agents.set(id, this.paced(agent));
    this.match = new Match(this.game, this.agents, { onEvents: () => this.publish() });
  }

  /** Wraps an AI so that its decisions surface at a readable pace, and tracks who is "thinking". */
  private paced(agent: Agent): Agent {
    const self = this;
    return {
      id: agent.id,
      kind: agent.kind,
      insight: agent.insight?.bind(agent),
      async decide(obs: Observation) {
        self.thinking.add(agent.id);
        self.publish();
        const started = Date.now();
        try {
          const action = await agent.decide(obs);
          const wait = obs.request.kind === 'speak' || obs.request.kind === 'last_words' ? self.paceMs : self.paceMs / 3;
          const remaining = wait - (Date.now() - started);
          if (remaining > 0) await sleep(remaining);
          return action;
        } finally {
          self.thinking.delete(agent.id);
        }
      },
    };
  }

  recordTrace(t: DecisionTrace): void {
    this.traces.push(t);
    if (this.traces.length > 400) this.traces.shift();
  }

  async start(): Promise<void> {
    try {
      await this.match.run();
    } catch (err) {
      this.error = String(err instanceof Error ? err.message : err);
    }
    this.publish();
  }

  stop(): void {
    this.match.stop();
  }

  act(action: Action): { ok: boolean; error?: string } {
    if (!this.human?.pending) return { ok: false, error: 'not your turn' };
    const req = this.human.pending.obs.request;
    if (!action || req.kind !== action.kind) return { ok: false, error: `expected a ${req.kind} action` };
    if (action.kind === 'night') {
      if (action.target === null ? !req.allowNone : !req.options?.includes(action.target)) return { ok: false, error: 'invalid target' };
    } else if (action.kind === 'vote') {
      if (!req.options?.includes(action.target)) return { ok: false, error: 'invalid vote' };
    } else if (!action.speech || typeof action.speech.text !== 'string') {
      return { ok: false, error: 'speech needs text' };
    }
    this.human.act(action);
    return { ok: true };
  }

  subscribe(fn: (v: ClientView) => void): () => void {
    this.listeners.add(fn);
    fn(this.view());
    return () => this.listeners.delete(fn);
  }

  private publish(): void {
    if (this.listeners.size === 0) return;
    const v = this.view();
    for (const fn of this.listeners) fn(v);
  }

  view(): ClientView {
    const s = this.game.state;
    const you = this.human?.id ?? null;
    const ended = s.phase === 'ended';
    const reveal = this.omniscient || ended;
    const me = you ? this.game.player(you) : null;
    const assigned = you ? s.events.find((e) => e.data.type === 'role_assigned' && e.data.player === you) : undefined;
    const start = s.events[0].data;
    const insights: Record<PlayerId, AgentInsight> = {};
    if (this.omniscient) for (const [id, a] of this.agents) if (a.insight) insights[id] = a.insight();
    let pending: DecisionRequest | null = null;
    if (this.human?.pending) pending = this.human.pending.obs.request;
    return {
      you,
      yourRole: me?.role ?? null,
      partners: assigned?.data.type === 'role_assigned' ? assigned.data.partners : [],
      players: s.players.map((p) => ({
        id: p.id,
        name: p.name,
        seat: p.seat,
        job: this.personas.get(p.id)?.job ?? 'crew member',
        alive: p.alive,
        fate: p.fate,
        human: p.id === you,
      })),
      round: s.round,
      phase: s.phase,
      hull: s.hull,
      maxHull: s.config.hull,
      setup: start.type === 'game_start' ? start.setup : ({} as Record<RoleId, number>),
      events: reveal ? s.events : this.game.eventsFor(you),
      pending,
      roles: reveal ? Object.fromEntries(s.players.map((p) => [p.id, p.role])) : null,
      insights: this.omniscient ? insights : null,
      traces: this.omniscient ? this.traces.slice(-60) : null,
      thinking: [...this.thinking],
      winner: s.winner ?? null,
      winReason: s.winReason ?? null,
      agentKind: this.agentKind,
    };
  }

  /** The observation a human would see right now (used for claim suggestions). */
  observationFor(id: PlayerId): Observation | null {
    const req = this.game.pendingRequests().find((r) => r.playerId === id);
    return req ? observe(this.game, id, req) : null;
  }
}

export function factionLabel(role: RoleId): Faction {
  return factionOf(role);
}
