import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { GameSession, type ClientView } from '../src/runner/session.js';
import { startServer } from '../src/server/server.js';
import type { Action, DecisionRequest } from '../src/engine/types.js';
import { extractClaims } from '../src/web/claimParser.js';

function humanMove(req: DecisionRequest): Action {
  switch (req.kind) {
    case 'night':
      return { kind: 'night', target: req.allowNone ? null : (req.options![0] as string) };
    case 'speak':
    case 'last_words':
      return { kind: req.kind, speech: { text: 'Just a diver here.', claims: [{ type: 'role', role: 'diver' }] } };
    case 'vote':
      return { kind: 'vote', target: 'skip' };
  }
}

describe('GameSession with a human seat', () => {
  it('waits for the human, hides other roles, and reveals them at the end', async () => {
    const session = new GameSession({ players: 6, seed: 4, human: { seat: 2, name: 'Kev' } });
    const views: ClientView[] = [];
    let acted = 0;
    session.subscribe((v) => {
      views.push(v);
      if (v.phase !== 'ended') {
        expect(v.roles).toBeNull();
        expect(v.insights).toBeNull();
        for (const e of v.events) expect(e.visibleTo === 'all' || e.visibleTo.includes('p2')).toBe(true);
      }
      if (v.pending) {
        queueMicrotask(() => {
          const res = session.act(humanMove(v.pending!));
          if (res.ok) acted++;
        });
      }
    });
    await session.start();
    const last = session.view();
    expect(last.phase).toBe('ended');
    expect(last.roles).not.toBeNull();
    expect(acted).toBeGreaterThan(0);
    expect(views[0].you).toBe('p2');
    expect(last.players[2].name).toBe('Kev');
  });

  it('rejects invalid human actions instead of silently replacing them', async () => {
    const session = new GameSession({ players: 5, seed: 9, human: { seat: 0, name: 'Kev' } });
    let checked = false;
    session.subscribe((v) => {
      if (!v.pending || checked) {
        if (v.pending) queueMicrotask(() => session.act(humanMove(v.pending!)));
        return;
      }
      checked = true;
      queueMicrotask(() => {
        expect(session.act({ kind: 'vote', target: 'p99' }).ok).toBe(false);
        expect(session.act(humanMove(v.pending!)).ok).toBe(true);
      });
    });
    await session.start();
    expect(checked).toBe(true);
  });

  it('a spectator session sees everything, including agent minds', async () => {
    const session = new GameSession({ players: 7, seed: 12 });
    await session.start();
    const v = session.view();
    expect(v.you).toBeNull();
    expect(v.roles).not.toBeNull();
    expect(Object.keys(v.insights ?? {})).toHaveLength(7);
  });
});

describe('claim extraction from typed speech', () => {
  const players = [
    { id: 'p0', name: 'Kev' },
    { id: 'p1', name: 'Ravi Mehta' },
    { id: 'p2', name: 'Hana Sato' },
  ];
  it('finds role, scan and accusation claims', () => {
    const claims = extractClaims('I am the sonar. I pinged Ravi and he echoed undertow. Vote Hana.', players, 'p0', 2);
    expect(claims).toEqual(expect.arrayContaining([{ type: 'role', role: 'sonar' }, expect.objectContaining({ type: 'scan', target: 'p1', result: 'undertow', round: 2 })]));
  });
});

describe('HTTP server', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = startServer(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('reports health and available kinds', async () => {
    const res = await (await fetch(`${base}/api/health`)).json();
    expect(res.ok).toBe(true);
    expect(res.kinds).toEqual(expect.arrayContaining(['heuristic', 'mock-llm']));
  });

  it('plays a game over HTTP and SSE', async () => {
    const created = await (
      await fetch(`${base}/api/games`, { method: 'POST', body: JSON.stringify({ players: 5, seed: 21, mode: 'play', name: 'Kev', agent: 'heuristic', paceMs: 0 }) })
    ).json();
    expect(created.view.you).toBeTruthy();
    expect((await fetch(`${base}/api/games/${created.id}/stream?token=wrong`)).status).toBe(403);
    const res = await fetch(`${base}/api/games/${created.id}/stream?token=${created.token}`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let ended: ClientView | null = null;
    const seen = new Set<string>();
    while (!ended) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const v = JSON.parse(line.slice(6)) as ClientView;
        if (v.phase === 'ended') ended = v;
        else if (v.pending) {
          const key = `${v.round}:${v.phase}:${v.events.length}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const r = await fetch(`${base}/api/games/${created.id}/act?token=${created.token}`, { method: 'POST', body: JSON.stringify({ action: humanMove(v.pending) }) });
          expect(r.status).toBe(200);
        }
      }
    }
    await reader.cancel();
    expect(ended?.winner).toMatch(/crew|undertow/);
  });

  it('refuses unknown agent kinds and serves the static client safely', async () => {
    const bad = await fetch(`${base}/api/games`, { method: 'POST', body: JSON.stringify({ agent: 'anthropic-but-no-key' }) });
    expect(bad.status).toBe(400);
    const trav = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
    expect([403, 404]).toContain(trav.status);
  });
});
