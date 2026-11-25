import { ROLES } from '../engine/roles.js';
import type { Claim, GameEvent, Player, PlayerId } from '../engine/types.js';

/** Human-readable transcript of a finished game (omniscient: shows roles and private events). */
export function transcript(events: GameEvent[], players: Player[], opts: { omniscient?: boolean } = {}): string {
  const name = (id: PlayerId) => {
    const p = players.find((x) => x.id === id);
    if (!p) return id;
    return opts.omniscient ? `${p.name} [${ROLES[p.role].name}]` : p.name;
  };
  const out: string[] = [];
  for (const e of events) {
    const d = e.data;
    const priv = e.visibleTo !== 'all';
    if (priv && !opts.omniscient) continue;
    const tag = priv ? '  (private) ' : '  ';
    switch (d.type) {
      case 'phase':
        out.push(`\n== ${d.phase.replace('_', ' ').toUpperCase()} ${d.round} ==`);
        break;
      case 'undertow_proposal':
        out.push(`${tag}${name(d.player)} proposes dragging ${d.target ? name(d.target) : 'nobody'}`);
        break;
      case 'scan_result':
        out.push(`${tag}${name(d.player)} scans ${name(d.target)}: ${d.result}`);
        break;
      case 'protect_result':
        out.push(`${tag}${name(d.player)} protects ${name(d.target)}${d.saved ? ' (SAVED)' : ''}`);
        break;
      case 'read_result':
        out.push(`${tag}${name(d.player)} reads ${name(d.target)}: ${ROLES[d.role].name}`);
        break;
      case 'clue':
        out.push(`${tag}${name(d.player)} gets clue: one of ${d.suspects.map(name).join(', ')}`);
        break;
      case 'dragged':
        out.push(`  ${name(d.player)} was dragged under.`);
        break;
      case 'quiet_night':
        out.push('  Nobody was taken.');
        break;
      case 'speech':
      case 'last_words':
        out.push(`  ${d.type === 'last_words' ? 'LAST WORDS ' : ''}${name(d.player)}: "${d.speech.text}"${claimsText(d.speech.claims, name)}`);
        break;
      case 'votes':
        out.push(`  Votes: ${Object.entries(d.votes).map(([v, t]) => `${name(v)}->${t === 'skip' ? 'skip' : name(t)}`).join('; ')}`);
        break;
      case 'airlocked':
        out.push(`  ${name(d.player)} was airlocked.`);
        break;
      case 'no_airlock':
        out.push(`  No airlock (${d.reason}).`);
        break;
      case 'hull':
        out.push(`  Hull now ${d.hull}.`);
        break;
      case 'game_end':
        out.push(`\n** ${d.winner.toUpperCase()} WIN (${d.reason}) **`);
        break;
      default:
        break;
    }
  }
  return out.join('\n');
}

function claimsText(claims: Claim[], name: (id: PlayerId) => string): string {
  if (!claims.length) return '';
  const s = claims.map((c) => {
    switch (c.type) {
      case 'role':
        return `role=${c.role}`;
      case 'scan':
        return `scan(n${c.round} ${name(c.target)}=${c.result})`;
      case 'protect':
        return `protect(n${c.round} ${name(c.target)})`;
      case 'read':
        return `read(n${c.round} ${name(c.target)}=${c.role})`;
      case 'clue':
        return `clue(n${c.round} ${c.suspects.map(name).join('/')})`;
      case 'accuse':
        return `accuse(${name(c.target)})`;
      case 'vouch':
        return `vouch(${name(c.target)})`;
      case 'intend_vote':
        return `intend(${c.target === 'skip' ? 'skip' : name(c.target)})`;
    }
  });
  return `  {${s.join(', ')}}`;
}
