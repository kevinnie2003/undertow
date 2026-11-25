import { cleanClaims } from './claims.js';
import { Rng } from './rng.js';
import { countSetup, defaultSetup, echoOf, factionOf, ROLES } from './roles.js';
import type {
  Action,
  DecisionRequest,
  EventData,
  Faction,
  GameConfig,
  GameEvent,
  GameState,
  Phase,
  Player,
  PlayerId,
  RoleId,
  Speech,
  Visibility,
  WinReason,
} from './types.js';
import { DEFAULT_CONFIG } from './types.js';

export class GameError extends Error {}

export interface CreateGameOptions {
  seed: number;
  names: string[];
  config?: Partial<GameConfig>;
}

/**
 * The game engine: a deterministic state machine.
 *
 *   night(N) -> day_discussion(N) -> day_vote(N) -> [last_words(N)] -> night(N+1) ...
 *
 * Callers ask `pendingRequests()` what decisions are needed, gather them from
 * players (human or agent) and feed them back with `submit()`. Requests that are
 * returned together may be answered in any order or in parallel.
 */
export class Game {
  readonly state: GameState;
  private rng: Rng;

  constructor(state: GameState) {
    this.state = state;
    this.rng = new Rng(state.rngState);
  }

  static create(opts: CreateGameOptions): Game {
    const config: GameConfig = { ...DEFAULT_CONFIG, ...opts.config };
    const n = opts.names.length;
    const roles = config.roles ?? defaultSetup(n);
    if (roles.length !== n) throw new GameError(`role list has ${roles.length} roles for ${n} players`);
    const rng = new Rng(opts.seed);
    const shuffled = rng.shuffle(roles);
    const players: Player[] = opts.names.map((name, seat) => ({
      id: `p${seat}`,
      name,
      seat,
      role: shuffled[seat],
      alive: true,
    }));
    const state: GameState = {
      seed: opts.seed,
      rngState: rng.state,
      config,
      players,
      round: 0,
      phase: 'night',
      hull: config.hull,
      events: [],
      night: { undertowProposals: {}, actions: {} },
      lastProtect: {},
      readsDone: {},
      discussion: { order: [], index: 0, round: 1 },
      votes: {},
      pendingLastWords: null,
    };
    const game = new Game(state);
    game.emit('all', {
      type: 'game_start',
      players: players.map((p) => ({ id: p.id, name: p.name, seat: p.seat })),
      setup: countSetup(roles),
      config,
    });
    const undertow = players.filter((p) => factionOf(p.role) === 'undertow');
    for (const p of players) {
      const partners = factionOf(p.role) === 'undertow' ? undertow.filter((u) => u.id !== p.id).map((u) => u.id) : [];
      game.emit([p.id], { type: 'role_assigned', player: p.id, role: p.role, partners });
    }
    game.startNight();
    return game;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  get over(): boolean {
    return this.state.phase === 'ended';
  }

  player(id: PlayerId): Player {
    const p = this.state.players.find((x) => x.id === id);
    if (!p) throw new GameError(`unknown player ${id}`);
    return p;
  }

  living(): Player[] {
    return this.state.players.filter((p) => p.alive);
  }

  livingUndertow(): Player[] {
    return this.living().filter((p) => factionOf(p.role) === 'undertow');
  }

  livingCrew(): Player[] {
    return this.living().filter((p) => factionOf(p.role) === 'crew');
  }

  /** Decisions the engine is waiting for right now. */
  pendingRequests(): DecisionRequest[] {
    const s = this.state;
    const round = s.round;
    switch (s.phase) {
      case 'ended':
        return [];
      case 'night': {
        const reqs: DecisionRequest[] = [];
        // Undertow propose one at a time, in seat order, so each sees the last.
        const dragTonight = s.round > 1 || s.config.firstNightDrag;
        const nextUndertow = dragTonight ? this.livingUndertow().find((p) => !(p.id in s.night.undertowProposals)) : undefined;
        if (nextUndertow) {
          reqs.push({
            playerId: nextUndertow.id,
            kind: 'night',
            nightAction: 'drag',
            options: this.dragTargets(),
            allowNone: false,
            round,
          });
        }
        for (const p of this.living()) {
          const action = ROLES[p.role].nightAction;
          if (!action || action === 'drag' || p.id in s.night.actions) continue;
          reqs.push({
            playerId: p.id,
            kind: 'night',
            nightAction: action,
            options: this.nightTargets(p),
            allowNone: true,
            round,
          });
        }
        return reqs;
      }
      case 'day_discussion': {
        const speaker = s.discussion.order[s.discussion.index];
        return speaker ? [{ playerId: speaker, kind: 'speak', round }] : [];
      }
      case 'day_vote':
        return this.living()
          .filter((p) => !(p.id in s.votes))
          .map((p) => ({
            playerId: p.id,
            kind: 'vote' as const,
            options: [...this.living().filter((o) => o.id !== p.id).map((o) => o.id), 'skip' as const],
            round,
          }));
      case 'last_words':
        return s.pendingLastWords ? [{ playerId: s.pendingLastWords, kind: 'last_words', round }] : [];
    }
  }

  private dragTargets(): PlayerId[] {
    return this.livingCrew().map((p) => p.id);
  }

  private nightTargets(p: Player): PlayerId[] {
    const s = this.state;
    switch (ROLES[p.role].nightAction) {
      case 'scan':
        return this.living().filter((o) => o.id !== p.id).map((o) => o.id);
      case 'protect':
        return this.living().filter((o) => o.id !== s.lastProtect[p.id]).map((o) => o.id);
      case 'read': {
        const done = s.readsDone[p.id] ?? [];
        return s.players.filter((o) => !o.alive && !done.includes(o.id)).map((o) => o.id);
      }
      default:
        return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  submit(playerId: PlayerId, action: Action): void {
    const req = this.pendingRequests().find((r) => r.playerId === playerId);
    if (!req) throw new GameError(`no decision pending for ${playerId} in phase ${this.state.phase}`);
    if (req.kind !== action.kind) throw new GameError(`expected ${req.kind} from ${playerId}, got ${action.kind}`);
    switch (action.kind) {
      case 'night':
        this.submitNight(req, action.target, action.note);
        break;
      case 'speak':
        this.submitSpeech(playerId, this.cleanSpeech(playerId, action.speech));
        break;
      case 'vote':
        if (!req.options!.includes(action.target)) throw new GameError(`invalid vote target ${action.target}`);
        this.state.votes[playerId] = action.target;
        if (this.pendingRequests().length === 0) this.resolveVote();
        break;
      case 'last_words':
        this.emit('all', { type: 'last_words', player: playerId, speech: this.cleanSpeech(playerId, action.speech) });
        this.state.pendingLastWords = null;
        this.startNight();
        break;
    }
    this.state.rngState = this.rng.state;
  }

  private cleanSpeech(playerId: PlayerId, speech: Speech): Speech {
    const s = sanitizeSpeech(speech);
    return { text: s.text, claims: cleanClaims(s.claims, this.state.players.map((p) => p.id), playerId) };
  }

  private submitNight(req: DecisionRequest, target: PlayerId | null, note?: string): void {
    const s = this.state;
    if (target === null) {
      if (!req.allowNone) throw new GameError('a target is required');
    } else if (!req.options!.includes(target)) {
      throw new GameError(`invalid night target ${target}`);
    }
    if (req.nightAction === 'drag') {
      s.night.undertowProposals[req.playerId] = target;
      const partners = this.livingUndertow().map((p) => p.id);
      this.emit(partners, {
        type: 'undertow_proposal',
        player: req.playerId,
        target,
        note: note?.slice(0, 280),
      });
    } else {
      s.night.actions[req.playerId] = target;
    }
    if (this.pendingRequests().length === 0) this.resolveNight();
  }

  private submitSpeech(playerId: PlayerId, speech: Speech): void {
    const d = this.state.discussion;
    this.emit('all', { type: 'speech', player: playerId, speech, discussionRound: d.round });
    d.index++;
    if (d.index >= d.order.length) {
      d.round++;
      d.index = 0;
      // Players may have... (no deaths happen during discussion) - rebuild anyway.
      d.order = d.order.filter((id) => this.player(id).alive);
      if (d.round > this.state.config.discussionRounds) this.startVote();
    }
  }

  // ---------------------------------------------------------------------------
  // Phase transitions
  // ---------------------------------------------------------------------------

  private setPhase(phase: Phase): void {
    this.state.phase = phase;
    this.emit('all', { type: 'phase', phase, round: this.state.round });
  }

  private startNight(): void {
    const s = this.state;
    if (this.checkWin()) return;
    s.round++;
    if (s.round > s.config.maxRounds) {
      this.endGame('undertow', 'round_limit');
      return;
    }
    s.night = { undertowProposals: {}, actions: {} };
    this.setPhase('night');
    // Archivists with nothing to read skip automatically.
    for (const p of this.living()) {
      if (ROLES[p.role].nightAction === 'read' && this.nightTargets(p).length === 0) s.night.actions[p.id] = null;
    }
    if (this.pendingRequests().length === 0) this.resolveNight();
  }

  private resolveNight(): void {
    const s = this.state;
    // Undertow target: plurality of proposals, ties broken by the earliest proposal.
    const proposals = Object.values(s.night.undertowProposals).filter((t): t is PlayerId => t !== null);
    let dragTarget: PlayerId | null = null;
    if (proposals.length > 0) {
      const counts = new Map<PlayerId, number>();
      for (const t of proposals) counts.set(t, (counts.get(t) ?? 0) + 1);
      let best = -1;
      for (const t of proposals) {
        const c = counts.get(t)!;
        if (c > best) {
          best = c;
          dragTarget = t;
        }
      }
    }
    const protectedIds = new Set<PlayerId>();
    for (const p of this.living()) {
      if (ROLES[p.role].nightAction === 'protect') {
        const t = s.night.actions[p.id];
        s.lastProtect[p.id] = t ?? null;
        if (t) protectedIds.add(t);
      }
    }
    let victim: Player | null = null;
    if (dragTarget && !protectedIds.has(dragTarget)) {
      victim = this.player(dragTarget);
      victim.alive = false;
      victim.fate = 'dragged';
      victim.diedRound = s.round;
    }
    // Night results go only to those still breathing at dawn.
    for (const p of this.living()) {
      const t = s.night.actions[p.id];
      if (!t) continue;
      switch (ROLES[p.role].nightAction) {
        case 'scan':
          this.emit([p.id], { type: 'scan_result', player: p.id, target: t, result: echoOf(this.player(t).role) });
          break;
        case 'protect':
          this.emit([p.id], { type: 'protect_result', player: p.id, target: t, saved: t === dragTarget });
          break;
        case 'read':
          (s.readsDone[p.id] ??= []).push(t);
          this.emit([p.id], { type: 'read_result', player: p.id, target: t, role: this.player(t).role });
          break;
      }
    }
    this.dealClue();
    if (victim) this.emit('all', { type: 'dragged', player: victim.id });
    else this.emit('all', { type: 'quiet_night' });
    if (this.checkWin()) return;
    this.startDiscussion();
  }

  private dealClue(): void {
    const s = this.state;
    const divers = this.living().filter((p) => p.role === 'diver');
    const undertow = this.livingUndertow();
    if (divers.length === 0 || undertow.length === 0 || !this.rng.chance(s.config.clueChance)) return;
    const recipient = this.rng.pick(divers);
    const guilty = this.rng.pick(undertow);
    const others = this.rng.shuffle(this.living().filter((p) => p.id !== recipient.id && p.id !== guilty.id));
    const suspects = this.rng.shuffle([guilty, ...others.slice(0, s.config.clueSize - 1)]).map((p) => p.id);
    this.emit([recipient.id], { type: 'clue', player: recipient.id, suspects });
  }

  private startDiscussion(): void {
    const s = this.state;
    const living = this.living().map((p) => p.id);
    const offset = (s.round - 1) % living.length;
    s.discussion = { order: [...living.slice(offset), ...living.slice(0, offset)], index: 0, round: 1 };
    s.votes = {};
    this.setPhase('day_discussion');
    if (s.config.discussionRounds <= 0) this.startVote();
  }

  private startVote(): void {
    this.state.votes = {};
    this.setPhase('day_vote');
  }

  private resolveVote(): void {
    const s = this.state;
    const tally: Record<string, number> = {};
    for (const t of Object.values(s.votes)) tally[t] = (tally[t] ?? 0) + 1;
    this.emit('all', { type: 'votes', votes: { ...s.votes }, tally });
    const skip = tally['skip'] ?? 0;
    const ranked = Object.entries(tally)
      .filter(([k]) => k !== 'skip')
      .sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    const unique = top && (ranked.length === 1 || ranked[1][1] < top[1]);
    if (top && unique && top[1] > skip) {
      const p = this.player(top[0]);
      p.alive = false;
      p.fate = 'airlocked';
      p.diedRound = s.round;
      this.emit('all', {
        type: 'airlocked',
        player: p.id,
        ...(s.config.revealOnAirlock ? { faction: factionOf(p.role) } : {}),
      });
      if (this.checkWin()) return;
      s.pendingLastWords = p.id;
      this.setPhase('last_words');
      return;
    }
    this.emit('all', { type: 'no_airlock', reason: top && top[1] > skip ? 'tie' : 'skip' });
    s.hull--;
    this.emit('all', { type: 'hull', hull: s.hull, delta: -1 });
    this.startNight();
  }

  private checkWin(): boolean {
    if (this.state.phase === 'ended') return true;
    const u = this.livingUndertow().length;
    const c = this.livingCrew().length;
    if (u === 0) return this.endGame('crew', 'all_undertow_gone');
    if (u >= c) return this.endGame('undertow', 'undertow_parity');
    if (this.state.hull <= 0) return this.endGame('undertow', 'hull_breach');
    return false;
  }

  private endGame(winner: Faction, reason: WinReason): true {
    const s = this.state;
    s.winner = winner;
    s.winReason = reason;
    s.phase = 'ended';
    const roles: Record<PlayerId, RoleId> = {};
    for (const p of s.players) roles[p.id] = p.role;
    this.emit('all', { type: 'game_end', winner, reason, roles });
    return true;
  }

  private emit(visibleTo: Visibility, data: EventData): void {
    const s = this.state;
    s.events.push({ seq: s.events.length, round: s.round, phase: s.phase, visibleTo, data });
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  eventsFor(playerId: PlayerId | null): GameEvent[] {
    if (playerId === null) return this.state.events;
    return this.state.events.filter((e) => e.visibleTo === 'all' || e.visibleTo.includes(playerId));
  }

  serialize(): string {
    return JSON.stringify(this.state);
  }

  static deserialize(json: string): Game {
    return new Game(JSON.parse(json) as GameState);
  }
}

export const MAX_SPEECH_CHARS = 600;

export function sanitizeSpeech(speech: Speech): Speech {
  const text = String(speech?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_SPEECH_CHARS);
  const claims = Array.isArray(speech?.claims) ? speech.claims.slice(0, 8) : [];
  return { text, claims };
}
