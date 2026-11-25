import type { Claim, PlayerId, RoleId } from '../engine/types.js';

/**
 * Pulls structured claims out of a human's free text so that rule-based agents
 * can react to what the human says. It is deliberately conservative: the UI
 * shows the extracted claims as chips the player can remove before sending.
 */
export function extractClaims(text: string, players: { id: PlayerId; name: string }[], me: PlayerId | null, round: number): Claim[] {
  const out: Claim[] = [];
  const t = ` ${text.toLowerCase()} `;
  const roleWords: [RoleId, RegExp][] = [
    ['sonar', /\bi(?:'m| am)(?: the)? (?:sonar|sonar tech)\b/],
    ['medic', /\bi(?:'m| am)(?: the)? medic\b/],
    ['archivist', /\bi(?:'m| am)(?: the)? archivist\b/],
    ['diver', /\bi(?:'m| am)(?: a| just a)? diver\b/],
  ];
  for (const [role, re] of roleWords) if (re.test(t)) out.push({ type: 'role', role });

  const others = players.filter((p) => p.id !== me);
  for (const p of others) {
    const first = p.name.split(' ')[0].toLowerCase();
    const full = p.name.toLowerCase();
    const nameRe = `(?:${escape(full)}|${escape(first)})`;
    const sentences = t.split(/[.!?;]+/).filter((s) => new RegExp(`\\b${nameRe}\\b`).test(s));
    for (const s of sentences) {
      if (new RegExp(`\\bvot(?:e|ing)(?: for)? ${nameRe}\\b`).test(s)) out.push({ type: 'intend_vote', target: p.id });
      else if (/\b(undertow|drowned|siren|suspicious|lying|liar|sus|guilty|off)\b/.test(s) && !/\bnot (undertow|suspicious|lying)\b/.test(s)) {
        if (/\b(pinged|scanned|echo)\b/.test(s) && /\bundertow\b/.test(s)) out.push({ type: 'scan', round, target: p.id, result: 'undertow' });
        else out.push({ type: 'accuse', target: p.id });
      } else if (/\b(clean|crew|trust|innocent|fine|safe)\b/.test(s)) {
        if (/\b(pinged|scanned|echo)\b/.test(s)) out.push({ type: 'scan', round, target: p.id, result: 'crew' });
        else out.push({ type: 'vouch', target: p.id });
      }
    }
  }
  if (/\b(skip|no vote|hold my vote)\b/.test(t)) out.push({ type: 'intend_vote', target: 'skip' });
  // De-duplicate.
  const seen = new Set<string>();
  return out.filter((c) => {
    const k = JSON.stringify(c);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
