import { factionOf } from '../engine/roles.js';
import type { Claim, Faction, GameEvent, PlayerId, RoleId } from '../engine/types.js';

export interface ClaimRecord {
  round: number;
  speaker: PlayerId;
  claim: Claim;
  /** True when made as last words (the speaker has nothing left to lose). */
  lastWords: boolean;
}

export interface SpeechRecord {
  round: number;
  speaker: PlayerId;
  text: string;
  lastWords: boolean;
}

/**
 * An agent's private, append-only memory. It digests the event stream the
 * player is allowed to see into structured facts, so that reasoning code (and
 * prompts) never have to re-parse raw events.
 */
export class Memory {
  private lastSeq = -1;
  role: RoleId | null = null;
  partners: PlayerId[] = [];
  names = new Map<PlayerId, string>();
  scans: { round: number; target: PlayerId; result: Faction }[] = [];
  protects: { round: number; target: PlayerId; saved: boolean }[] = [];
  reads: { round: number; target: PlayerId; role: RoleId }[] = [];
  clues: { round: number; suspects: PlayerId[] }[] = [];
  claims: ClaimRecord[] = [];
  speeches: SpeechRecord[] = [];
  votes: { round: number; votes: Record<PlayerId, PlayerId | 'skip'>; airlocked: PlayerId | null }[] = [];
  deaths: { round: number; player: PlayerId; fate: 'dragged' | 'airlocked'; faction?: Faction }[] = [];
  quietNights: number[] = [];
  proposals: { round: number; player: PlayerId; target: PlayerId | null; note?: string }[] = [];
  hullLosses: number[] = [];

  constructor(public readonly me: PlayerId) {}

  /** Feed newly visible events. Safe to call repeatedly with the full event list. */
  ingest(events: GameEvent[]): void {
    for (const e of events) {
      if (e.seq <= this.lastSeq) continue;
      this.lastSeq = e.seq;
      this.apply(e);
    }
  }

  private apply(e: GameEvent): void {
    const d = e.data;
    switch (d.type) {
      case 'game_start':
        for (const p of d.players) this.names.set(p.id, p.name);
        break;
      case 'role_assigned':
        if (d.player === this.me) {
          this.role = d.role;
          this.partners = d.partners;
        }
        break;
      case 'scan_result':
        this.scans.push({ round: e.round, target: d.target, result: d.result });
        break;
      case 'protect_result':
        this.protects.push({ round: e.round, target: d.target, saved: d.saved });
        break;
      case 'read_result':
        this.reads.push({ round: e.round, target: d.target, role: d.role });
        break;
      case 'clue':
        this.clues.push({ round: e.round, suspects: d.suspects });
        break;
      case 'undertow_proposal':
        this.proposals.push({ round: e.round, player: d.player, target: d.target, note: d.note });
        break;
      case 'dragged':
        this.deaths.push({ round: e.round, player: d.player, fate: 'dragged' });
        break;
      case 'quiet_night':
        this.quietNights.push(e.round);
        break;
      case 'speech':
      case 'last_words': {
        const lastWords = d.type === 'last_words';
        this.speeches.push({ round: e.round, speaker: d.player, text: d.speech.text, lastWords });
        for (const claim of d.speech.claims) this.claims.push({ round: e.round, speaker: d.player, claim, lastWords });
        break;
      }
      case 'votes':
        this.votes.push({ round: e.round, votes: d.votes, airlocked: null });
        break;
      case 'airlocked': {
        const v = this.votes[this.votes.length - 1];
        if (v && v.round === e.round) v.airlocked = d.player;
        this.deaths.push({ round: e.round, player: d.player, fate: 'airlocked', faction: d.faction });
        break;
      }
      case 'hull':
        if (d.delta < 0) this.hullLosses.push(e.round);
        break;
      default:
        break;
    }
  }

  get faction(): Faction | null {
    return this.role ? factionOf(this.role) : null;
  }

  name(id: PlayerId): string {
    return this.names.get(id) ?? id;
  }

  isDead(id: PlayerId): boolean {
    return this.deaths.some((d) => d.player === id);
  }

  claimsBy(speaker: PlayerId): ClaimRecord[] {
    return this.claims.filter((c) => c.speaker === speaker);
  }

  /** Claims made by me that match a predicate (used to avoid repeating myself). */
  saidBefore(pred: (c: Claim) => boolean): boolean {
    return this.claims.some((c) => c.speaker === this.me && pred(c.claim));
  }

  /** Role each player has claimed most recently (explicitly or implied by a result claim). */
  claimedRoles(): Map<PlayerId, RoleId> {
    const out = new Map<PlayerId, RoleId>();
    for (const c of this.claims) {
      const r = impliedRole(c.claim);
      if (r) out.set(c.speaker, r);
    }
    return out;
  }

  /** Accusations aimed at a player today (or on a given round). */
  accusationsAgainst(target: PlayerId, round?: number): ClaimRecord[] {
    return this.claims.filter(
      (c) =>
        (round === undefined || c.round === round) &&
        ((c.claim.type === 'accuse' && c.claim.target === target) ||
          (c.claim.type === 'scan' && c.claim.target === target && c.claim.result === 'undertow') ||
          (c.claim.type === 'intend_vote' && c.claim.target === target)),
    );
  }

  /** Latest declared vote intention per player for a round. */
  intentions(round: number): Map<PlayerId, PlayerId | 'skip'> {
    const out = new Map<PlayerId, PlayerId | 'skip'>();
    for (const c of this.claims) if (c.round === round && c.claim.type === 'intend_vote') out.set(c.speaker, c.claim.target);
    return out;
  }
}

export function impliedRole(c: Claim): RoleId | null {
  switch (c.type) {
    case 'role':
      return c.role;
    case 'scan':
      return 'sonar';
    case 'protect':
      return 'medic';
    case 'read':
      return 'archivist';
    case 'clue':
      return 'diver';
    default:
      return null;
  }
}
