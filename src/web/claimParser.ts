import type { Claim, PlayerId, RoleId } from '../engine/types.js';

/**
 * Pulls structured claims out of a human's free text so that rule-based agents
 * can react to what the human says. It is deliberately conservative: the UI
 * shows the extracted claims as chips the player can remove before sending.
 * It reads English and Simplified Chinese, and a mix of the two.
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
  const zhRole = /我是(?:那个|一名|一个|个)?(声呐员|声呐|医生|档案员|潜水员)/.exec(t);
  if (zhRole) {
    const role = ({ 声呐员: 'sonar', 声呐: 'sonar', 医生: 'medic', 档案员: 'archivist', 潜水员: 'diver' } as Record<string, RoleId>)[zhRole[1]];
    if (!out.some((c) => c.type === 'role' && c.role === role)) out.push({ type: 'role', role });
  }

  const others = players.filter((p) => p.id !== me);
  for (const p of others) {
    const first = p.name.split(' ')[0].toLowerCase();
    const full = p.name.toLowerCase();
    const nameRe = `(?:${escape(full)}|${escape(first)})`;
    const sentences = t.split(/[.!?;。！？；]+/).filter((s) => new RegExp(`\\b${nameRe}\\b`).test(s));
    for (const s of sentences) {
      if (zhClaim(s, nameRe, p.id, round, out)) continue;
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
  if (/\b(skip|no vote|hold my vote)\b/.test(t) || /弃票|跳过|不投|先不投/.test(t)) out.push({ type: 'intend_vote', target: 'skip' });
  // De-duplicate.
  const seen = new Set<string>();
  return out.filter((c) => {
    const k = JSON.stringify(c);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const ZH_SCAN = /探测|声呐|回声|扫描|扫了/;
const ZH_GUILTY = /暗流|溺亡者|塞壬|可疑|撒谎|说谎|骗子|有问题|不对劲|嫌疑/;
const ZH_INNOCENT = /清白|信任|相信|没问题|船员|自己人|干净|安全|无辜/;
const ZH_NOT_GUILTY = /不是(?:暗流|溺亡者|塞壬)|不可疑|没撒谎|没说谎/;

/** One sentence of Chinese table talk about one player. Returns true if it said anything. */
function zhClaim(s: string, nameRe: string, target: PlayerId, round: number, out: Claim[]): boolean {
  if (!/[\u4e00-\u9fff]/.test(s)) return false;
  if (new RegExp(`(?:投(?:票给|给)?|票给|票投)\\s*${nameRe}`).test(s) && !new RegExp(`不投\\s*${nameRe}`).test(s)) {
    out.push({ type: 'intend_vote', target });
    return true;
  }
  const scan = ZH_SCAN.test(s);
  if (ZH_GUILTY.test(s) && !ZH_NOT_GUILTY.test(s)) {
    out.push(scan && /暗流/.test(s) ? { type: 'scan', round, target, result: 'undertow' } : { type: 'accuse', target });
    return true;
  }
  if (ZH_INNOCENT.test(s) || ZH_NOT_GUILTY.test(s)) {
    out.push(scan ? { type: 'scan', round, target, result: 'crew' } : { type: 'vouch', target });
    return true;
  }
  return false;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
