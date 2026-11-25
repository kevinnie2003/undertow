import { makeAgentFactory, type AgentKind } from '../agents/factory.js';
import type { Action } from '../engine/types.js';
import { GameSession, type ClientView } from '../runner/session.js';
import { langRef, type Lang } from '../i18n/lang.js';

export interface NewGameOptions {
  players: number;
  seed: number;
  mode: 'play' | 'watch';
  name: string;
  agent: AgentKind;
  paceMs: number;
  lang: Lang;
}

export type View = ClientView & { usage?: { calls: number; inputTokens: number; outputTokens: number } };

export interface GameClient {
  subscribe(fn: (v: View) => void): void;
  act(action: Action): Promise<{ ok: boolean; error?: string }>;
  setPace(ms: number): void;
  /** The language the AI crew speaks from now on. */
  setLang(lang: Lang): void;
  stop(): void;
}

/** Runs the whole game in the browser. Works offline, with heuristic or mock-LLM agents. */
export class LocalClient implements GameClient {
  private session: GameSession;
  private lang = langRef();
  constructor(opts: NewGameOptions) {
    let session: GameSession | null = null;
    this.lang.current = opts.lang;
    const make = makeAgentFactory({ kind: opts.agent, seed: opts.seed, onTrace: (t) => session?.recordTrace(t), lang: () => this.lang.current });
    session = new GameSession({
      players: opts.players,
      seed: opts.seed,
      human: opts.mode === 'play' ? { seat: opts.seed % opts.players, name: opts.name } : undefined,
      makeAgent: make,
      agentKind: opts.agent,
      paceMs: opts.paceMs,
    });
    this.session = session;
  }
  subscribe(fn: (v: View) => void): void {
    this.session.subscribe(fn);
    void this.session.start();
  }
  async act(action: Action) {
    return this.session.act(action);
  }
  setPace(ms: number) {
    this.session.paceMs = ms;
  }
  setLang(lang: Lang) {
    this.lang.current = lang;
  }
  stop() {
    this.session.stop();
  }
}

/** Talks to the Node server, which hosts LLM agents and keeps API keys off the client. */
export class RemoteClient implements GameClient {
  private source: EventSource | null = null;
  private constructor(
    private id: string,
    private token: string,
  ) {}

  static async create(opts: NewGameOptions): Promise<RemoteClient> {
    const res = await fetch('/api/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'could not create game');
    return new RemoteClient(body.id, body.token);
  }

  subscribe(fn: (v: View) => void): void {
    this.source = new EventSource(`/api/games/${this.id}/stream?token=${encodeURIComponent(this.token)}`);
    this.source.addEventListener('view', (e) => fn(JSON.parse((e as MessageEvent).data)));
  }

  async act(action: Action) {
    const res = await fetch(`/api/games/${this.id}/act?token=${encodeURIComponent(this.token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    return res.json();
  }

  setPace(ms: number) {
    void fetch(`/api/games/${this.id}/pace?token=${encodeURIComponent(this.token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paceMs: ms }),
    });
  }

  setLang(lang: Lang) {
    void fetch(`/api/games/${this.id}/lang?token=${encodeURIComponent(this.token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lang }),
    });
  }

  stop() {
    this.source?.close();
  }
}

export async function serverKinds(): Promise<AgentKind[] | null> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body.kinds) ? body.kinds : null;
  } catch {
    return null;
  }
}
