import { writeFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { formatReport, simulate } from './simulate.js';

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
  },
});

async function main() {
  const counts = values.all ? [5, 6, 7, 8, 9, 10] : [Number(values.players)];
  const config = {
    ...(values.hull ? { hull: Number(values.hull) } : {}),
    ...(values.rounds ? { discussionRounds: Number(values.rounds) } : {}),
    ...(values.reveal ? { revealOnAirlock: true } : {}),
  };
  const out: unknown[] = [];
  for (const players of counts) {
    const started = Date.now();
    const { report, games } = await simulate({ games: Number(values.games), players, seed: Number(values.seed), config });
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
