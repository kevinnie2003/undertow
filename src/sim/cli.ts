import { writeFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { formatReport, simulate } from './simulate.js';
import type { RoleId } from '../engine/types.js';
import type { AgentKind } from '../agents/factory.js';
import type { LLMProvider } from '../agents/llm/provider.js';

const KINDS: AgentKind[] = ['heuristic', 'mock-llm', 'anthropic', 'openai'];

async function providerFor(kind: 'anthropic' | 'openai'): Promise<() => LLMProvider> {
  if (kind === 'anthropic') {
    const { AnthropicProvider } = await import('../agents/llm/anthropic.js');
    return () => new AnthropicProvider();
  }
  const { OpenAICompatibleProvider } = await import('../agents/llm/openai.js');
  return () => new OpenAICompatibleProvider();
}
import { createLineup } from '../runner/lineup.js';
import { Match } from '../runner/match.js';
import { transcript } from './transcript.js';

const { values } = parseArgs({
  options: {
    games: { type: 'string', default: '500' },
    players: { type: 'string', default: '7' },
    seed: { type: 'string', default: '1' },
    hull: { type: 'string' },
    rounds: { type: 'string' },
    reveal: { type: 'boolean', default: false },
    json: { type: 'string' },
    all: { type: 'boolean', default: false },
    transcript: { type: 'boolean', default: false },
    roles: { type: 'string' },
    policy: { type: 'string' },
    clue: { type: 'string' },
    crew: { type: 'string' },
    undertow: { type: 'string' },
    concurrency: { type: 'string' },
  },
});

async function main() {
  const counts = values.roles ? [values.roles.split(',').length] : values.all ? [5, 6, 7, 8, 9, 10] : [Number(values.players)];
  const config = {
    ...(values.hull ? { hull: Number(values.hull) } : {}),
    ...(values.rounds ? { discussionRounds: Number(values.rounds) } : {}),
    ...(values.reveal ? { revealOnAirlock: true } : {}),
    ...(values.clue ? { clueChance: Number(values.clue) } : {}),
    ...(values.roles ? { roles: values.roles.split(',') as RoleId[] } : {}),
  };
  if (values.transcript) {
    const { game, agents } = createLineup({ players: counts[0], seed: Number(values.seed), config });
    await new Match(game, agents).run();
    console.log(transcript(game.state.events, game.state.players, { omniscient: true }));
    return;
  }
  const kinds = [values.crew, values.undertow].filter(Boolean) as string[];
  for (const k of kinds) if (!KINDS.includes(k as AgentKind)) throw new Error(`unknown agent kind ${k} (use ${KINDS.join(', ')})`);
  const needsProvider = kinds.find((k) => k === 'anthropic' || k === 'openai') as 'anthropic' | 'openai' | undefined;
  if (kinds.includes('anthropic') && kinds.includes('openai')) throw new Error('use one real provider per run');
  const policy = values.policy ? Object.fromEntries(values.policy.split(',').map((kv) => [kv.split('=')[0], Number(kv.split('=')[1])])) : undefined;
  const out: unknown[] = [];
  for (const players of counts) {
    const started = Date.now();
    const { report, games } = await simulate({
      games: Number(values.games),
      players,
      seed: Number(values.seed),
      config,
      policy,
      crew: values.crew as AgentKind | undefined,
      undertow: values.undertow as AgentKind | undefined,
      provider: needsProvider ? await providerFor(needsProvider) : undefined,
      concurrency: values.concurrency ? Number(values.concurrency) : needsProvider ? 4 : 1,
    });
    console.log(formatReport(report));
    console.log(`  (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
    out.push({ report, games });
  }
  if (values.json) {
    mkdirSync('sim-results', { recursive: true });
    writeFileSync(values.json, JSON.stringify(out, null, 2));
    console.log(`wrote ${values.json}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
