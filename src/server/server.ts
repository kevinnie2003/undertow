import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAgentFactory, type AgentKind } from '../agents/factory.js';
import { AnthropicProvider } from '../agents/llm/anthropic.js';
import { OpenAICompatibleProvider } from '../agents/llm/openai.js';
import { UsageMeter } from '../agents/llm/provider.js';
import type { Action } from '../engine/types.js';
import { GameSession, type ClientView } from '../runner/session.js';

const here = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = process.env.UNDERTOW_WEB_ROOT ?? join(here, 'web');
const PORT = Number(process.env.PORT ?? 8787);
const MAX_GAMES = Number(process.env.UNDERTOW_MAX_GAMES ?? 20);
const GAME_TTL_MS = 2 * 60 * 60 * 1000;

interface Hosted {
  session: GameSession;
  token: string;
  created: number;
  meter: UsageMeter;
}

const games = new Map<string, Hosted>();

export function availableKinds(): AgentKind[] {
  const kinds: AgentKind[] = ['heuristic', 'mock-llm'];
  if ((process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) && process.env.UNDERTOW_ANTHROPIC_MODEL) kinds.push('anthropic');
  if (process.env.OPENAI_MODEL) kinds.push('openai');
  return kinds;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 32_000): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function sweep(): void {
  const now = Date.now();
  for (const [id, g] of games) {
    if (now - g.created > GAME_TTL_MS) {
      g.session.stop();
      games.delete(id);
    }
  }
}

export function createGame(body: Record<string, unknown>): { id: string; token: string; view: ClientView } {
  sweep();
  if (games.size >= MAX_GAMES) throw new Error('server is full, try again later');
  const players = Math.min(10, Math.max(5, Number(body.players ?? 7)));
  const seed = Number.isFinite(Number(body.seed)) ? Number(body.seed) >>> 0 : Math.floor(Math.random() * 2 ** 31);
  const kind = (String(body.agent ?? 'heuristic') as AgentKind);
  if (!availableKinds().includes(kind)) throw new Error(`agent kind ${kind} is not available on this server`);
  const watch = body.mode === 'watch';
  const name = String(body.name ?? 'You').trim().slice(0, 24) || 'You';
  const seat = Number.isInteger(body.seat) ? Math.min(players - 1, Math.max(0, Number(body.seat))) : seed % players;
  const meter = new UsageMeter();
  let session: GameSession | null = null;
  const make = makeAgentFactory({
    kind,
    seed,
    meter,
    onTrace: (t) => session?.recordTrace(t),
    provider: () => (kind === 'anthropic' ? new AnthropicProvider() : new OpenAICompatibleProvider()),
  });
  session = new GameSession({
    players,
    seed,
    human: watch ? undefined : { seat, name },
    makeAgent: make,
    agentKind: kind,
    paceMs: Number(body.paceMs ?? (kind === 'heuristic' || kind === 'mock-llm' ? 900 : 0)),
  });
  const id = randomUUID();
  const token = randomUUID();
  games.set(id, { session, token, created: Date.now(), meter });
  void session.start();
  return { id, token, view: session.view() };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  if (parts[1] === 'health') return json(res, 200, { ok: true, kinds: availableKinds(), games: games.size });
  if (parts[1] !== 'games') return json(res, 404, { error: 'not found' });

  if (parts.length === 2 && req.method === 'POST') {
    try {
      const created = createGame((await readBody(req)) as Record<string, unknown>);
      return json(res, 201, created);
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
  }

  const hosted = games.get(parts[2] ?? '');
  if (!hosted) return json(res, 404, { error: 'no such game' });
  const token = url.searchParams.get('token') ?? (req.headers['x-game-token'] as string | undefined);
  if (token !== hosted.token) return json(res, 403, { error: 'bad token' });

  if (parts[3] === 'stream' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const unsubscribe = hosted.session.subscribe((view) => {
      res.write(`event: view\ndata: ${JSON.stringify({ ...view, usage: { calls: hosted.meter.calls, inputTokens: hosted.meter.inputTokens, outputTokens: hosted.meter.outputTokens } })}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
    return;
  }

  if (parts[3] === 'act' && req.method === 'POST') {
    try {
      const body = (await readBody(req)) as { action?: Action };
      if (!body.action) return json(res, 400, { error: 'missing action' });
      const result = hosted.session.act(body.action);
      return json(res, result.ok ? 200 : 409, result);
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
  }

  if (parts[3] === 'pace' && req.method === 'POST') {
    const body = (await readBody(req)) as { paceMs?: number };
    hosted.session.paceMs = Math.max(0, Math.min(5000, Number(body.paceMs ?? 0)));
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'not found' });
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
};

async function serveStatic(res: ServerResponse, path: string): Promise<void> {
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  const file = join(WEB_ROOT, rel);
  if (!file.startsWith(WEB_ROOT)) return json(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

export function startServer(port = PORT) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const work = url.pathname.startsWith('/api/') ? handleApi(req, res, url) : serveStatic(res, url.pathname);
    work.catch((err) => {
      console.error(err);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    });
  });
  server.listen(port, () => {
    console.log(`Undertow server on http://localhost:${port}  (agent kinds: ${availableKinds().join(', ')})`);
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) startServer();
