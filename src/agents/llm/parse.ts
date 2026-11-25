/**
 * Robust extraction of the single JSON object an agent must reply with. Models
 * sometimes wrap JSON in prose or code fences, or emit two objects; we take the
 * first balanced top-level object that parses.
 */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  for (let start = cleaned.indexOf('{'); start !== -1; start = cleaned.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(cleaned.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error('no JSON object found in reply');
}

export interface AgentStep {
  thought: string;
  tool: string;
  args: Record<string, unknown>;
}

export function parseStep(text: string): AgentStep {
  const raw = extractJson(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('reply must be a JSON object');
  const o = raw as Record<string, unknown>;
  const tool = typeof o.tool === 'string' ? o.tool : typeof o.action === 'string' ? (o.action as string) : '';
  if (!tool) throw new Error('missing "tool"');
  const args = o.args && typeof o.args === 'object' && !Array.isArray(o.args) ? (o.args as Record<string, unknown>) : {};
  return { thought: typeof o.thought === 'string' ? o.thought : '', tool, args };
}
