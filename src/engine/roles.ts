import type { Faction, RoleDef, RoleId } from './types.js';

export const ROLES: Record<RoleId, RoleDef> = {
  diver: {
    id: 'diver',
    name: 'Diver',
    faction: 'crew',
    unique: false,
    blurb: 'Crew. No night action, but the station logs sometimes hand you a clue: a short list of names that contains at least one Undertow.',
  },
  sonar: {
    id: 'sonar',
    name: 'Sonar Tech',
    faction: 'crew',
    nightAction: 'scan',
    unique: true,
    blurb: 'Crew. Each night, ping one player and hear their echo: crew or undertow. A Siren echoes as crew.',
  },
  medic: {
    id: 'medic',
    name: 'Medic',
    faction: 'crew',
    nightAction: 'protect',
    unique: true,
    blurb: 'Crew. Each night, seal one player in the med bay. If the Undertow come for them, they survive. Never the same player two nights running.',
  },
  archivist: {
    id: 'archivist',
    name: 'Archivist',
    faction: 'crew',
    nightAction: 'read',
    unique: true,
    blurb: 'Crew. Nobody learns who the lost really were, except you. Each night, read the personnel log of one lost player and learn their true role.',
  },
  drowned: {
    id: 'drowned',
    name: 'Drowned',
    faction: 'undertow',
    nightAction: 'drag',
    unique: false,
    blurb: 'Undertow. You know your fellow Undertow. Each night you choose together whom to drag under. Win when you match the crew in number, or when the hull gives out.',
  },
  siren: {
    id: 'siren',
    name: 'Siren',
    faction: 'undertow',
    nightAction: 'drag',
    unique: true,
    blurb: 'Undertow. Like the Drowned, but your echo reads as crew to the Sonar Tech.',
  },
};

export function factionOf(role: RoleId): Faction {
  return ROLES[role].faction;
}

/** How the sonar hears a role. */
export function echoOf(role: RoleId): Faction {
  return role === 'siren' ? 'crew' : ROLES[role].faction;
}

/** Default role setup per player count. Tuned with the simulation harness. */
/**
 * Default role lists, tuned with the simulation harness so that heuristic crews
 * and heuristic Undertow win roughly equally often at every table size (see the
 * README for the numbers). The siren and the station-log clue rate are the main
 * balance levers: a siren blinds the sonar, and clues are the crew's best
 * evidence.
 */
export function defaultSetup(playerCount: number): RoleId[] {
  switch (playerCount) {
    case 5:
      return ['siren', 'sonar', 'medic', 'diver', 'diver'];
    case 6:
      return ['drowned', 'drowned', 'sonar', 'medic', 'diver', 'diver'];
    case 7:
      return ['drowned', 'siren', 'sonar', 'medic', 'diver', 'diver', 'diver'];
    case 8:
      return ['drowned', 'siren', 'sonar', 'medic', 'archivist', 'diver', 'diver', 'diver'];
    case 9:
      return ['drowned', 'drowned', 'siren', 'sonar', 'medic', 'archivist', 'diver', 'diver', 'diver'];
    case 10:
      return ['drowned', 'drowned', 'siren', 'sonar', 'medic', 'archivist', 'diver', 'diver', 'diver', 'diver'];
    default:
      throw new Error(`Undertow supports 5 to 10 players, got ${playerCount}`);
  }
}

/** Chance each night that a living diver receives a station-log clue, by table size. */
export function defaultClueChance(playerCount: number): number {
  return ({ 7: 0.6, 8: 0.3, 10: 0.65 } as Record<number, number>)[playerCount] ?? 1;
}

export function countSetup(roles: RoleId[]): Record<RoleId, number> {
  const out: Record<RoleId, number> = { diver: 0, sonar: 0, medic: 0, archivist: 0, drowned: 0, siren: 0 };
  for (const r of roles) out[r]++;
  return out;
}

export const ROLE_IDS = Object.keys(ROLES) as RoleId[];
