import { Game, GameError } from '../engine/game.js';
import { countSetup } from '../engine/roles.js';
import type { Action, DecisionRequest, GameEvent, PlayerId } from '../engine/types.js';
import type { Agent, Observation } from '../agents/types.js';

export function observe(game: Game, playerId: PlayerId, request: DecisionRequest): Observation {
  const s = game.state;
  const me = game.player(playerId);
  const assigned = s.events.find((e) => e.data.type === 'role_assigned' && e.data.player === playerId);
  const partners = assigned && assigned.data.type === 'role_assigned' ? assigned.data.partners : [];
  const start = s.events[0].data;
  return {
    me: playerId,
    role: me.role,
    partners,
    round: s.round,
    phase: s.phase,
    hull: s.hull,
    config: s.config,
    setup: start.type === 'game_start' ? start.setup : countSetup(s.players.map((p) => p.role)),
    players: s.players.map((p) => ({ id: p.id, name: p.name, seat: p.seat, alive: p.alive, fate: p.fate })),
    events: game.eventsFor(playerId),
    request,
  };
}

/** A safe default action, used when a controller fails or times out. */
export function fallbackAction(req: DecisionRequest): Action {
  switch (req.kind) {
    case 'night': {
      const opts = (req.options ?? []).filter((o) => o !== 'skip') as PlayerId[];
      return { kind: 'night', target: req.allowNone || opts.length === 0 ? null : opts[0] };
    }
    case 'speak':
      return { kind: 'speak', speech: { text: '...', claims: [] } };
    case 'vote':
      return { kind: 'vote', target: 'skip' };
    case 'last_words':
      return { kind: 'last_words', speech: { text: '...', claims: [] } };
  }
}

export interface MatchHooks {
  /** Called with each batch of newly appended events (full, unredacted). */
  onEvents?: (events: GameEvent[]) => void;
  /** Called when a controller errors or returns an illegal action. */
  onError?: (playerId: PlayerId, error: unknown) => void;
  /** Called before a controller is asked to decide. */
  onRequest?: (req: DecisionRequest) => void;
}

/**
 * Drives a game to completion by asking each seat's controller (an AI agent or
 * a human bridge) for decisions. Requests the engine returns together are
 * resolved concurrently, which keeps voting simultaneous and night actions
 * independent.
 */
export class Match {
  private emitted = 0;
  private stopped = false;

  constructor(
    readonly game: Game,
    readonly controllers: Map<PlayerId, Agent>,
    private hooks: MatchHooks = {},
  ) {}

  stop(): void {
    this.stopped = true;
  }

  async run(): Promise<Game> {
    this.flush();
    while (!this.game.over && !this.stopped) {
      const reqs = this.game.pendingRequests();
      if (reqs.length === 0) throw new Error(`engine stalled in phase ${this.game.state.phase}`);
      const decisions = await Promise.all(reqs.map((r) => this.ask(r)));
      for (let i = 0; i < reqs.length; i++) {
        if (this.stopped) break;
        this.apply(reqs[i], decisions[i]);
      }
      this.flush();
    }
    return this.game;
  }

  private async ask(req: DecisionRequest): Promise<Action> {
    const agent = this.controllers.get(req.playerId);
    if (!agent) return fallbackAction(req);
    this.hooks.onRequest?.(req);
    try {
      return await agent.decide(observe(this.game, req.playerId, req));
    } catch (err) {
      this.hooks.onError?.(req.playerId, err);
      return fallbackAction(req);
    }
  }

  private apply(req: DecisionRequest, action: Action): void {
    try {
      this.game.submit(req.playerId, action);
    } catch (err) {
      if (!(err instanceof GameError)) throw err;
      this.hooks.onError?.(req.playerId, err);
      this.game.submit(req.playerId, fallbackAction(req));
    }
  }

  private flush(): void {
    const events = this.game.state.events;
    if (this.emitted < events.length) {
      const fresh = events.slice(this.emitted);
      this.emitted = events.length;
      this.hooks.onEvents?.(fresh);
    }
  }
}
