import { ROLE_IDS } from './roles.js';
import type { Claim, PlayerId } from './types.js';

/**
 * Structural validation of claims. Claims can be lies, but they must be well
 * formed and refer to real players, otherwise agents could not reason about them.
 */
export function isValidClaim(claim: unknown, playerIds: readonly PlayerId[], speaker: PlayerId): claim is Claim {
  if (!claim || typeof claim !== 'object') return false;
  const c = claim as Record<string, unknown>;
  const isPlayer = (v: unknown) => typeof v === 'string' && playerIds.includes(v) && v !== speaker;
  const isRound = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 50;
  switch (c.type) {
    case 'role':
      return typeof c.role === 'string' && (ROLE_IDS as string[]).includes(c.role);
    case 'scan':
      return isRound(c.round) && isPlayer(c.target) && (c.result === 'crew' || c.result === 'undertow');
    case 'protect':
      // A medic may have sealed themselves.
      return isRound(c.round) && typeof c.target === 'string' && playerIds.includes(c.target);
    case 'read':
      return isRound(c.round) && isPlayer(c.target) && typeof c.role === 'string' && (ROLE_IDS as string[]).includes(c.role);
    case 'clue':
      return (
        isRound(c.round) &&
        Array.isArray(c.suspects) &&
        c.suspects.length >= 1 &&
        c.suspects.length <= 5 &&
        c.suspects.every(isPlayer) &&
        new Set(c.suspects).size === c.suspects.length
      );
    case 'accuse':
    case 'vouch':
      return isPlayer(c.target);
    case 'intend_vote':
      return c.target === 'skip' || isPlayer(c.target);
    default:
      return false;
  }
}

/** Keep only well-formed claims, normalised to plain objects, dropping exact duplicates. */
export function cleanClaims(claims: unknown[], playerIds: readonly PlayerId[], speaker: PlayerId): Claim[] {
  const out: Claim[] = [];
  const seen = new Set<string>();
  for (const raw of claims) {
    if (!isValidClaim(raw, playerIds, speaker)) continue;
    const c = normalise(raw);
    const key = JSON.stringify(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function normalise(c: Claim): Claim {
  switch (c.type) {
    case 'role':
      return { type: 'role', role: c.role };
    case 'scan':
      return { type: 'scan', round: c.round, target: c.target, result: c.result };
    case 'protect':
      return { type: 'protect', round: c.round, target: c.target };
    case 'read':
      return { type: 'read', round: c.round, target: c.target, role: c.role };
    case 'clue':
      return { type: 'clue', round: c.round, suspects: [...c.suspects] };
    case 'accuse':
    case 'vouch':
      return { type: c.type, target: c.target };
    case 'intend_vote':
      return { type: 'intend_vote', target: c.target };
  }
}
