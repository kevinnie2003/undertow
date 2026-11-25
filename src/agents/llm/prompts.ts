import { ROLES } from '../../engine/roles.js';
import type { Claim, PlayerId, RoleId } from '../../engine/types.js';
import type { Memory } from '../memory.js';
import type { Persona } from '../personas.js';
import type { Observation } from '../types.js';

export const RULES = `UNDERTOW: a social deduction game on Meridian-9, a research station on the sea floor.

Some of the crew are no longer themselves: they are the Undertow. Everyone else is crew.
- Crew win when every Undertow has been airlocked.
- Undertow win when living Undertow equal or outnumber living crew, or when the hull gives out.

Each round has a night and a day.
NIGHT: the Undertow secretly choose one crew member to drag under (not on the first night). Crew with night roles act:
  - Sonar Tech: pings one player and hears their echo, crew or undertow. A Siren echoes as crew.
  - Medic: seals one player in the med bay; if the Undertow come for them, they survive. Never the same player two nights in a row.
  - Archivist: reads the file of one lost player and learns their true role. Nobody else ever learns who the lost really were.
  - Divers (plain crew) may receive a station-log clue: a short list of names containing at least one Undertow.
DAY: everyone alive speaks in turn (a few rounds), then all vote at once to airlock one player, or skip.
  - A player is airlocked only with strictly the most votes and more votes than "skip".
  - A day without an airlocking costs one point of hull. Hull at 0 floods the station: Undertow win.
  - The airlocked player gives last words. Their role is not revealed.

Talk is free: anyone may claim anything, true or false. Claims are attached to speeches in structured form
so everyone can track them. Undertow lie; crew usually tell the truth but may hide their role to stay alive.`;

export function roleBrief(role: RoleId, partners: string[]): string {
  const r = ROLES[role];
  let s = `Your secret role: ${r.name}. ${r.blurb}`;
  if (r.faction === 'undertow') {
    s += `\nYour fellow Undertow: ${partners.length ? partners.join(', ') : 'none, you are alone'}.`;
    s +=
      '\nStrategy: blend in, steer suspicion onto crew, protect your partners without looking like it, and consider faking a role or a clue when it helps. Never reveal you are Undertow.';
  } else {
    s +=
      '\nStrategy: find the Undertow. Share real information when it helps the crew more than it endangers you, look for contradictions between claims, and watch how people vote.';
  }
  return s;
}

export function systemPrompt(persona: Persona, name: string, role: RoleId, partnerNames: string[]): string {
  return `${RULES}

You are playing as ${name}, the station's ${persona.job}. ${persona.description}
Speak in character: natural, short table talk (1 to 4 sentences), no stage directions, no markdown.

${roleBrief(role, partnerNames)}

HOW YOU ACT
Every reply you write must be exactly one JSON object and nothing else:
{"thought": "<your private reasoning, a few sentences>", "tool": "<tool name>", "args": { ... }}

Information tools (optional, use at most a couple per decision):
- "review_claims"  args {"player": "<id or name, optional>"}  -> every claim made so far, optionally by one player
- "review_votes"   args {}                                   -> how everyone voted each day
- "estimate"       args {}                                   -> a quick probability estimate of who is Undertow, from your own knowledge. Treat it as a calculator, not gospel.
- "note"           args {"text": "..."}                      -> save a private note you will see in later turns

Final tools (exactly one ends the decision; use the one the task asks for):
- "speak"        args {"text": "...", "claims": [Claim, ...]}
- "last_words"   args {"text": "...", "claims": [Claim, ...]}
- "vote"         args {"target": "<player id>" | "skip", "reason": "..."}
- "night_action" args {"target": "<player id>" | null, "note": "<optional message to fellow Undertow>"}

Claims make your statements machine-readable. Attach a claim for every concrete assertion in your text:
  {"type":"role","role":"sonar|medic|archivist|diver|drowned|siren"}
  {"type":"scan","round":N,"target":"<id>","result":"crew|undertow"}
  {"type":"protect","round":N,"target":"<id>"}
  {"type":"read","round":N,"target":"<id>","role":"<role>"}
  {"type":"clue","round":N,"suspects":["<id>","<id>","<id>"]}
  {"type":"accuse","target":"<id>"}   {"type":"vouch","target":"<id>"}
  {"type":"intend_vote","target":"<id>|skip"}
Use player ids (like "p3") in claims and targets. Claims may be lies if that is your strategy.`;
}

function claimText(c: Claim, name: (id: PlayerId) => string): string {
  switch (c.type) {
    case 'role':
      return `claims ${ROLES[c.role].name}`;
    case 'scan':
      return `scan n${c.round}: ${name(c.target)} = ${c.result}`;
    case 'protect':
      return `protected ${name(c.target)} n${c.round}`;
    case 'read':
      return `read n${c.round}: ${name(c.target)} = ${ROLES[c.role].name}`;
    case 'clue':
      return `clue n${c.round}: one of ${c.suspects.map(name).join(', ')}`;
    case 'accuse':
      return `accuses ${name(c.target)}`;
    case 'vouch':
      return `vouches for ${name(c.target)}`;
    case 'intend_vote':
      return `will vote ${c.target === 'skip' ? 'skip' : name(c.target)}`;
  }
}

export function describeClaims(m: Memory, filter?: PlayerId): string {
  const name = (id: PlayerId) => `${m.name(id)} (${id})`;
  const rows = m.claims
    .filter((c) => !filter || c.speaker === filter)
    .map((c) => `day ${c.round}${c.lastWords ? ' (last words)' : ''} - ${name(c.speaker)}: ${claimText(c.claim, name)}`);
  return rows.length ? rows.join('\n') : 'No claims yet.';
}

export function describeVotes(m: Memory): string {
  if (!m.votes.length) return 'No votes yet.';
  return m.votes
    .map((v) => {
      const lines = Object.entries(v.votes).map(([who, t]) => `${m.name(who)} -> ${t === 'skip' ? 'skip' : m.name(t)}`);
      return `Day ${v.round}: ${lines.join('; ')}. ${v.airlocked ? `${m.name(v.airlocked)} was airlocked.` : 'Nobody was airlocked.'}`;
    })
    .join('\n');
}

/** The per-decision state digest: everything the agent knows, compactly. */
export function stateDigest(obs: Observation, m: Memory, notes: string[]): string {
  const name = (id: PlayerId) => `${m.name(id)} (${id})`;
  const lines: string[] = [];
  lines.push(`ROUND ${obs.round}, phase: ${obs.phase.replace('_', ' ')}. Hull: ${obs.hull}/${obs.config.hull}.`);
  const setup = Object.entries(obs.setup)
    .filter(([, n]) => n > 0)
    .map(([r, n]) => `${n} ${ROLES[r as RoleId].name}`)
    .join(', ');
  lines.push(`Roles in this game: ${setup}.`);
  lines.push(`You are ${name(obs.me)}.`);
  lines.push(`Alive: ${obs.players.filter((p) => p.alive).map((p) => name(p.id)).join(', ')}.`);
  const dead = obs.players.filter((p) => !p.alive);
  if (dead.length) lines.push(`Lost: ${dead.map((p) => `${name(p.id)} (${p.fate === 'dragged' ? 'dragged under at night, so crew' : 'airlocked, role unknown'})`).join(', ')}.`);

  const secret: string[] = [];
  for (const s of m.scans) secret.push(`Night ${s.round} you pinged ${name(s.target)}: ${s.result}.`);
  for (const p of m.protects) secret.push(`Night ${p.round} you sealed ${name(p.target)}${p.saved ? ' and it SAVED them from the Undertow' : ''}.`);
  for (const r of m.reads) secret.push(`Night ${r.round} you read ${name(r.target)}'s file: ${ROLES[r.role].name}.`);
  for (const c of m.clues) secret.push(`Night ${c.round} station log clue: at least one of ${c.suspects.map(name).join(', ')} is Undertow.`);
  for (const p of m.proposals) secret.push(`Night ${p.round} ${name(p.player)} proposed dragging ${p.target ? name(p.target) : 'nobody'}${p.note ? ` ("${p.note}")` : ''}.`);
  if (secret.length) lines.push(`\nYOUR SECRET KNOWLEDGE\n${secret.join('\n')}`);

  lines.push('\nWHAT HAPPENED');
  for (let r = 1; r <= obs.round; r++) {
    const deaths = m.deaths.filter((d) => d.round === r);
    const dawn = deaths.find((d) => d.fate === 'dragged');
    if (r > 1 || dawn) lines.push(`Night ${r}: ${dawn ? `${name(dawn.player)} was dragged under.` : m.quietNights.includes(r) ? 'nobody was taken.' : 'quiet.'}`);
    for (const s of m.speeches.filter((x) => x.round === r)) {
      lines.push(`  ${s.lastWords ? 'LAST WORDS ' : ''}${m.name(s.speaker)}: "${s.text}"`);
    }
    const v = m.votes.find((x) => x.round === r);
    if (v) {
      const tally = Object.entries(v.votes).map(([who, t]) => `${m.name(who)}->${t === 'skip' ? 'skip' : m.name(t)}`);
      lines.push(`  Vote: ${tally.join(', ')}. ${v.airlocked ? `${m.name(v.airlocked)} airlocked.` : 'No airlock; hull damaged.'}`);
    }
  }
  if (notes.length) lines.push(`\nYOUR NOTES\n${notes.slice(-12).map((n) => `- ${n}`).join('\n')}`);
  return lines.join('\n');
}

export function taskText(obs: Observation, m: Memory): string {
  const req = obs.request;
  const name = (id: string) => (id === 'skip' ? 'skip' : `${m.name(id)} (${id})`);
  const opts = (req.options ?? []).map(name).join(', ');
  switch (req.kind) {
    case 'night':
      switch (req.nightAction) {
        case 'drag':
          return `NIGHT ${obs.round}: choose whom the Undertow drag under. Options: ${opts}. Finish with "night_action". You may add a short note to your partners.`;
        case 'scan':
          return `NIGHT ${obs.round}: choose whom to ping with sonar. Options: ${opts}. Finish with "night_action" (target null to skip).`;
        case 'protect':
          return `NIGHT ${obs.round}: choose whom to seal in the med bay. Options: ${opts}. Finish with "night_action".`;
        case 'read':
          return `NIGHT ${obs.round}: choose whose file to read. Options: ${opts}. Finish with "night_action".`;
        default:
          return `NIGHT ${obs.round}: options ${opts}. Finish with "night_action".`;
      }
    case 'speak': {
      const mine = m.speeches.filter((s) => s.round === obs.round && s.speaker === obs.me).length;
      const last = mine + 1 >= obs.config.discussionRounds;
      return `DAY ${obs.round}, your turn to speak (turn ${mine + 1} of ${obs.config.discussionRounds}). Finish with "speak".${
        last ? ' This is your last turn before the vote: say who you will vote for (intend_vote claim).' : ''
      }`;
    }
    case 'vote':
      return `DAY ${obs.round} VOTE: choose one of: ${opts}. Finish with "vote".`;
    case 'last_words':
      return `You have been airlocked. Give your last words (you can still help your team). Finish with "last_words".`;
  }
}
