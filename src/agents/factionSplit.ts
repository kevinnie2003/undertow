import { factionOf } from '../engine/roles.js';
import type { Action } from '../engine/types.js';
import type { Agent, AgentInsight, Observation } from './types.js';

/**
 * A seat whose controller depends on the hidden role it was dealt: one agent
 * kind for crew, another for the Undertow. Used to pit agent kinds against
 * each other (for example Claude crew against heuristic Undertow). The inner
 * agent is built on the first decision, once the role is known.
 */
export class FactionSplitAgent implements Agent {
  private inner: Agent | null = null;
  constructor(
    readonly id: string,
    private makeCrew: () => Agent,
    private makeUndertow: () => Agent,
  ) {}

  get kind(): string {
    return this.inner?.kind ?? 'split';
  }

  decide(obs: Observation): Promise<Action> {
    this.inner ??= factionOf(obs.role) === 'undertow' ? this.makeUndertow() : this.makeCrew();
    return this.inner.decide(obs);
  }

  insight(): AgentInsight {
    return this.inner?.insight?.() ?? { beliefs: {} };
  }
}
