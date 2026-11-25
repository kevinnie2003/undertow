import { Game } from '../src/engine/game.js';
import type { Action, DecisionRequest, GameConfig, PlayerId, RoleId } from '../src/engine/types.js';

export const NAMES = ['Ada', 'Ben', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo'];

export function makeGame(roles: RoleId[], config: Partial<GameConfig> = {}, seed = 1): Game {
  return Game.create({ seed, names: NAMES.slice(0, roles.length), config: { ...config, roles } });
}

export function idOf(game: Game, role: RoleId, nth = 0): PlayerId {
  const p = game.state.players.filter((x) => x.role === role)[nth];
  if (!p) throw new Error(`no ${role} #${nth}`);
  return p.id;
}

/** Answer every pending request with `pick`, falling back to a neutral action. */
export function step(game: Game, pick: (req: DecisionRequest) => Action | undefined = () => undefined): void {
  for (const req of game.pendingRequests()) {
    if (game.over) return;
    game.submit(req.playerId, pick(req) ?? neutral(req));
  }
}

export function neutral(req: DecisionRequest): Action {
  switch (req.kind) {
    case 'night':
      return { kind: 'night', target: req.allowNone ? null : (req.options![0] as PlayerId) };
    case 'speak':
      return { kind: 'speak', speech: { text: 'hm', claims: [] } };
    case 'vote':
      return { kind: 'vote', target: 'skip' };
    case 'last_words':
      return { kind: 'last_words', speech: { text: 'bye', claims: [] } };
  }
}

/** Step until the phase changes to `phase` (or the game ends). */
export function advanceTo(game: Game, phase: Game['state']['phase'], pick?: Parameters<typeof step>[1]): void {
  let guard = 0;
  while (game.state.phase !== phase && !game.over) {
    step(game, pick);
    if (++guard > 500) throw new Error('advanceTo did not converge');
  }
}

export function eventsOf<T extends string>(game: Game, type: T) {
  return game.state.events.filter((e) => e.data.type === type);
}
