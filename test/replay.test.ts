import { describe, expect, it } from 'vitest';
import { GameSession } from '../src/runner/session.js';
import { parseReplay, ReplayClient, ReplayRecorder, viewAt } from '../src/web/replay.js';
import type { View } from '../src/web/client.js';

async function recordGame(seed: number) {
  const session = new GameSession({ players: 7, seed });
  const rec = new ReplayRecorder();
  session.subscribe((v) => rec.push(v));
  await session.start();
  return { session, rec };
}

describe('replays', () => {
  it('records a finished game and plays it back frame by frame', async () => {
    const { session, rec } = await recordGame(5);
    expect(rec.ready).toBe(true);
    const replay = parseReplay(JSON.stringify(rec.build(new Date(0))));
    const final = session.view();
    expect(replay.events).toHaveLength(final.events.length);
    expect(replay.frames.length).toBeGreaterThan(10);

    const first = viewAt(replay, 0);
    const last = viewAt(replay, replay.frames.length - 1);
    expect(first.events.length).toBeLessThan(last.events.length);
    expect(last.events).toHaveLength(final.events.length);
    expect(last.winner).toBe(final.winner);
    expect(last.roles).toEqual(final.roles);

    // Frames move forward through the game, never back.
    for (let i = 1; i < replay.frames.length; i++) expect(replay.frames[i].seq).toBeGreaterThanOrEqual(replay.frames[i - 1].seq);
  });

  it('steps, seeks phases and refuses actions', async () => {
    const { rec } = await recordGame(8);
    const rc = new ReplayClient(rec.build());
    const seen: View[] = [];
    rc.subscribe((v) => seen.push(v));
    rc.seekPhase(1);
    const afterPhase = seen[seen.length - 1];
    expect(`${afterPhase.round}:${afterPhase.phase}`).not.toBe(`${seen[0].round}:${seen[0].phase}`);
    rc.seekPhase(-1);
    expect(rc.index).toBe(0);
    rc.seek(10_000);
    expect(rc.index).toBe(rc.length - 1);
    expect(seen[seen.length - 1].phase).toBe('ended');
    expect((await rc.act()).ok).toBe(false);
    rc.stop();
  });

  it('rejects anything that is not a replay', () => {
    expect(() => parseReplay('nope')).toThrow(/not JSON/);
    expect(() => parseReplay('{"format":"other"}')).toThrow(/not an Undertow replay/);
    expect(() => parseReplay('{"format":"undertow-replay","version":2}')).toThrow(/version/);
  });

  it('cannot be built before the game ends', () => {
    const rec = new ReplayRecorder();
    const session = new GameSession({ players: 5, seed: 1, human: { seat: 0, name: 'Kev' } });
    rec.push(session.view());
    expect(rec.ready).toBe(false);
    expect(() => rec.build()).toThrow();
  });
});

describe('replay playback granularity', () => {
  it('steps one event at a time even when frames were coarse', async () => {
    const { rec } = await recordGame(3);
    const replay = rec.build();
    const rc = new ReplayClient(replay);
    expect(rc.length).toBeGreaterThan(replay.frames.length);
    const counts = Array.from({ length: rc.length }, (_, i) => viewAt(rc.replay, i).events.length);
    for (let i = 1; i < counts.length; i++) expect(counts[i] - counts[i - 1]).toBeLessThanOrEqual(1);
  });
});
