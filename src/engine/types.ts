// Core types for the Undertow game engine.
// The engine is pure and deterministic: given a seed and the same sequence of
// submitted actions it always produces the same game.

export type PlayerId = string;

export type Faction = 'crew' | 'undertow';

export type RoleId =
  | 'diver' // plain crew, receives station-log clues at night
  | 'sonar' // scans one player per night, learns their echo (faction)
  | 'medic' // shields one player per night from being dragged under
  | 'archivist' // reads the log of one lost player per night, learns their true role
  | 'drowned' // undertow: votes on who to drag under at night
  | 'siren'; // undertow: like drowned, but echoes as crew to sonar

export type NightActionKind = 'scan' | 'protect' | 'read' | 'drag';

export interface RoleDef {
  id: RoleId;
  name: string;
  faction: Faction;
  nightAction?: NightActionKind;
  /** Only one player may hold this role (affects claim reasoning). */
  unique: boolean;
  blurb: string;
}

export type Phase = 'night' | 'day_discussion' | 'day_vote' | 'last_words' | 'ended';

export interface Player {
  id: PlayerId;
  name: string;
  seat: number;
  role: RoleId;
  alive: boolean;
  /** How the player left the game, if they did. */
  fate?: 'dragged' | 'airlocked';
  diedRound?: number;
}

export interface GameConfig {
  /** Number of speaking rounds in each day discussion. */
  discussionRounds: number;
  /** Hull integrity. Each day that ends without an airlocking costs one point. */
  hull: number;
  /** Probability that a diver receives a station-log clue on a night. */
  clueChance: number;
  /** Size of the suspect list in a clue. */
  clueSize: number;
  /** Reveal the faction of airlocked players to everyone. */
  revealOnAirlock: boolean;
  /** Whether the Undertow drag someone on the very first night. */
  firstNightDrag: boolean;
  /** Safety valve so a game can never loop forever. */
  maxRounds: number;
  /** Override the default role setup for the player count. */
  roles?: RoleId[];
}

export const DEFAULT_CONFIG: GameConfig = {
  discussionRounds: 2,
  hull: 3,
  clueChance: 1,
  clueSize: 3,
  revealOnAirlock: false,
  firstNightDrag: false,
  maxRounds: 12,
};

// ---------------------------------------------------------------------------
// Claims: structured statements a player can attach to a speech. They are the
// machine-readable layer of table talk that agents reason over. Claims may be
// lies; the engine never checks them.
// ---------------------------------------------------------------------------

export type Claim =
  | { type: 'role'; role: RoleId }
  | { type: 'scan'; round: number; target: PlayerId; result: Faction }
  | { type: 'protect'; round: number; target: PlayerId }
  | { type: 'read'; round: number; target: PlayerId; role: RoleId }
  | { type: 'clue'; round: number; suspects: PlayerId[] }
  | { type: 'accuse'; target: PlayerId }
  | { type: 'vouch'; target: PlayerId }
  | { type: 'intend_vote'; target: PlayerId | 'skip' };

export interface Speech {
  text: string;
  claims: Claim[];
}

// ---------------------------------------------------------------------------
// Actions submitted to the engine.
// ---------------------------------------------------------------------------

export type Action =
  | { kind: 'night'; target: PlayerId | null; note?: string }
  | { kind: 'speak'; speech: Speech }
  | { kind: 'vote'; target: PlayerId | 'skip' }
  | { kind: 'last_words'; speech: Speech };

export type RequestKind = Action['kind'];

/** A decision the engine is waiting for. */
export interface DecisionRequest {
  playerId: PlayerId;
  kind: RequestKind;
  /** For night/vote requests: valid targets. */
  options?: (PlayerId | 'skip')[];
  nightAction?: NightActionKind;
  /** Whether "no target" is allowed for a night action. */
  allowNone?: boolean;
  round: number;
}

// ---------------------------------------------------------------------------
// Events. Every event has a visibility list so that the engine can produce a
// redacted view for each player.
// ---------------------------------------------------------------------------

export type Visibility = 'all' | PlayerId[];

export type EventData =
  | { type: 'game_start'; players: { id: PlayerId; name: string; seat: number }[]; setup: Record<RoleId, number>; config: GameConfig }
  | { type: 'role_assigned'; player: PlayerId; role: RoleId; partners: PlayerId[] }
  | { type: 'phase'; phase: Phase; round: number }
  | { type: 'undertow_proposal'; player: PlayerId; target: PlayerId | null; note?: string }
  | { type: 'dragged'; player: PlayerId }
  | { type: 'quiet_night' }
  | { type: 'scan_result'; player: PlayerId; target: PlayerId; result: Faction }
  | { type: 'protect_result'; player: PlayerId; target: PlayerId; saved: boolean }
  | { type: 'read_result'; player: PlayerId; target: PlayerId; role: RoleId }
  | { type: 'clue'; player: PlayerId; suspects: PlayerId[] }
  | { type: 'speech'; player: PlayerId; speech: Speech; discussionRound: number }
  | { type: 'votes'; votes: Record<PlayerId, PlayerId | 'skip'>; tally: Record<string, number> }
  | { type: 'airlocked'; player: PlayerId; faction?: Faction }
  | { type: 'no_airlock'; reason: 'tie' | 'skip' }
  | { type: 'hull'; hull: number; delta: number }
  | { type: 'last_words'; player: PlayerId; speech: Speech }
  | { type: 'game_end'; winner: Faction; reason: WinReason; roles: Record<PlayerId, RoleId> };

export type WinReason = 'all_undertow_gone' | 'undertow_parity' | 'hull_breach' | 'round_limit';

export interface GameEvent {
  seq: number;
  round: number;
  phase: Phase;
  visibleTo: Visibility;
  data: EventData;
}

export interface GameState {
  seed: number;
  rngState: number;
  config: GameConfig;
  players: Player[];
  round: number;
  phase: Phase;
  hull: number;
  events: GameEvent[];
  /** Night bookkeeping. */
  night: {
    undertowProposals: Record<PlayerId, PlayerId | null>;
    actions: Record<PlayerId, PlayerId | null>;
  };
  /** Medic's previous protect target per medic, to forbid repeats. */
  lastProtect: Record<PlayerId, PlayerId | null>;
  /** Archivist reads already done (so they don't waste a read). */
  readsDone: Record<PlayerId, PlayerId[]>;
  discussion: { order: PlayerId[]; index: number; round: number };
  votes: Record<PlayerId, PlayerId | 'skip'>;
  pendingLastWords: PlayerId | null;
  winner?: Faction;
  winReason?: WinReason;
}
