import type {
  Action,
  DecisionRequest,
  GameConfig,
  GameEvent,
  Phase,
  PlayerId,
  RoleId,
} from '../engine/types.js';

export interface PublicPlayer {
  id: PlayerId;
  name: string;
  seat: number;
  alive: boolean;
  fate?: 'dragged' | 'airlocked';
}

/** Everything a single player is allowed to know when making a decision. */
export interface Observation {
  me: PlayerId;
  role: RoleId;
  partners: PlayerId[];
  round: number;
  phase: Phase;
  hull: number;
  config: GameConfig;
  setup: Record<RoleId, number>;
  players: PublicPlayer[];
  /** Events visible to this player, in order. */
  events: GameEvent[];
  request: DecisionRequest;
}

/** What an agent can expose for the spectator view and for debugging. */
export interface AgentInsight {
  /** P(player is Undertow) from this agent's point of view. */
  beliefs: Record<PlayerId, number>;
  /** Most recent private reasoning, if the agent produces any. */
  thought?: string;
  notes?: string[];
  stats?: Record<string, number>;
}

export interface Agent {
  readonly id: PlayerId;
  readonly kind: string;
  decide(obs: Observation): Promise<Action>;
  insight?(): AgentInsight;
}
