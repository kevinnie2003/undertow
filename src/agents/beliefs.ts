import { factionOf, ROLES } from '../engine/roles.js';
import type { PlayerId, RoleId } from '../engine/types.js';
import { impliedRole, type Memory } from './memory.js';

/**
 * Exact Bayesian belief tracking over "who is Undertow".
 *
 * A hypothesis is the full set of Undertow players (alive or dead). With at
 * most 10 players and 3 Undertow there are at most C(10,3) = 120 hypotheses,
 * so we enumerate them all and weight each one by:
 *
 *   - hard constraints (things the player knows for certain, plus public facts
 *     such as "dragged players are crew" and "the game has not ended"), and
 *   - soft likelihoods for every claim and vote, under a simple behavioural
 *     model: crew tell the truth, Undertow say whatever helps them.
 *
 * Marginals P(player is Undertow) fall out by summing hypothesis weights.
 */

export interface BeliefParams {
  /** Likelihood of a crew player making a claim that contradicts the hypothesis. */
  eps: number;
  crewAccuseHit: number;
  crewVouchHit: number;
  crewIntendHit: number;
  liarAccusePartner: number;
  liarVouchPartner: number;
  liarIntendPartner: number;
  liarScanPartner: number;
  liarCoverPartner: number;
  liarCluePartner: number;
  partnerVote: number;
  crewVoteHit: number;
  /** Crew who change their role claim. */
  roleSwitchCrew: number;
}

export const DEFAULT_BELIEF_PARAMS: BeliefParams = {
  eps: 0.03,
  crewAccuseHit: 1.25,
  crewVouchHit: 1.15,
  crewIntendHit: 1.1,
  liarAccusePartner: 0.35,
  liarVouchPartner: 1.6,
  liarIntendPartner: 0.5,
  liarScanPartner: 0.2,
  liarCoverPartner: 1.5,
  liarCluePartner: 0.6,
  partnerVote: 0.4,
  crewVoteHit: 1.15,
  roleSwitchCrew: 0.1,
};

export interface BeliefInput {
  players: PlayerId[];
  alive: Set<PlayerId>;
  setup: Record<RoleId, number>;
  memory: Memory;
  /** 'private' uses everything this player knows; 'public' only what everyone saw. */
  perspective: 'private' | 'public';
  params?: Partial<BeliefParams>;
}

export interface BeliefResult {
  /** P(player is Undertow). */
  p: Map<PlayerId, number>;
  hypotheses: number;
  /** False if the evidence was contradictory and we fell back to a looser model. */
  consistent: boolean;
  /** Most likely Undertow set and its posterior probability. */
  map: { set: PlayerId[]; prob: number };
}

type Factor = (h: number) => number;

export function computeBeliefs(input: BeliefInput): BeliefResult {
  const params = { ...DEFAULT_BELIEF_PARAMS, ...input.params };
  const { players, alive, setup, memory } = input;
  const n = players.length;
  const idx = new Map(players.map((id, i) => [id, i] as const));
  const bit = (id: PlayerId) => 1 << idx.get(id)!;
  const undertowCount = setup.drowned + setup.siren;
  const sirenFrac = undertowCount > 0 ? setup.siren / undertowCount : 0;
  const priv = input.perspective === 'private';
  const me = memory.me;

  let mustUndertow = 0;
  let mustCrew = 0;
  const atLeastOne: number[] = [];
  const soft: Factor[] = [];

  // --- Private knowledge -----------------------------------------------------
  if (priv && memory.role) {
    if (factionOf(memory.role) === 'undertow') {
      mustUndertow |= bit(me);
      for (const p of memory.partners) mustUndertow |= bit(p);
      // Undertow know the whole team.
      for (const p of players) if (!(mustUndertow & bit(p))) mustCrew |= bit(p);
    } else {
      mustCrew |= bit(me);
    }
    for (const s of memory.scans) {
      if (s.result === 'undertow') mustUndertow |= bit(s.target);
      else if (sirenFrac === 0) mustCrew |= bit(s.target);
      else {
        const b = bit(s.target);
        soft.push((h) => (h & b ? sirenFrac : 1));
      }
    }
    for (const r of memory.reads) {
      if (factionOf(r.role) === 'undertow') mustUndertow |= bit(r.target);
      else mustCrew |= bit(r.target);
    }
    for (const c of memory.clues) atLeastOne.push(c.suspects.reduce((m, id) => m | bit(id), 0));
  }

  // --- Public facts ----------------------------------------------------------
  for (const d of memory.deaths) {
    if (d.fate === 'dragged') mustCrew |= bit(d.player);
    if (d.faction === 'crew') mustCrew |= bit(d.player);
    if (d.faction === 'undertow') mustUndertow |= bit(d.player);
  }
  let aliveMask = 0;
  for (const id of alive) aliveMask |= bit(id);
  const livingCount = alive.size;

  // --- Claims ----------------------------------------------------------------
  const claimRecords = memory.claims.filter((c) => !(priv && c.speaker === me));
  const roleClaims = new Map<PlayerId, Set<RoleId>>();
  for (const c of claimRecords) {
    const r = impliedRole(c.claim);
    if (r) {
      if (!roleClaims.has(c.speaker)) roleClaims.set(c.speaker, new Set());
      roleClaims.get(c.speaker)!.add(r);
    }
  }
  // In the public perspective, my own claims are evidence for others too.
  const latestRole = new Map<PlayerId, RoleId>();
  for (const c of claimRecords) {
    const r = impliedRole(c.claim);
    if (r) latestRole.set(c.speaker, r);
  }

  for (const [speaker, roles] of roleClaims) {
    const sb = bit(speaker);
    for (const r of roles) {
      if (ROLES[r].faction === 'undertow' || setup[r] === 0) soft.push((h) => (h & sb ? 1 : params.eps));
    }
    if (roles.size > 1) soft.push((h) => (h & sb ? 1 : params.roleSwitchCrew));
  }
  // Too many crew claiming the same role means someone is lying.
  for (const role of ['sonar', 'medic', 'archivist', 'diver'] as RoleId[]) {
    const claimants = [...latestRole].filter(([, r]) => r === role).map(([id]) => bit(id));
    const mine = priv && memory.role === role ? 1 : 0;
    if (claimants.length + mine <= setup[role]) continue;
    soft.push((h) => {
      let genuine = mine;
      for (const b of claimants) if (!(h & b)) genuine++;
      const excess = genuine - setup[role];
      return excess > 0 ? Math.pow(params.eps, excess) : 1;
    });
  }

  for (const rec of claimRecords) {
    const sb = bit(rec.speaker);
    const c = rec.claim;
    switch (c.type) {
      case 'scan': {
        const tb = bit(c.target);
        if (c.result === 'undertow') {
          soft.push((h) => (h & sb ? (h & tb ? params.liarScanPartner : 1) : h & tb ? 1 : params.eps));
        } else {
          soft.push((h) => (h & sb ? (h & tb ? params.liarCoverPartner : 1) : h & tb ? Math.max(params.eps, sirenFrac) : 1));
        }
        break;
      }
      case 'read': {
        const tb = bit(c.target);
        const bad = factionOf(c.role) === 'undertow';
        soft.push((h) => {
          if (h & sb) return h & tb ? (bad ? params.liarScanPartner : params.liarCoverPartner) : 1;
          return !!(h & tb) === bad ? 1 : params.eps;
        });
        break;
      }
      case 'clue': {
        const m = c.suspects.reduce((acc, id) => acc | bit(id), 0);
        soft.push((h) => (h & sb ? ((h & ~sb & m) !== 0 ? params.liarCluePartner : 1) : (h & m) !== 0 ? 1 : params.eps));
        break;
      }
      case 'accuse': {
        const tb = bit(c.target);
        soft.push((h) => (h & sb ? (h & tb ? params.liarAccusePartner : 1) : h & tb ? params.crewAccuseHit : 1));
        break;
      }
      case 'vouch': {
        const tb = bit(c.target);
        soft.push((h) => (h & sb ? (h & tb ? params.liarVouchPartner : 1) : h & tb ? 1 / params.crewVouchHit : 1));
        break;
      }
      case 'intend_vote': {
        if (c.target === 'skip') break;
        const tb = bit(c.target);
        soft.push((h) => (h & sb ? (h & tb ? params.liarIntendPartner : 1) : h & tb ? params.crewIntendHit : 1));
        break;
      }
      default:
        break;
    }
  }

  // --- Votes -----------------------------------------------------------------
  for (const v of memory.votes) {
    for (const [voter, target] of Object.entries(v.votes)) {
      if (target === 'skip' || (priv && voter === me)) continue;
      const vb = bit(voter);
      const tb = bit(target);
      soft.push((h) => (h & tb ? (h & vb ? params.partnerVote : params.crewVoteHit) : 1));
    }
  }

  // --- Enumerate -------------------------------------------------------------
  const evaluate = (useSoft: boolean, useClues: boolean) => {
    const weights: { h: number; w: number }[] = [];
    let total = 0;
    forEachCombination(n, undertowCount, (h) => {
      if ((h & mustUndertow) !== mustUndertow || (h & mustCrew) !== 0) return;
      if (useClues) for (const m of atLeastOne) if ((h & m) === 0) return;
      // The game is still running: some Undertow live, and they don't have parity.
      const livingU = popcount(h & aliveMask);
      if (livingU === 0 || livingU >= livingCount - livingU) return;
      let w = 1;
      if (useSoft) for (const f of soft) w *= f(h);
      if (w > 0) {
        weights.push({ h, w });
        total += w;
      }
    });
    return { weights, total };
  };

  let consistent = true;
  let res = evaluate(true, true);
  if (res.total === 0) {
    consistent = false;
    res = evaluate(true, false);
  }
  if (res.total === 0) res = evaluate(false, false);

  const p = new Map<PlayerId, number>();
  for (const id of players) p.set(id, 0);
  let best = { h: 0, w: -1 };
  for (const { h, w } of res.weights) {
    if (w > best.w) best = { h, w };
    for (let i = 0; i < n; i++) if (h & (1 << i)) p.set(players[i], p.get(players[i])! + w);
  }
  if (res.total > 0) for (const id of players) p.set(id, p.get(id)! / res.total);
  else {
    // Completely unconstrained fallback: uniform prior.
    for (const id of players) p.set(id, undertowCount / n);
  }
  const mapSet = players.filter((_, i) => best.h & (1 << i));
  return {
    p,
    hypotheses: res.weights.length,
    consistent,
    map: { set: mapSet, prob: res.total > 0 ? best.w / res.total : 0 },
  };
}

function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

/** Calls fn with every n-bit mask that has exactly k bits set. */
export function forEachCombination(n: number, k: number, fn: (mask: number) => void): void {
  if (k === 0) {
    fn(0);
    return;
  }
  if (k > n) return;
  let mask = (1 << k) - 1;
  const limit = 1 << n;
  while (mask < limit) {
    fn(mask);
    // Gosper's hack: next mask with the same popcount.
    const c = mask & -mask;
    const r = mask + c;
    mask = (((r ^ mask) >>> 2) / c) | r;
  }
}
