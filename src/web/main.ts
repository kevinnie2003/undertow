import { ROLES } from '../engine/roles.js';
import type { Action, Claim, Faction, GameEvent, PlayerId, RoleId } from '../engine/types.js';
import type { AgentKind } from '../agents/factory.js';
import { personaJob } from '../agents/personas.js';
import { asLang, type Lang } from '../i18n/lang.js';
import { factionName, roleBlurb, roleName as roleNameIn } from '../i18n/roles.js';
import { extractClaims } from './claimParser.js';
import { LocalClient, RemoteClient, serverKinds, type GameClient, type NewGameOptions, type View } from './client.js';
import { parseReplay, ReplayClient, ReplayError, ReplayRecorder } from './replay.js';
import { S, setUiLang, uiLang } from './strings.js';

// ---------------------------------------------------------------------------
// Tiny DOM helper
// ---------------------------------------------------------------------------

type Child = Node | string | null | undefined | false;
function h(tag: string, attrs: Record<string, unknown> = {}, ...children: (Child | Child[])[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
const $ = (id: string) => document.getElementById(id)!;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let client: GameClient | null = null;
let view: View | null = null;
let renderedEvents = 0;
let draftClaims: Claim[] = [];
let removedAuto = new Set<string>();
let mind: PlayerId | null = null;
let kinds: AgentKind[] | null = null;
let sending = false;
let recorder: ReplayRecorder | null = null;
let lastPendingKey = '';

const LANG_KEY = 'undertow.lang';

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

function initialLang(): Lang {
  const fromUrl = new URLSearchParams(location.search).get('lang');
  if (fromUrl) return asLang(fromUrl);
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved) return asLang(saved);
  } catch {
    // Storage can be blocked; fall back to the browser's language.
  }
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** Words that live in the static page. */
function applyStatic() {
  const s = S() as unknown as Record<string, unknown>;
  const lang = uiLang();
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.body.dataset.lang = lang;
  document.title = S().docTitle;
  for (const el of document.querySelectorAll<HTMLElement>('[data-t]')) el.textContent = String(s[el.dataset.t!] ?? '');
  for (const el of document.querySelectorAll<HTMLElement>('[data-t-ph]')) el.setAttribute('placeholder', String(s[el.dataset.tPh!] ?? ''));
  for (const el of document.querySelectorAll<HTMLElement>('[data-t-aria]')) el.setAttribute('aria-label', String(s[el.dataset.tAria!] ?? ''));
  for (const b of document.querySelectorAll<HTMLButtonElement>('.lang button')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
}

function switchLang(lang: Lang) {
  if (lang === uiLang()) return;
  setUiLang(lang);
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Not saved; the switch still applies to this visit.
  }
  const nameInput = $('name') as HTMLInputElement;
  const wasDefault = !nameInput.value.trim() || nameInput.value === 'You' || nameInput.value === '你';
  applyStatic();
  if (wasDefault) nameInput.value = S().defaultName;
  fillSetup();
  client?.setLang(lang);
  if (view) {
    // Interface words change at once; lines already spoken stay as they were said.
    const typed = ($('actions').querySelector('textarea') as HTMLTextAreaElement | null)?.value;
    $('log').replaceChildren();
    renderedEvents = 0;
    lastPendingKey = '';
    $('actions').replaceChildren();
    render();
    const area = $('actions').querySelector('textarea') as HTMLTextAreaElement | null;
    if (area && typed) {
      area.value = typed;
      area.dispatchEvent(new Event('input'));
    }
  }
}

// ---------------------------------------------------------------------------
// Setup screen
// ---------------------------------------------------------------------------

function fillSetup() {
  const select = $('agent') as HTMLSelectElement;
  const keep = select.value;
  const available: AgentKind[] = kinds ?? ['heuristic', 'mock-llm'];
  select.replaceChildren(...available.map((k) => h('option', { value: k }, S().kind[k])));
  if (keep && available.includes(keep as AgentKind)) select.value = keep;
  $('server-note').textContent = kinds
    ? S().serverConnected + (kinds.includes('anthropic') || kinds.includes('openai') ? S().serverLlm : S().serverNoLlm)
    : S().browserOnly;
  $('pace-out').textContent = `${($('pace') as HTMLInputElement).value} ${S().paceUnit}`;
}

async function initSetup() {
  setUiLang(initialLang());
  applyStatic();
  ($('name') as HTMLInputElement).value = S().defaultName;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.lang button')) b.addEventListener('click', () => switchLang(asLang(b.dataset.lang)));
  ($('seed') as HTMLInputElement).value = String(Math.floor(Math.random() * 100000));
  $('pace').addEventListener('input', fillSetup);
  fillSetup();
  kinds = await serverKinds();
  fillSetup();
  $('start').addEventListener('click', () => void startGame());
  const file = $('replay-file') as HTMLInputElement;
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (f) void f.text().then(openReplay);
  });
  $('replay-paste-go').addEventListener('click', () => openReplay(($('replay-paste') as HTMLTextAreaElement).value));
}

function openReplay(text: string) {
  try {
    const replay = parseReplay(text);
    recorder = null;
    showGame(new ReplayClient(replay), 700);
  } catch (err) {
    $('replay-error').textContent = err instanceof ReplayError ? S().replayErr[err.code] : (err as Error).message;
  }
}

function showGame(c: GameClient, paceMs: number) {
  client = c;
  renderedEvents = 0;
  draftClaims = [];
  mind = null;
  lastPendingKey = '';
  $('log').replaceChildren();
  $('setup').hidden = true;
  $('game').hidden = false;
  ($('pace-live') as HTMLInputElement).value = String(paceMs);
  client.subscribe((v) => {
    recorder?.push(v);
    view = v;
    render();
  });
}

async function startGame() {
  const opts: NewGameOptions = {
    players: Number(($('players') as HTMLSelectElement).value),
    seed: Number(($('seed') as HTMLInputElement).value) || 1,
    mode: (document.querySelector('input[name=mode]:checked') as HTMLInputElement).value as 'play' | 'watch',
    name: ($('name') as HTMLInputElement).value.trim() || S().defaultName,
    agent: ($('agent') as HTMLSelectElement).value as AgentKind,
    paceMs: Number(($('pace') as HTMLInputElement).value),
    lang: uiLang(),
  };
  let c: GameClient;
  try {
    c = kinds ? await RemoteClient.create(opts) : new LocalClient(opts);
  } catch (err) {
    $('server-note').textContent = S().couldNotStart((err as Error).message);
    return;
  }
  recorder = new ReplayRecorder();
  showGame(c, opts.paceMs);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function name(id: PlayerId): string {
  return view?.players.find((p) => p.id === id)?.name ?? id;
}

function names(ids: PlayerId[]): string {
  return ids.map(name).join(S().listSep);
}

function roleName(r: RoleId) {
  return roleNameIn(r, uiLang());
}

function faction(f: Faction) {
  return factionName(f, uiLang());
}

function seatNo(seat: number) {
  return String(seat + 1).padStart(2, '0');
}

function render() {
  if (!view) return;
  renderHeader();
  renderRoster();
  renderLog();
  renderSide();
  renderActions();
}

function renderHeader() {
  const v = view!;
  const s = S();
  const phase =
    v.phase === 'ended'
      ? s.gameOver
      : v.phase === 'night'
        ? s.night(v.round)
        : `${s.day(v.round)} · ${v.phase === 'day_discussion' ? s.discussion : v.phase === 'day_vote' ? s.vote : s.lastWords}`;
  $('phase').textContent = phase;
  document.body.dataset.phase = v.phase;
  const cells = [];
  for (let i = 0; i < v.maxHull; i++) cells.push(h('span', { class: `seg ${i < v.hull ? 'ok' : 'lost'}` }));
  $('hull').replaceChildren(h('span', { class: 'k' }, s.hull), h('span', { class: 'segs', title: s.hullTitle }, cells), h('span', { class: 'num' }, `${v.hull}/${v.maxHull}`));
  const usage =
    v.usage && v.usage.calls ? ` · ${s.usage(v.usage.calls, (v.usage.inputTokens / 1000).toFixed(1), (v.usage.outputTokens / 1000).toFixed(1))}` : '';
  $('meta').textContent = `${s.kindShort[v.agentKind] ?? v.agentKind}${usage}`;
}

function latestRoleClaims(events: GameEvent[]): Map<PlayerId, RoleId> {
  const out = new Map<PlayerId, RoleId>();
  for (const e of events) {
    if (e.data.type !== 'speech' && e.data.type !== 'last_words') continue;
    for (const c of e.data.speech.claims) {
      const r = c.type === 'role' ? c.role : c.type === 'scan' ? 'sonar' : c.type === 'read' ? 'archivist' : c.type === 'protect' ? 'medic' : c.type === 'clue' ? 'diver' : null;
      if (r) out.set(e.data.player, r);
    }
  }
  return out;
}

function renderRoster() {
  const v = view!;
  const s = S();
  const claims = latestRoleClaims(v.events);
  const todaysVotes = new Map<PlayerId, number>();
  for (const e of v.events) {
    if (e.round !== v.round || e.data.type !== 'speech') continue;
    for (const c of e.data.speech.claims) if (c.type === 'intend_vote' && c.target !== 'skip') todaysVotes.set(c.target, (todaysVotes.get(c.target) ?? 0) + 1);
  }
  // Spectator: average suspicion of each player across the crew agents' minds.
  const consensus = new Map<PlayerId, number>();
  if (v.insights && v.roles) {
    for (const p of v.players) {
      const vals: number[] = [];
      for (const [id, ins] of Object.entries(v.insights)) {
        if (id === p.id || ROLES[v.roles[id]].faction !== 'crew') continue;
        const b = ins.beliefs[p.id];
        if (typeof b === 'number') vals.push(b);
      }
      if (vals.length) consensus.set(p.id, vals.reduce((a, b) => a + b, 0) / vals.length);
    }
  }
  const rows = v.players.map((p) => {
    const role = v.roles?.[p.id];
    const partner = v.partners.includes(p.id);
    const thinking = v.thinking.includes(p.id);
    const sus = consensus.get(p.id);
    const selectable = !!v.insights;
    return h(
      selectable ? 'button' : 'div',
      {
        class: `card ${p.alive ? '' : 'dead'} ${p.human ? 'you' : ''} ${partner ? 'partner' : ''} ${role ? ROLES[role].faction : ''} ${mind === p.id ? 'selected' : ''}`,
        type: selectable ? 'button' : undefined,
        'aria-pressed': selectable ? String(mind === p.id) : undefined,
        onclick: () => {
          if (v.insights) {
            mind = p.id;
            render();
          }
        },
      },
      h('span', { class: 'seat' }, seatNo(p.seat)),
      h(
        'span',
        { class: 'who' },
        h('span', { class: 'nm' }, p.name, p.human && p.name.trim().toLowerCase() !== s.you.toLowerCase() ? h('span', { class: 'tag' }, s.you) : null, partner ? h('span', { class: 'tag undertow' }, s.partner) : null),
        h('span', { class: 'job' }, p.human ? s.thatsYou : personaJob(p, uiLang()), thinking ? h('span', { class: 'dots' }, ' ···') : null),
        h(
          'span',
          { class: 'badges' },
          role ? h('span', { class: `badge role ${ROLES[role].faction}` }, roleName(role)) : null,
          claims.get(p.id) ? h('span', { class: 'badge claim' }, s.claims(roleName(claims.get(p.id)!))) : null,
          !p.alive ? h('span', { class: 'badge fate' }, p.fate === 'dragged' ? s.draggedUnder : s.airlocked) : null,
          todaysVotes.get(p.id) && p.alive && v.phase !== 'night' ? h('span', { class: 'badge intent' }, s.voteIntents(todaysVotes.get(p.id)!)) : null,
        ),
        sus !== undefined && p.alive ? h('span', { class: 'susbar', title: s.suspicion((sus * 100).toFixed(0)) }, h('span', { style: `width:${(sus * 100).toFixed(0)}%` })) : null,
      ),
    );
  });
  $('roster').replaceChildren(...rows);
}

function claimChip(c: Claim, onRemove?: () => void): HTMLElement {
  const s = S().chip;
  let text = '';
  switch (c.type) {
    case 'role':
      text = s.role(roleName(c.role));
      break;
    case 'scan':
      text = s.scan(c.round, name(c.target), faction(c.result));
      break;
    case 'protect':
      text = s.protect(c.round, name(c.target));
      break;
    case 'read':
      text = s.read(c.round, name(c.target), roleName(c.role));
      break;
    case 'clue':
      text = s.clue(c.round, c.suspects.map(name).join(' / '));
      break;
    case 'accuse':
      text = s.accuse(name(c.target));
      break;
    case 'vouch':
      text = s.vouch(name(c.target));
      break;
    case 'intend_vote':
      text = c.target === 'skip' ? s.skipVote : s.vote(name(c.target));
      break;
  }
  const hostile = c.type === 'accuse' || (c.type === 'scan' && c.result === 'undertow') || (c.type === 'intend_vote' && c.target !== 'skip');
  return h(
    'span',
    { class: `chip ${c.type} ${hostile ? 'hostile' : ''}` },
    text,
    onRemove ? h('button', { class: 'x', type: 'button', onclick: onRemove, title: S().remove, 'aria-label': S().remove }, '×') : null,
  );
}

function eventNode(e: GameEvent): HTMLElement | null {
  const v = view!;
  const s = S();
  const d = e.data;
  const priv = e.visibleTo !== 'all';
  const sys = (text: string, cls = '') => h('div', { class: `sys ${cls} ${priv ? 'private' : ''}` }, priv ? h('span', { class: 'lock' }, s.private) : null, h('span', { class: 'tx' }, text));
  switch (d.type) {
    case 'game_start':
      return sys(s.intro(d.players.length, d.setup.drowned + d.setup.siren), 'intro');
    case 'role_assigned':
      if (d.player !== v.you) return null;
      return sys(s.youAre(roleName(d.role)) + (d.partners.length ? s.fellow(names(d.partners)) : ''), 'you');
    case 'phase':
      if (d.phase === 'ended') return null;
      return h(
        'div',
        { class: `divider ${d.phase}` },
        h('span', {}, d.phase === 'night' ? s.night(d.round) : d.phase === 'day_discussion' ? s.day(d.round) : d.phase === 'day_vote' ? s.theVote : s.lastWordsDivider),
      );
    case 'undertow_proposal':
      return sys(s.proposal(name(d.player), d.target ? name(d.target) : null, d.note), 'undertow');
    case 'scan_result':
      return sys(s.scanResult(name(d.player), name(d.target), faction(d.result)), 'intel');
    case 'protect_result':
      return sys(s.protectResult(name(d.player), name(d.target), !!d.saved), 'intel');
    case 'read_result':
      return sys(s.readResult(name(d.player), name(d.target), roleName(d.role)), 'intel');
    case 'clue':
      return sys(s.clue(name(d.player), names(d.suspects)), 'intel');
    case 'dragged':
      return sys(s.dragged(name(d.player)), 'death');
    case 'quiet_night':
      return e.round > 1 ? sys(s.quiet, 'calm') : sys(s.firstNight, 'calm');
    case 'speech':
    case 'last_words': {
      const p = v.players.find((x) => x.id === d.player);
      return h(
        'div',
        { class: `speech ${d.type === 'last_words' ? 'last' : ''} ${p?.human ? 'mine' : ''}` },
        h('div', { class: 'speaker' }, h('span', { class: 'seat' }, p ? seatNo(p.seat) : '··'), h('span', { class: 'sn' }, p?.name ?? d.player)),
        h(
          'div',
          { class: 'body' },
          d.type === 'last_words' ? h('div', { class: 'tag' }, s.lastWordsTag) : null,
          h('p', { class: 'text' }, d.speech.text || '…'),
          d.speech.claims.length ? h('div', { class: 'chips' }, d.speech.claims.map((c) => claimChip(c))) : null,
        ),
      );
    }
    case 'votes': {
      const target = (t: string) => (t === 'skip' ? s.skip : name(t));
      const tally = Object.entries(d.tally).sort((a, b) => b[1] - a[1]);
      return h(
        'div',
        { class: 'votes' },
        h('div', { class: 'tally' }, tally.map(([t, n]) => h('span', { class: 't' }, h('b', {}, String(n)), ' ', target(t)))),
        h('div', { class: 'rows' }, Object.entries(d.votes).map(([who, t]) => h('span', { class: 'vote' }, `${name(who)} → ${target(t)}`))),
      );
    }
    case 'airlocked':
      return sys(s.airlockedEv(name(d.player), d.faction ? faction(d.faction) : null), 'death');
    case 'no_airlock':
      return sys(d.reason === 'tie' ? s.tie : s.held, 'warn');
    case 'hull':
      return sys(s.hullEv(d.hull, v.maxHull), 'warn');
    case 'game_end':
      return h('div', { class: `end ${d.winner}` }, h('div', { class: 'big' }, d.winner === 'crew' ? s.crewWins : s.undertowWins), h('p', {}, s.reasons[d.reason]));
  }
  return null;
}

function renderLog() {
  const v = view!;
  const log = $('log');
  if (v.events.length < renderedEvents) {
    log.replaceChildren();
    renderedEvents = 0;
  }
  watchLog(log);
  for (const e of v.events.slice(renderedEvents)) {
    const node = eventNode(e);
    if (node) log.append(node);
  }
  renderedEvents = v.events.length;
  if (logPinned) log.scrollTop = log.scrollHeight;
}

// The log follows new lines while the reader is at the bottom. It also stays
// pinned when the action panel below grows (e.g. the speech composer opens).
let logPinned = true;
let logWatched = false;
function watchLog(log: HTMLElement) {
  if (logWatched) return;
  logWatched = true;
  log.addEventListener('scroll', () => {
    logPinned = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  });
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (logPinned) log.scrollTop = log.scrollHeight;
    }).observe(log);
  }
}

function renderSide() {
  const v = view!;
  const s = S();
  const side = $('side');
  if (v.insights && Object.keys(v.insights).length) {
    const ids = Object.keys(v.insights);
    if (!mind || !v.insights[mind]) mind = ids[0];
    const ins = v.insights[mind];
    const role = v.roles?.[mind];
    const bars = v.players
      .filter((p) => p.id !== mind)
      .map((p) => {
        const b = ins.beliefs[p.id] ?? 0;
        const truth = v.roles ? ROLES[v.roles[p.id]].faction : null;
        return h(
          'div',
          { class: `brow ${p.alive ? '' : 'dead'}` },
          h('span', { class: 'bn' }, p.name),
          h('span', { class: 'bbar' }, h('span', { class: `fill ${truth ?? ''}`, style: `width:${(b * 100).toFixed(0)}%` })),
          h('span', { class: 'bv' }, `${(b * 100).toFixed(0)}`),
        );
      });
    const traces = (v.traces ?? []).filter((t) => t.player === mind).slice(-3).reverse();
    const parts: Child[] = [
      h('h3', {}, s.minds),
      h('p', { class: 'hint' }, s.mindsHint),
      h('div', { class: `mindhead ${role ? ROLES[role].faction : ''}` }, h('strong', {}, name(mind)), role ? h('span', { class: `badge role ${ROLES[role].faction}` }, roleName(role)) : null),
      h('div', { class: 'beliefs' }, bars),
      ins.thought ? h('div', { class: 'thought' }, h('span', { class: 'label' }, s.latestThought), h('p', {}, ins.thought)) : null,
      ins.notes?.length ? h('div', { class: 'notes' }, h('span', { class: 'label' }, s.privateNotes), h('ul', {}, ins.notes.slice(-5).map((n) => h('li', {}, n)))) : null,
      traces.length
        ? h(
            'div',
            { class: 'traces' },
            h('span', { class: 'label' }, s.trace),
            traces.map((t) =>
              h(
                'details',
                {},
                h('summary', {}, s.traceSummary(t.round, t.kind, t.fallback)),
                t.steps.map((st) =>
                  h(
                    'div',
                    { class: 'step' },
                    h('code', {}, st.tool || s.invalid),
                    st.thought ? ` ${st.thought}` : '',
                    st.error ? h('div', { class: 'err' }, st.error) : null,
                    st.observation ? h('div', { class: 'obs' }, st.observation.slice(0, 280)) : null,
                  ),
                ),
              ),
            ),
          )
        : null,
    ];
    side.replaceChildren(...parts.filter((x): x is Node | string => !!x));
    return;
  }
  if (!v.yourRole) {
    side.replaceChildren();
    return;
  }
  const r = ROLES[v.yourRole];
  const intel = v.events.filter((e) => e.visibleTo !== 'all' && ['scan_result', 'protect_result', 'read_result', 'clue', 'undertow_proposal'].includes(e.data.type));
  side.replaceChildren(
    h(
      'div',
      { class: `rolecard ${r.faction}` },
      h('div', { class: 'rk' }, `${s.yourRole} · ${faction(r.faction)}`),
      h('div', { class: 'rn' }, roleName(v.yourRole)),
      h('p', {}, roleBlurb(v.yourRole, uiLang())),
      v.partners.length ? h('p', { class: 'partners' }, s.fellowList(names(v.partners))) : null,
    ),
    h('h3', {}, s.yourIntel),
    intel.length ? h('div', { class: 'intel' }, intel.map((e) => eventNode(e))) : h('p', { class: 'hint' }, s.nothingYet),
    h('h3', {}, s.onBoard),
    h(
      'ul',
      { class: 'setup-list' },
      Object.entries(v.setup)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => h('li', { class: ROLES[k as RoleId].faction }, h('b', {}, String(n)), ' ', roleName(k as RoleId))),
    ),
    h('details', { class: 'rules' }, h('summary', {}, s.howTo), s.rules.map((p) => h('p', {}, p))),
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function send(action: Action) {
  if (!client || sending) return;
  sending = true;
  try {
    const res = await client.act(action);
    if (!res.ok) $('action-error').textContent = res.error ?? S().actionRejected;
    else {
      draftClaims = [];
      removedAuto = new Set();
    }
  } finally {
    sending = false;
  }
}

function renderActions() {
  const v = view!;
  const s = S();
  const panel = $('actions');
  const pending = v.pending;
  const key = pending ? `${pending.kind}:${pending.round}:${v.events.length}` : `none:${v.thinking.join(',')}:${v.phase}`;
  // Don't wipe a half-typed speech on every update.
  if (pending && (pending.kind === 'speak' || pending.kind === 'last_words') && lastPendingKey.startsWith(`${pending.kind}:${pending.round}`) && panel.querySelector('textarea')) {
    return;
  }
  if (client instanceof ReplayClient) {
    lastPendingKey = key;
    if (!panel.querySelector('.replay')) panel.replaceChildren(replayControls(client));
    updateReplayControls(client);
    return;
  }
  if (v.phase === 'ended') {
    if (lastPendingKey === key) return;
    lastPendingKey = key;
    const note = h('span', { class: 'hint' });
    panel.replaceChildren(
      h(
        'div',
        { class: 'waiting' },
        h('button', { class: 'primary', onclick: () => location.reload() }, s.newGame),
        recorder?.ready ? h('button', { onclick: () => saveReplay(note) }, s.saveReplay) : null,
        recorder?.ready ? h('button', { class: 'ghost', onclick: () => void copyReplay(note) }, s.copyReplay) : null,
        note,
      ),
    );
    return;
  }
  lastPendingKey = key;
  if (!pending) {
    const who = v.thinking.map(name);
    panel.replaceChildren(
      h('div', { class: 'waiting' }, h('span', { class: 'status' }, who.length ? s.thinking(who.join(s.listSep), who.length) : v.you ? s.waiting : s.watching), paceControl()),
    );
    return;
  }
  const err = h('div', { id: 'action-error', class: 'err' });
  const opts = (pending.options ?? []).filter((o) => o !== 'skip') as PlayerId[];
  switch (pending.kind) {
    case 'night': {
      const verb = s.verbs[pending.nightAction ?? 'scan'];
      panel.replaceChildren(
        h('div', { class: 'prompt' }, verb),
        h(
          'div',
          { class: 'targets' },
          opts.map((id) => h('button', { onclick: () => void send({ kind: 'night', target: id }) }, name(id))),
          pending.allowNone ? h('button', { class: 'ghost', onclick: () => void send({ kind: 'night', target: null }) }, s.nobody) : null,
        ),
        err,
      );
      return;
    }
    case 'vote':
      panel.replaceChildren(
        h('div', { class: 'prompt' }, s.voteToAirlock),
        h(
          'div',
          { class: 'targets' },
          opts.map((id) => h('button', { class: 'danger', onclick: () => void send({ kind: 'vote', target: id }) }, name(id))),
          h('button', { class: 'ghost', onclick: () => void send({ kind: 'vote', target: 'skip' }) }, s.skip),
        ),
        err,
      );
      return;
    case 'speak':
    case 'last_words':
      panel.replaceChildren(speechComposer(pending.kind, opts.length ? opts : v.players.filter((p) => p.alive && p.id !== v.you).map((p) => p.id)), err);
      return;
  }
}

function speechComposer(kind: 'speak' | 'last_words', targets: PlayerId[]): HTMLElement {
  const v = view!;
  const s = S();
  const area = h('textarea', { placeholder: kind === 'speak' ? s.speakPh : s.lastPh, rows: 3, 'aria-label': kind === 'speak' ? s.yourTurn : s.goingOut }) as HTMLTextAreaElement;
  const chips = h('div', { class: 'chips' });
  const auto = () => extractClaims(area.value, v.players, v.you, v.round).filter((c) => !removedAuto.has(JSON.stringify(c)));
  const all = () => {
    const seen = new Set<string>();
    return [...auto(), ...draftClaims].filter((c) => {
      const k = JSON.stringify(c);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const refresh = () => {
    chips.replaceChildren(
      ...all().map((c) =>
        claimChip(c, () => {
          const k = JSON.stringify(c);
          draftClaims = draftClaims.filter((d) => JSON.stringify(d) !== k);
          removedAuto.add(k);
          refresh();
        }),
      ),
    );
  };
  area.addEventListener('input', refresh);

  const type = h(
    'select',
    { 'aria-label': s.addClaim },
    ...['accuse', 'vouch', 'intend_vote', 'role', 'scan', 'clue', 'protect', 'read'].map((t) => h('option', { value: t }, s.claimTypes[t])),
  ) as HTMLSelectElement;
  const target = h('select', {}, ...targets.map((id) => h('option', { value: id }, name(id))), h('option', { value: 'skip' }, s.skip)) as HTMLSelectElement;
  const extra = h('select', {}) as HTMLSelectElement;
  const target2 = h('select', {}, ...targets.map((id) => h('option', { value: id }, name(id)))) as HTMLSelectElement;
  const target3 = h('select', {}, ...targets.map((id) => h('option', { value: id }, name(id)))) as HTMLSelectElement;
  const syncExtra = () => {
    const t = type.value;
    const roles = Object.keys(ROLES) as RoleId[];
    const options: [string, string][] =
      t === 'scan' ? (['crew', 'undertow'] as Faction[]).map((f) => [f, faction(f)]) : t === 'role' || t === 'read' ? roles.map((r) => [r, roleName(r)]) : [];
    extra.replaceChildren(...options.map(([value, label]) => h('option', { value }, label)));
    extra.hidden = !(t === 'scan' || t === 'role' || t === 'read');
    target.hidden = t === 'role';
    target2.hidden = target3.hidden = t !== 'clue';
  };
  type.addEventListener('change', syncExtra);
  syncExtra();
  const add = () => {
    const t = type.value;
    const round = Math.max(1, v.round);
    let c: Claim | null = null;
    if (t === 'role') c = { type: 'role', role: extra.value as RoleId };
    else if (t === 'intend_vote') c = { type: 'intend_vote', target: target.value };
    else if (target.value === 'skip') c = null;
    else if (t === 'accuse' || t === 'vouch') c = { type: t, target: target.value };
    else if (t === 'scan') c = { type: 'scan', round, target: target.value, result: extra.value as 'crew' | 'undertow' };
    else if (t === 'read') c = { type: 'read', round, target: target.value, role: extra.value as RoleId };
    else if (t === 'protect') c = { type: 'protect', round, target: target.value };
    else if (t === 'clue') c = { type: 'clue', round, suspects: [...new Set([target.value, target2.value, target3.value])] };
    if (c) {
      draftClaims.push(c);
      refresh();
    }
  };
  const submit = () => {
    const text = area.value.trim();
    const claims = all();
    if (!text && !claims.length) return;
    const speech = { text: text || '…', claims };
    void send(kind === 'speak' ? { kind: 'speak', speech } : { kind: 'last_words', speech });
  };
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  setTimeout(() => area.focus(), 0);
  return h(
    'div',
    { class: 'composer' },
    h('div', { class: 'prompt' }, kind === 'speak' ? s.yourTurn : s.goingOut),
    area,
    chips,
    h('div', { class: 'builder' }, h('span', { class: 'label' }, s.addClaim), type, target, target2, target3, extra, h('button', { class: 'ghost', type: 'button', onclick: add }, s.add)),
    h('div', { class: 'row' }, h('span', { class: 'hint' }, s.enterHint), h('button', { class: 'primary', onclick: submit }, kind === 'speak' ? s.speak : s.sayIt)),
  );
}

function replayJson(): string {
  return JSON.stringify(recorder!.build());
}

function saveReplay(note: HTMLElement) {
  const blob = new Blob([replayJson()], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `undertow-replay-${Date.now()}.json` }) as HTMLAnchorElement;
  document.body.append(a);
  a.click();
  a.remove();
  note.textContent = S().saved;
}

async function copyReplay(note: HTMLElement) {
  const text = replayJson();
  try {
    await navigator.clipboard.writeText(text);
    note.textContent = S().copied;
  } catch {
    const area = h('textarea', { class: 'replay-dump', readonly: true }) as HTMLTextAreaElement;
    area.value = text;
    note.replaceChildren(S().copyThis, area);
    area.select();
  }
}

function replayControls(rc: ReplayClient): HTMLElement {
  const s = S();
  const slider = h('input', { type: 'range', min: '0', max: String(rc.length - 1), value: String(rc.index), 'aria-label': s.replayPos, class: 'scrub' }) as HTMLInputElement;
  slider.addEventListener('input', () => rc.seek(Number(slider.value)));
  const btn = (label: string, title: string, fn: () => void, cls = '') => h('button', { class: cls, title, 'aria-label': title, onclick: fn }, label);
  const toggle = () => {
    if (rc.playing) rc.pause();
    else rc.play();
    updateReplayControls(rc);
  };
  return h(
    'div',
    { class: 'replay' },
    h(
      'div',
      { class: 'row' },
      btn('«', s.prevPhase, () => rc.seekPhase(-1)),
      btn('‹', s.stepBack, () => rc.seek(rc.index - 1)),
      h('button', { class: 'primary play', title: s.play, 'aria-label': s.play, onclick: toggle }, s.play),
      btn('›', s.stepFwd, () => rc.seek(rc.index + 1)),
      btn('»', s.nextPhase, () => rc.seekPhase(1)),
      h('span', { class: 'hint pos' }),
      h('button', { class: 'ghost', onclick: () => location.reload() }, s.leaveReplay),
    ),
    slider,
    paceControl(),
  );
}

function updateReplayControls(rc: ReplayClient) {
  const panel = $('actions');
  const slider = panel.querySelector('.scrub') as HTMLInputElement | null;
  if (slider && document.activeElement !== slider) slider.value = String(rc.index);
  const pos = panel.querySelector('.pos');
  if (pos) pos.textContent = `${rc.index + 1} / ${rc.length}`;
  const play = panel.querySelector('.play') as HTMLButtonElement | null;
  if (play) {
    play.textContent = rc.playing ? S().pause : S().play;
    play.title = play.textContent;
    play.setAttribute('aria-label', play.title);
  }
}

function paceControl(): HTMLElement {
  const input = h('input', { type: 'range', min: '0', max: '3000', step: '100', value: ($('pace-live') as HTMLInputElement).value }) as HTMLInputElement;
  input.addEventListener('change', () => {
    ($('pace-live') as HTMLInputElement).value = input.value;
    client?.setPace(Number(input.value));
  });
  return h('label', { class: 'pace' }, S().paceShort, input);
}

void initSetup();
