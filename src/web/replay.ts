import type { DecisionTrace } from '../agents/llm/llmAgent.js';
import type { AgentInsight } from '../agents/types.js';
import type { GameEvent, PlayerId, RoleId } from '../engine/types.js';
import type { SessionPlayer } from '../runner/session.js';
import type { GameClient, View } from './client.js';

/**
 * A saved game: every event, plus one small frame per moment worth stepping
 * to. Frames point into the event list by sequence number, so a replay of a
 * long game stays compact.
 */
export interface Replay {
  format: 'undertow-replay';
  version: 1;
  savedAt: string;
  agentKind: string;
  /** Who the recording player was, if a human played. */
  you: PlayerId | null;
  maxHull: number;
  setup: Record<RoleId, number>;
  roles: Record<PlayerId, RoleId>;
  events: GameEvent[];
  traces: DecisionTrace[];
  frames: ReplayFrame[];
}

export interface ReplayFrame {
  /** Highest event sequence number visible in this frame (-1 for none). */
  seq: number;
  round: number;
  phase: View['phase'];
  hull: number;
  players: SessionPlayer[];
  insights: Record<PlayerId, AgentInsight> | null;
  /** How many of the replay's traces had been recorded by this frame. */
  traces: number;
  winner: View['winner'];
  winReason: View['winReason'];
}

const lastSeq = (events: GameEvent[]) => (events.length ? events[events.length - 1].seq : -1);

/** Collects frames from the live views of a game. */
export class ReplayRecorder {
  private frames: ReplayFrame[] = [];
  private traces: DecisionTrace[] = [];
  private traceKeys = new Set<string>();
  private last: View | null = null;

  push(v: View): void {
    for (const t of v.traces ?? []) {
      const key = JSON.stringify(t);
      if (this.traceKeys.has(key)) continue;
      this.traceKeys.add(key);
      this.traces.push(t);
    }
    const frame: ReplayFrame = {
      seq: lastSeq(v.events),
      round: v.round,
      phase: v.phase,
      hull: v.hull,
      players: v.players,
      insights: v.insights,
      traces: this.traces.length,
      winner: v.winner,
      winReason: v.winReason,
    };
    const prev = this.frames[this.frames.length - 1];
    // A new frame only when something visible changed (not for "thinking…" updates).
    if (prev && prev.seq === frame.seq && prev.phase === frame.phase && prev.winner === frame.winner && prev.traces === frame.traces) {
      this.frames[this.frames.length - 1] = frame;
    } else {
      this.frames.push(frame);
    }
    this.last = v;
  }

  get ready(): boolean {
    return !!this.last && this.last.phase === 'ended' && !!this.last.roles;
  }

  /** The finished replay. Only once the game is over, when every event and role is visible. */
  build(now = new Date()): Replay {
    const v = this.last;
    if (!v || !v.roles) throw new Error('the game is not over yet');
    return {
      format: 'undertow-replay',
      version: 1,
      savedAt: now.toISOString(),
      agentKind: v.agentKind,
      you: v.you,
      maxHull: v.maxHull,
      setup: v.setup,
      roles: v.roles,
      events: v.events,
      traces: this.traces,
      frames: this.frames,
    };
  }
}

export function parseReplay(text: string): Replay {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That is not a replay file (not JSON).');
  }
  const r = data as Partial<Replay>;
  if (!r || r.format !== 'undertow-replay') throw new Error('That is not an Undertow replay.');
  if (r.version !== 1) throw new Error(`Unsupported replay version ${String(r.version)}.`);
  if (!Array.isArray(r.events) || !Array.isArray(r.frames) || r.frames.length === 0 || !r.roles) throw new Error('The replay is incomplete.');
  return r as Replay;
}

/** The spectator view of a replay at one frame: everything revealed, up to that moment. */
export function viewAt(r: Replay, index: number): View {
  const i = Math.max(0, Math.min(r.frames.length - 1, index));
  const f = r.frames[i];
  return {
    you: null,
    yourRole: null,
    partners: [],
    players: f.players,
    round: f.round,
    phase: f.phase,
    hull: f.hull,
    maxHull: r.maxHull,
    setup: r.setup,
    events: r.events.filter((e) => e.seq <= f.seq),
    pending: null,
    roles: r.roles,
    insights: f.insights,
    traces: r.traces.slice(0, f.traces).slice(-60),
    thinking: [],
    winner: f.winner,
    winReason: f.winReason,
    agentKind: `${r.agentKind} · replay`,
  };
}

/**
 * One step per event: a frame that took in several events at once (a fast
 * game publishes less often) is split so playback still goes line by line.
 * The in-between steps keep the earlier frame's state, so nobody dies early.
 */
export function expandFrames(r: Replay): Replay {
  const frames: ReplayFrame[] = [];
  let prev: ReplayFrame | null = null;
  for (const f of r.frames) {
    if (prev) {
      for (const e of r.events) {
        if (e.seq > prev.seq && e.seq < f.seq) frames.push({ ...prev, seq: e.seq });
      }
    }
    frames.push(f);
    prev = f;
  }
  return { ...r, frames };
}

/** Plays a replay back through the same interface as a live game. */
export class ReplayClient implements GameClient {
  index = 0;
  playing = false;
  private listeners = new Set<(v: View) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  readonly replay: Replay;

  constructor(
    replay: Replay,
    public paceMs = 700,
  ) {
    this.replay = expandFrames(replay);
  }

  get length(): number {
    return this.replay.frames.length;
  }

  subscribe(fn: (v: View) => void): void {
    this.listeners.add(fn);
    fn(viewAt(this.replay, this.index));
  }

  async act() {
    return { ok: false, error: 'This is a replay.' };
  }

  setPace(ms: number) {
    this.paceMs = ms;
  }

  seek(index: number) {
    this.index = Math.max(0, Math.min(this.length - 1, index));
    if (this.index === this.length - 1) this.pause();
    const v = viewAt(this.replay, this.index);
    for (const fn of this.listeners) fn(v);
  }

  /** Jump to the first frame of the next (or previous) phase. */
  seekPhase(dir: 1 | -1) {
    const f = this.replay.frames;
    const key = (j: number) => `${f[j].round}:${f[j].phase}`;
    let j = this.index;
    if (dir === 1) {
      while (j < f.length - 1 && key(j) === key(this.index)) j++;
    } else {
      // Back to the start of this phase, or of the previous one if already there.
      while (j > 0 && key(j - 1) === key(this.index)) j--;
      if (j === this.index && j > 0) {
        j--;
        const k = key(j);
        while (j > 0 && key(j - 1) === k) j--;
      }
    }
    this.seek(j);
  }

  play() {
    if (this.index >= this.length - 1) this.index = 0;
    this.playing = true;
    this.tick();
  }

  pause() {
    this.playing = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private tick() {
    if (!this.playing) return;
    this.timer = setTimeout(() => {
      this.seek(this.index + 1);
      this.tick();
    }, Math.max(60, this.paceMs));
  }

  stop() {
    this.pause();
    this.listeners.clear();
  }
}
