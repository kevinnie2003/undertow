import { factionOf } from '../engine/roles.js';
import { Rng, hashSeed } from '../engine/rng.js';
import type { Action, Claim, PlayerId, RoleId } from '../engine/types.js';
import { computeBeliefs, type BeliefParams, type BeliefResult } from './beliefs.js';
import { Memory } from './memory.js';
import type { Persona } from './personas.js';
import type { Agent, AgentInsight, Observation } from './types.js';
import { renderSpeech } from './voice.js';

/** Tunable policy dials. Defaults were picked with the simulation harness. */
export interface PolicyParams {
  /** Crew skip a vote when their top suspect is this close to the average suspicion. */
  skipRatio: number;
  /** How much declared vote intentions pull a vote toward the crowd. */
  coordination: number;
  /** Accuse a player when P(undertow) is at least this multiple of the average. */
  accuseRatio: number;
  /** Undertow abandon ("bus") a partner whose public suspicion exceeds this. */
  bussAt: number;
  /** Scales persona boldness into the chance of a fake role claim. */
  deception: number;
  /** Chance that Undertow invent a station-log clue on a given day. */
  fakeClue: number;
  beliefs?: Partial<BeliefParams>;
}

export const DEFAULT_POLICY: PolicyParams = {
  skipRatio: 1.15,
  coordination: 0.35,
  accuseRatio: 1.3,
  bussAt: 0.8,
  deception: 0.7,
  fakeClue: 0.15,
};

export interface HeuristicOptions {
  id: PlayerId;
  persona: Persona;
  seed?: number;
  policy?: Partial<PolicyParams>;
}

interface Ctx {
  obs: Observation;
  alive: PlayerId[];
  others: PlayerId[];
  priv: BeliefResult;
  pub: BeliefResult;
  avg: number;
}

/**
 * A deterministic, reasonably sneaky rule-based player. It uses the exact
 * Bayesian tracker for reasoning and a few hand-written strategies on top:
 * crew share information when it pays to, Undertow blend in, frame, fake role
 * claims, counter-claim and occasionally sacrifice a doomed partner.
 *
 * It doubles as the fallback brain for LLM agents.
 */
export class HeuristicAgent implements Agent {
  readonly kind = 'heuristic';
  readonly id: PlayerId;
  readonly memory: Memory;
  readonly persona: Persona;
  readonly policy: PolicyParams;
  private rng: Rng;
  private lastBeliefs: Map<PlayerId, number> = new Map();
  private lastThought = '';
  /** Undertow cover story: a role we will claim if needed, and our invented results. */
  private cover: { role: RoleId | null; fakeScans: { round: number; target: PlayerId; result: 'crew' | 'undertow' }[]; revealed: boolean } = {
    role: null,
    fakeScans: [],
    revealed: false,
  };
  private coverDecided = false;

  constructor(opts: HeuristicOptions) {
    this.id = opts.id;
    this.persona = opts.persona;
    this.policy = { ...DEFAULT_POLICY, ...opts.policy };
    this.memory = new Memory(opts.id);
    this.rng = new Rng(opts.seed ?? hashSeed(opts.id + opts.persona.name));
  }

  insight(): AgentInsight {
    return { beliefs: Object.fromEntries(this.lastBeliefs), thought: this.lastThought };
  }

  async decide(obs: Observation): Promise<Action> {
    return this.decideSync(obs);
  }

  decideSync(obs: Observation): Action {
    const ctx = this.context(obs);
    const undertow = factionOf(obs.role) === 'undertow';
    switch (obs.request.kind) {
      case 'night':
        return { kind: 'night', target: undertow ? this.undertowNight(ctx) : this.crewNight(ctx) };
      case 'speak': {
        const claims = undertow ? this.undertowClaims(ctx, false) : this.crewClaims(ctx, false);
        return { kind: 'speak', speech: { text: this.render(claims, ctx), claims } };
      }
      case 'vote':
        return { kind: 'vote', target: undertow ? this.undertowVote(ctx) : this.crewVote(ctx) };
      case 'last_words': {
        const claims = undertow ? this.undertowClaims(ctx, true) : this.crewClaims(ctx, true);
        return { kind: 'last_words', speech: { text: this.render(claims, ctx, 'last'), claims } };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  /** Build beliefs for a decision. Public beliefs model what a typical crew member sees. */
  context(obs: Observation): Ctx {
    this.memory.ingest(obs.events);
    const players = obs.players.map((p) => p.id);
    const aliveSet = new Set(obs.players.filter((p) => p.alive).map((p) => p.id));
    const base = { players, alive: aliveSet, setup: obs.setup, memory: this.memory, params: this.policy.beliefs };
    const priv = computeBeliefs({ ...base, perspective: 'private' });
    const pub = computeBeliefs({ ...base, perspective: 'public' });
    const alive = [...aliveSet];
    const others = alive.filter((id) => id !== this.id);
    const avg = others.reduce((s, id) => s + priv.p.get(id)!, 0) / Math.max(1, others.length);
    this.lastBeliefs = priv.p;
    return { obs, alive, others, priv, pub, avg };
  }

  private render(claims: Claim[], ctx: Ctx, mood?: 'last'): string {
    const m = this.memory;
    const round = ctx.obs.round;
    const accused = m.accusationsAgainst(this.id, round).length >= 2;
    // React to the night only in our first words of the day.
    const firstToday = mood !== 'last' && !m.speeches.some((sp) => sp.round === round && sp.speaker === this.id);
    const scene = firstToday
      ? { lost: m.deaths.filter((d) => d.round === round && d.fate === 'dragged').map((d) => d.player), calm: round > 1 && m.quietNights.includes(round) }
      : undefined;
    return renderSpeech(claims, this.persona, (id) => m.name(id), this.rng, mood ?? (accused ? 'defend' : undefined), scene);
  }

  private top(ids: PlayerId[], score: (id: PlayerId) => number): PlayerId | null {
    let best: PlayerId | null = null;
    let bestScore = -Infinity;
    for (const id of ids) {
      const s = score(id) + this.rng.next() * 1e-6;
      if (s > bestScore) {
        bestScore = s;
        best = id;
      }
    }
    return best;
  }

  /** Share of today's declared vote intentions aimed at a player, weighted by declarer trust. */
  private intentionShare(ctx: Ctx, target: PlayerId, beliefs: BeliefResult): number {
    const intents = this.memory.intentions(ctx.obs.round);
    let w = 0;
    for (const [who, t] of intents) if (who !== this.id && t === target) w += 1 - beliefs.p.get(who)!;
    return w / Math.max(1, ctx.alive.length - 1);
  }

  private pressured(ctx: Ctx): boolean {
    const accusations = this.memory.accusationsAgainst(this.id, ctx.obs.round).length;
    const pubTop = this.top(ctx.alive, (id) => ctx.pub.p.get(id)!);
    return accusations >= 2 || (pubTop === this.id && ctx.pub.p.get(this.id)! > 0.5);
  }

  private isFinalDiscussionRound(ctx: Ctx): boolean {
    const speeches = this.memory.speeches.filter((s) => s.round === ctx.obs.round && s.speaker === this.id && !s.lastWords).length;
    return speeches + 1 >= ctx.obs.config.discussionRounds;
  }

  private othersClaiming(role: RoleId): PlayerId[] {
    const out: PlayerId[] = [];
    for (const [id, r] of this.memory.claimedRoles()) if (r === role && id !== this.id && !this.memory.isDead(id)) out.push(id);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Crew policy
  // ---------------------------------------------------------------------------

  private crewNight(ctx: Ctx): PlayerId | null {
    const req = ctx.obs.request;
    const options = (req.options ?? []).filter((o): o is PlayerId => o !== 'skip');
    if (options.length === 0) return null;
    const p = (id: PlayerId) => ctx.priv.p.get(id)!;
    switch (req.nightAction) {
      case 'scan': {
        const scanned = new Set(this.memory.scans.map((s) => s.target));
        const fresh = options.filter((id) => !scanned.has(id));
        const pool = fresh.length ? fresh : options;
        // Prefer suspicious-but-uncertain players and people making big claims.
        const claimed = this.memory.claimedRoles();
        return this.top(pool, (id) => 0.6 * p(id) + 0.4 * (1 - Math.abs(2 * p(id) - 1)) + (claimed.has(id) ? 0.15 : 0) + 0.1 * this.rng.next());
      }
      case 'protect': {
        const claimed = this.memory.claimedRoles();
        return this.top(options, (id) => {
          const trust = 1 - p(id);
          const r = claimed.get(id);
          const power = r === 'sonar' || r === 'archivist' ? 0.9 : r === 'medic' ? 0.2 : 0;
          const loud = Math.min(3, this.memory.claimsBy(id).filter((c) => c.claim.type === 'accuse').length) * 0.1;
          const self = id === this.id ? 0.25 : 0;
          return trust * (1 + power) + loud + self + 0.15 * this.rng.next();
        });
      }
      case 'read': {
        // Airlocked players are the ones whose roles nobody knows.
        const airlocked = this.memory.deaths.filter((d) => d.fate === 'airlocked').map((d) => d.player);
        const pref = options.filter((id) => airlocked.includes(id));
        return (pref.length ? pref : options)[pref.length ? pref.length - 1 : 0];
      }
      default:
        return null;
    }
  }

  private crewClaims(ctx: Ctx, lastWords: boolean): Claim[] {
    const m = this.memory;
    const role = ctx.obs.role;
    const claims: Claim[] = [];
    const alive = new Set(ctx.alive);
    const pressured = this.pressured(ctx);
    const round = ctx.obs.round;
    const persona = this.persona;

    const reveal = (results: Claim[], force: boolean) => {
      if (!force) return;
      if (!m.saidBefore((c) => c.type === 'role' && c.role === role)) claims.push({ type: 'role', role });
      for (const r of results) if (!m.saidBefore((c) => JSON.stringify(c) === JSON.stringify(r))) claims.push(r);
    };

    switch (role) {
      case 'sonar': {
        const results: Claim[] = m.scans.map((s) => ({ type: 'scan', round: s.round, target: s.target, result: s.result }));
        const hit = m.scans.some((s) => s.result === 'undertow' && alive.has(s.target));
        const counter = this.othersClaiming('sonar').length > 0;
        const revealed = m.saidBefore((c) => c.type === 'role');
        const force =
          lastWords || revealed || hit || counter || pressured || round >= 3 || (round >= 2 && this.rng.next() < persona.openness);
        reveal(results, force && results.length > 0);
        break;
      }
      case 'archivist': {
        const results: Claim[] = m.reads.map((r) => ({ type: 'read', round: r.round, target: r.target, role: r.role }));
        const found = m.reads.some((r) => factionOf(r.role) === 'undertow' || m.deaths.find((d) => d.player === r.target)?.fate === 'airlocked');
        const counter = this.othersClaiming('archivist').length > 0;
        const revealed = m.saidBefore((c) => c.type === 'role');
        reveal(results, (lastWords || revealed || found || counter || pressured) && results.length > 0);
        break;
      }
      case 'medic': {
        const saves = m.protects.filter((p) => p.saved);
        const counter = this.othersClaiming('medic').length > 0;
        const results: Claim[] = saves.map((s) => ({ type: 'protect', round: s.round, target: s.target }));
        const force = lastWords || counter || saves.some((s) => s.round === round) || (pressured && this.memory.accusationsAgainst(this.id, round).length >= 3);
        if (force) {
          if (!m.saidBefore((c) => c.type === 'role')) claims.push({ type: 'role', role: 'medic' });
          for (const r of results) if (!m.saidBefore((c) => JSON.stringify(c) === JSON.stringify(r))) claims.push(r);
        }
        break;
      }
      case 'diver': {
        for (const c of m.clues) {
          const claim: Claim = { type: 'clue', round: c.round, suspects: c.suspects };
          if (!m.saidBefore((x) => x.type === 'clue' && x.round === c.round)) claims.push(claim);
        }
        if (lastWords && !m.saidBefore((c) => c.type === 'role')) claims.unshift({ type: 'role', role: 'diver' });
        break;
      }
    }

    // Accuse the top suspect, vouch for players we know are clean.
    const p = (id: PlayerId) => ctx.priv.p.get(id)!;
    const suspect = this.top(ctx.others, p);
    if (suspect && p(suspect) >= Math.max(0.25, this.policy.accuseRatio * ctx.avg)) {
      const already = !lastWords && m.claims.some((c) => c.round === round && c.speaker === this.id && c.claim.type === 'accuse' && c.claim.target === suspect);
      if (!already) claims.push({ type: 'accuse', target: suspect });
      if (this.persona.aggression > 0.65) {
        const second = this.top(ctx.others.filter((id) => id !== suspect), p);
        if (second && p(second) > 0.6) claims.push({ type: 'accuse', target: second });
      }
    }
    for (const id of ctx.others) {
      if (p(id) < 0.02 && m.accusationsAgainst(id, round).length > 0 && !m.saidBefore((c) => c.type === 'vouch' && c.target === id)) {
        claims.push({ type: 'vouch', target: id });
      }
    }
    if (!lastWords && this.isFinalDiscussionRound(ctx)) claims.push({ type: 'intend_vote', target: this.crewVote(ctx) });
    return claims;
  }

  private crewVote(ctx: Ctx): PlayerId | 'skip' {
    const p = (id: PlayerId) => ctx.priv.p.get(id)!;
    const score = (id: PlayerId) => p(id) + this.policy.coordination * this.intentionShare(ctx, id, ctx.priv);
    const best = this.top(ctx.others, score);
    if (!best) return 'skip';
    const flat = p(best) < this.policy.skipRatio * ctx.avg && this.intentionShare(ctx, best, ctx.priv) < 0.3;
    // Skipping costs hull, so only do it while there is hull to spare.
    if (flat && ctx.obs.hull >= 3) {
      this.lastThought = `No clear suspect (top ${p(best).toFixed(2)} vs avg ${ctx.avg.toFixed(2)}), skipping.`;
      return 'skip';
    }
    this.lastThought = `Voting ${this.memory.name(best)} (P=${p(best).toFixed(2)}).`;
    return best;
  }

  // ---------------------------------------------------------------------------
  // Undertow policy
  // ---------------------------------------------------------------------------

  private team(ctx: Ctx): PlayerId[] {
    return [this.id, ...ctx.obs.partners];
  }

  private decideCover(ctx: Ctx): void {
    if (this.coverDecided) return;
    this.coverDecided = true;
    const s = ctx.obs.setup;
    const boldness = this.persona.boldness * this.policy.deception;
    // Only one Undertow per team should plan to fake the Sonar: the lowest seat.
    const firstOfTeam = [...this.team(ctx)].sort()[0] === this.id;
    if (s.sonar > 0 && firstOfTeam && this.rng.next() < boldness) this.cover.role = 'sonar';
  }

  /** How much a crew player threatens the Undertow team. */
  private threat(ctx: Ctx, id: PlayerId): number {
    const team = new Set(this.team(ctx));
    const role = this.memory.claimedRoles().get(id);
    let t = 0;
    if (role === 'sonar' || role === 'archivist') t += 1.5 * (1 - ctx.pub.p.get(id)!);
    if (role === 'medic') t += 0.4;
    const hostile = this.memory.claimsBy(id).filter(
      (c) =>
        ((c.claim.type === 'accuse' || c.claim.type === 'intend_vote') && team.has(c.claim.target as PlayerId)) ||
        (c.claim.type === 'scan' && c.claim.result === 'undertow' && team.has(c.claim.target)),
    ).length;
    t += Math.min(3, hostile) * 0.35;
    t += 0.6 * (1 - ctx.pub.p.get(id)!);
    return t;
  }

  private undertowNight(ctx: Ctx): PlayerId | null {
    const options = (ctx.obs.request.options ?? []).filter((o): o is PlayerId => o !== 'skip');
    if (options.length === 0) return null;
    const partnerPick = this.memory.proposals.find((pr) => pr.round === ctx.obs.round && pr.player !== this.id && pr.target);
    if (partnerPick?.target && options.includes(partnerPick.target) && this.rng.next() < 0.85) return partnerPick.target;
    const target = this.top(options, (id) => this.threat(ctx, id) + 0.4 * this.rng.next());
    this.lastThought = `Dragging ${this.memory.name(target!)} (threat ${this.threat(ctx, target!).toFixed(2)}).`;
    return target;
  }

  /** Crew player we'd most like to see airlocked: already suspected, or dangerous. */
  /**
   * How suspicious a frame target must look in public before an Undertow
   * accuses them: the bar a crew player would use, so their accusations are
   * no more frequent or reckless than crew ones.
   */
  private frameBar(ctx: Ctx): number {
    const pubAvg = ctx.others.reduce((a, id) => a + ctx.pub.p.get(id)!, 0) / Math.max(1, ctx.others.length);
    return Math.max(0.25, this.policy.accuseRatio * pubAvg);
  }

  private frameTarget(ctx: Ctx, exclude: PlayerId[] = []): PlayerId | null {
    const team = new Set(this.team(ctx));
    const crew = ctx.others.filter((id) => !team.has(id) && !exclude.includes(id));
    return this.top(crew, (id) => ctx.pub.p.get(id)! + 0.25 * this.threat(ctx, id) + this.policy.coordination * this.intentionShare(ctx, id, ctx.pub));
  }

  private undertowClaims(ctx: Ctx, lastWords: boolean): Claim[] {
    this.decideCover(ctx);
    const m = this.memory;
    const claims: Claim[] = [];
    const round = ctx.obs.round;
    const team = new Set(this.team(ctx));
    const partners = ctx.obs.partners.filter((id) => ctx.alive.includes(id));
    // Two of us piling onto the same crew member with nothing to show for it
    // reads as a team, so leave a target to the partner who is already on it
    // unless crew have joined in.
    const pushers = (target: PlayerId) =>
      m.claims.filter((c) => c.round === round && !c.lastWords && (c.claim.type === 'accuse' || c.claim.type === 'intend_vote') && c.claim.target === target).map((c) => c.speaker);
    const partnerOnly = ctx.others.filter((id) => {
      const who = pushers(id).filter((sp) => sp !== this.id);
      return who.length > 0 && who.every((sp) => team.has(sp));
    });
    const frame = this.frameTarget(ctx, partnerOnly) ?? this.frameTarget(ctx);

    // Is a sonar claimant hurting us? Then counter-claim the role (or claim when cornered).
    const realSonarAttack = this.othersClaiming('sonar').some((id) =>
      m.claimsBy(id).some((c) => c.claim.type === 'scan' && c.claim.result === 'undertow' && team.has(c.claim.target)),
    );
    const cornered = this.pressured(ctx);
    if (this.cover.role === 'sonar' && (this.cover.revealed || realSonarAttack || cornered || lastWords || (round >= 2 && this.rng.next() < 0.4))) {
      // Invent one scan per night so far: frame dangerous crew, clear partners.
      for (let r = 1; r <= round; r++) {
        if (this.cover.fakeScans.some((s) => s.round === r)) continue;
        const attacker = this.othersClaiming('sonar')[0];
        const used = new Set(this.cover.fakeScans.map((s) => s.target));
        let scan: { round: number; target: PlayerId; result: 'crew' | 'undertow' };
        if (attacker && !used.has(attacker) && !team.has(attacker)) scan = { round: r, target: attacker, result: 'undertow' };
        else if (partners.length && this.rng.next() < 0.35 && !used.has(partners[0])) scan = { round: r, target: partners[0], result: 'crew' };
        else {
          const t = this.frameTarget(ctx, [...used]) ?? frame;
          if (!t) continue;
          scan = { round: r, target: t, result: this.rng.next() < 0.6 ? 'undertow' : 'crew' };
        }
        this.cover.fakeScans.push(scan);
      }
      if (!m.saidBefore((c) => c.type === 'role')) claims.push({ type: 'role', role: 'sonar' });
      for (const s of this.cover.fakeScans) {
        if (!m.saidBefore((c) => c.type === 'scan' && c.round === s.round)) claims.push({ type: 'scan', ...s });
      }
      this.cover.revealed = true;
    } else if (
      !this.cover.role &&
      round >= 1 &&
      // Only one clue is dealt each night: never contradict one already on the table.
      !m.claims.some((c) => c.claim.type === 'clue' && c.claim.round === round) &&
      this.rng.next() < this.policy.fakeClue &&
      frame
    ) {
      // Pose as a diver with a planted station-log clue around a crew target.
      const pool = ctx.others.filter((id) => id !== frame && !team.has(id));
      const extra = this.rng.shuffle(pool).slice(0, 1);
      const maybePartner = partners.length && this.rng.next() < 0.3 ? [partners[0]] : this.rng.shuffle(pool.filter((id) => !extra.includes(id))).slice(0, 1);
      claims.push({ type: 'clue', round, suspects: this.rng.shuffle([frame, ...extra, ...maybePartner]) });
    }

    if (lastWords && !m.saidBefore((c) => c.type === 'role') && !this.cover.role) claims.unshift({ type: 'role', role: 'diver' });

    // Accusations: pile onto the frame target; abandon a doomed partner.
    const doomed = partners.find((id) => ctx.pub.p.get(id)! > this.policy.bussAt);
    if (doomed && !lastWords) {
      claims.push({ type: 'accuse', target: doomed });
    } else if (frame && ctx.pub.p.get(frame)! >= this.frameBar(ctx)) {
      if (!m.claims.some((c) => c.round === round && c.speaker === this.id && c.claim.type === 'accuse' && c.claim.target === frame)) {
        claims.push({ type: 'accuse', target: frame });
      }
    }
    if (!lastWords && this.isFinalDiscussionRound(ctx)) claims.push({ type: 'intend_vote', target: this.undertowVote(ctx) });
    return claims;
  }

  private undertowVote(ctx: Ctx): PlayerId | 'skip' {
    const partners = ctx.obs.partners.filter((id) => ctx.alive.includes(id));
    // Where is the table heading?
    const crowd = this.top(ctx.others, (id) => this.intentionShare(ctx, id, ctx.pub) + 0.5 * ctx.pub.p.get(id)!);
    if (crowd && partners.includes(crowd)) {
      const share = this.intentionShare(ctx, crowd, ctx.pub);
      if (share > 0.45 || ctx.pub.p.get(crowd)! > this.policy.bussAt) {
        this.lastThought = `Partner ${this.memory.name(crowd)} is lost; voting with the crowd for cover.`;
        return crowd;
      }
      const alt = this.frameTarget(ctx);
      this.lastThought = `Splitting the vote away from partner onto ${alt ? this.memory.name(alt) : 'skip'}.`;
      return alt ?? 'skip';
    }
    const target = this.frameTarget(ctx);
    this.lastThought = `Framing ${target ? this.memory.name(target) : 'nobody'}.`;
    return target ?? 'skip';
  }
}
