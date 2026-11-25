import { ROLES } from '../engine/roles.js';
import type { Action, Claim, GameEvent, PlayerId, RoleId } from '../engine/types.js';
import type { AgentKind } from '../agents/factory.js';
import { extractClaims } from './claimParser.js';
import { LocalClient, RemoteClient, serverKinds, type GameClient, type NewGameOptions, type View } from './client.js';

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

const KIND_LABEL: Record<AgentKind, string> = {
  heuristic: 'Heuristic agents (offline)',
  'mock-llm': 'Mock LLM agents (offline, full ReAct pipeline)',
  anthropic: 'Claude agents (server)',
  openai: 'OpenAI-compatible agents (server)',
};

// ---------------------------------------------------------------------------
// Setup screen
// ---------------------------------------------------------------------------

async function initSetup() {
  kinds = await serverKinds();
  const select = $('agent') as HTMLSelectElement;
  const available: AgentKind[] = kinds ?? ['heuristic', 'mock-llm'];
  select.replaceChildren(...available.map((k) => h('option', { value: k }, KIND_LABEL[k])));
  $('server-note').textContent = kinds
    ? `Connected to the Undertow server.${kinds.includes('anthropic') || kinds.includes('openai') ? ' LLM agents available.' : ' Set an API key on the server for LLM agents.'}`
    : 'Running fully in your browser. Start the Node server for Claude or OpenAI-compatible agents.';
  ($('seed') as HTMLInputElement).value = String(Math.floor(Math.random() * 100000));
  $('start').addEventListener('click', () => void startGame());
}

async function startGame() {
  const opts: NewGameOptions = {
    players: Number(($('players') as HTMLSelectElement).value),
    seed: Number(($('seed') as HTMLInputElement).value) || 1,
    mode: (document.querySelector('input[name=mode]:checked') as HTMLInputElement).value as 'play' | 'watch',
    name: ($('name') as HTMLInputElement).value.trim() || 'You',
    agent: ($('agent') as HTMLSelectElement).value as AgentKind,
    paceMs: Number(($('pace') as HTMLInputElement).value),
  };
  try {
    client = kinds ? await RemoteClient.create(opts) : new LocalClient(opts);
  } catch (err) {
    $('server-note').textContent = `Could not start: ${(err as Error).message}`;
    return;
  }
  renderedEvents = 0;
  draftClaims = [];
  mind = null;
  $('log').replaceChildren();
  $('setup').hidden = true;
  $('game').hidden = false;
  ($('pace-live') as HTMLInputElement).value = String(opts.paceMs);
  client.subscribe((v) => {
    view = v;
    render();
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function name(id: PlayerId): string {
  return view?.players.find((p) => p.id === id)?.name ?? id;
}

function roleName(r: RoleId) {
  return ROLES[r].name;
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
  const phase =
    v.phase === 'ended' ? 'Game over' : v.phase === 'night' ? `Night ${v.round}` : v.phase === 'day_discussion' ? `Day ${v.round} · discussion` : v.phase === 'day_vote' ? `Day ${v.round} · vote` : `Day ${v.round} · last words`;
  $('phase').textContent = phase;
  document.body.dataset.phase = v.phase;
  const pips = [];
  for (let i = 0; i < v.maxHull; i++) pips.push(h('span', { class: `pip ${i < v.hull ? 'ok' : 'lost'}`, title: 'hull integrity' }));
  $('hull').replaceChildren(h('span', { class: 'label' }, 'Hull'), ...pips);
  const usage = v.usage && v.usage.calls ? ` · ${v.usage.calls} model calls, ${(v.usage.inputTokens / 1000).toFixed(1)}k in / ${(v.usage.outputTokens / 1000).toFixed(1)}k out` : '';
  $('meta').textContent = `${v.agentKind}${usage}`;
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
  const cards = v.players.map((p) => {
    const role = v.roles?.[p.id];
    const partner = v.partners.includes(p.id);
    const thinking = v.thinking.includes(p.id);
    const sus = consensus.get(p.id);
    return h(
      'div',
      {
        class: `card ${p.alive ? '' : 'dead'} ${p.human ? 'you' : ''} ${partner ? 'partner' : ''} ${role ? ROLES[role].faction : ''} ${mind === p.id ? 'selected' : ''}`,
        onclick: () => {
          if (v.insights) {
            mind = p.id;
            render();
          }
        },
      },
      h('div', { class: 'avatar' }, p.name.split(' ').map((s) => s[0]).join('').slice(0, 2)),
      h(
        'div',
        { class: 'who' },
        h('div', { class: 'nm' }, p.name, p.human ? h('span', { class: 'tag' }, 'you') : null, partner ? h('span', { class: 'tag undertow' }, 'partner') : null),
        h('div', { class: 'job' }, p.human ? 'that\'s you' : p.job, thinking ? h('span', { class: 'dots' }, ' ···') : null),
        h(
          'div',
          { class: 'badges' },
          role ? h('span', { class: `badge role ${ROLES[role].faction}` }, roleName(role)) : null,
          claims.get(p.id) ? h('span', { class: 'badge claim' }, `claims ${roleName(claims.get(p.id)!)}`) : null,
          !p.alive ? h('span', { class: 'badge fate' }, p.fate === 'dragged' ? 'dragged under' : 'airlocked') : null,
          todaysVotes.get(p.id) && p.alive && v.phase !== 'night' ? h('span', { class: 'badge votes' }, `${todaysVotes.get(p.id)} vote intents`) : null,
        ),
        sus !== undefined && p.alive ? h('div', { class: 'susbar', title: `crew agents' average suspicion: ${(sus * 100).toFixed(0)}%` }, h('div', { style: `width:${(sus * 100).toFixed(0)}%` })) : null,
      ),
    );
  });
  $('roster').replaceChildren(...cards);
}

function claimChip(c: Claim, onRemove?: () => void): HTMLElement {
  let text = '';
  switch (c.type) {
    case 'role':
      text = `role: ${roleName(c.role)}`;
      break;
    case 'scan':
      text = `ping n${c.round}: ${name(c.target)} = ${c.result}`;
      break;
    case 'protect':
      text = `sealed ${name(c.target)} n${c.round}`;
      break;
    case 'read':
      text = `file n${c.round}: ${name(c.target)} = ${roleName(c.role)}`;
      break;
    case 'clue':
      text = `clue n${c.round}: ${c.suspects.map(name).join(' / ')}`;
      break;
    case 'accuse':
      text = `accuses ${name(c.target)}`;
      break;
    case 'vouch':
      text = `vouches ${name(c.target)}`;
      break;
    case 'intend_vote':
      text = `votes ${c.target === 'skip' ? 'skip' : name(c.target)}`;
      break;
  }
  const hostile = c.type === 'accuse' || (c.type === 'scan' && c.result === 'undertow') || c.type === 'intend_vote';
  return h('span', { class: `chip ${c.type} ${hostile ? 'hostile' : ''}` }, text, onRemove ? h('button', { class: 'x', onclick: onRemove, title: 'remove' }, '×') : null);
}

function eventNode(e: GameEvent): HTMLElement | null {
  const v = view!;
  const d = e.data;
  const priv = e.visibleTo !== 'all';
  const sys = (text: string, cls = '') => h('div', { class: `sys ${cls} ${priv ? 'private' : ''}` }, priv ? h('span', { class: 'lock' }, 'private') : null, text);
  switch (d.type) {
    case 'game_start':
      return sys(`Meridian-9, 4,000 metres down. ${d.players.length} aboard. Somewhere among them: ${d.setup.drowned + d.setup.siren} Undertow.`, 'intro');
    case 'role_assigned':
      if (d.player !== v.you) return null;
      return sys(`You are the ${roleName(d.role)}.${d.partners.length ? ` Your fellow Undertow: ${d.partners.map(name).join(', ')}.` : ''}`, 'you');
    case 'phase':
      if (d.phase === 'ended') return null;
      return h('div', { class: `divider ${d.phase}` }, d.phase === 'night' ? `Night ${d.round}` : d.phase === 'day_discussion' ? `Day ${d.round}` : d.phase === 'day_vote' ? 'The vote' : 'Last words');
    case 'undertow_proposal':
      return sys(`${name(d.player)} wants to drag ${d.target ? name(d.target) : 'nobody'} under${d.note ? `: "${d.note}"` : '.'}`, 'undertow');
    case 'scan_result':
      return sys(`${name(d.player)} pinged ${name(d.target)}: the echo reads ${d.result.toUpperCase()}.`, 'intel');
    case 'protect_result':
      return sys(`${name(d.player)} sealed ${name(d.target)} in the med bay.${d.saved ? ' It saved them.' : ''}`, 'intel');
    case 'read_result':
      return sys(`${name(d.player)} read ${name(d.target)}'s file: ${roleName(d.role)}.`, 'intel');
    case 'clue':
      return sys(`Station log for ${name(d.player)}: at least one of ${d.suspects.map(name).join(', ')} is Undertow.`, 'intel');
    case 'dragged':
      return sys(`${name(d.player)} was dragged under in the night.`, 'death');
    case 'quiet_night':
      return e.round > 1 ? sys('Nobody was taken last night.', 'calm') : sys('The first night is calm. Everyone wakes.', 'calm');
    case 'speech':
    case 'last_words': {
      const p = v.players.find((x) => x.id === d.player);
      return h(
        'div',
        { class: `speech ${d.type === 'last_words' ? 'last' : ''} ${p?.human ? 'mine' : ''}` },
        h('div', { class: 'avatar small' }, (p?.name ?? '?').split(' ').map((s) => s[0]).join('').slice(0, 2)),
        h(
          'div',
          { class: 'bubble' },
          h('div', { class: 'speaker' }, p?.name ?? d.player, d.type === 'last_words' ? h('span', { class: 'tag' }, 'last words') : null),
          h('div', { class: 'text' }, d.speech.text || '…'),
          d.speech.claims.length ? h('div', { class: 'chips' }, d.speech.claims.map((c) => claimChip(c))) : null,
        ),
      );
    }
    case 'votes': {
      const rows = Object.entries(d.votes).map(([who, t]) => h('span', { class: 'vote' }, `${name(who)} → ${t === 'skip' ? 'skip' : name(t)}`));
      return h('div', { class: 'votes' }, h('div', { class: 'tally' }, Object.entries(d.tally).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t === 'skip' ? 'skip' : name(t)} ${n}`).join(' · ')), h('div', { class: 'rows' }, rows));
    }
    case 'airlocked':
      return sys(`${name(d.player)} is pushed into the airlock.${d.faction ? ` They were ${d.faction}.` : ''}`, 'death');
    case 'no_airlock':
      return sys(d.reason === 'tie' ? 'The vote is tied. Nobody goes into the airlock.' : 'The crew holds its vote.', 'warn');
    case 'hull':
      return sys(`The hull groans. Integrity ${d.hull}/${v.maxHull}.`, 'warn');
    case 'game_end': {
      const reasons: Record<string, string> = {
        all_undertow_gone: 'Every Undertow has been airlocked.',
        undertow_parity: 'The Undertow now match the crew. The station is theirs.',
        hull_breach: 'The hull gives way. The sea comes in.',
        round_limit: 'The rescue never comes.',
      };
      return h('div', { class: `end ${d.winner}` }, h('div', { class: 'big' }, d.winner === 'crew' ? 'The crew survives' : 'The Undertow win'), h('div', {}, reasons[d.reason]));
    }
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
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  for (const e of v.events.slice(renderedEvents)) {
    const node = eventNode(e);
    if (node) log.append(node);
  }
  renderedEvents = v.events.length;
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function renderSide() {
  const v = view!;
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
          h('span', { class: 'bv' }, `${(b * 100).toFixed(0)}%`),
        );
      });
    const traces = (v.traces ?? []).filter((t) => t.player === mind).slice(-3).reverse();
    const parts: Child[] = [
      h('h3', {}, 'Agent minds'),
      h('p', { class: 'hint' }, 'Click a crew card to look inside that agent. Bars: how likely it thinks each player is Undertow (colour shows the truth).'),
      h('div', { class: 'mindhead' }, h('strong', {}, name(mind)), role ? h('span', { class: `badge role ${ROLES[role].faction}` }, roleName(role)) : null),
      h('div', { class: 'beliefs' }, bars),
      ins.thought ? h('div', { class: 'thought' }, h('span', { class: 'label' }, 'latest thought'), ins.thought) : null,
      ins.notes?.length ? h('div', { class: 'notes' }, h('span', { class: 'label' }, 'private notes'), h('ul', {}, ins.notes.slice(-5).map((n) => h('li', {}, n)))) : null,
      traces.length
        ? h(
            'div',
            { class: 'traces' },
            h('span', { class: 'label' }, 'ReAct trace'),
            traces.map((t) =>
              h(
                'details',
                {},
                h('summary', {}, `day ${t.round} · ${t.kind}${t.fallback ? ' · fell back to heuristic' : ''}`),
                t.steps.map((s) => h('div', { class: 'step' }, h('code', {}, s.tool || 'invalid'), s.thought ? ` ${s.thought}` : '', s.error ? h('div', { class: 'err' }, s.error) : null, s.observation ? h('div', { class: 'obs' }, s.observation.slice(0, 280)) : null)),
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
    h('div', { class: `rolecard ${r.faction}` }, h('div', { class: 'rk' }, 'your role'), h('div', { class: 'rn' }, r.name), h('p', {}, r.blurb), v.partners.length ? h('p', { class: 'partners' }, `Fellow Undertow: ${v.partners.map(name).join(', ')}`) : null),
    h('h3', {}, 'Your intel'),
    intel.length ? h('div', { class: 'intel' }, intel.map((e) => eventNode(e))) : h('p', { class: 'hint' }, 'Nothing yet.'),
    h('h3', {}, 'On board'),
    h('p', { class: 'hint' }, Object.entries(v.setup).filter(([, n]) => n > 0).map(([k, n]) => `${n}× ${roleName(k as RoleId)}`).join(' · ')),
    h(
      'details',
      { class: 'rules' },
      h('summary', {}, 'How to play'),
      h('p', {}, 'Each night the Undertow drag one crew member under (not the first night). Each day everyone speaks, then votes to airlock one person or skip. Strict plurality and more votes than skip are needed.'),
      h('p', {}, 'A day without an airlocking costs one hull point; at zero the station floods and the Undertow win. Crew win when every Undertow is gone; the Undertow win at parity.'),
      h('p', {}, 'Nobody learns who the lost really were, except the Archivist. Attach claims to your speech so the agents can track what you assert. Lying is allowed.'),
    ),
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
    if (!res.ok) $('action-error').textContent = res.error ?? 'action rejected';
    else {
      draftClaims = [];
      removedAuto = new Set();
    }
  } finally {
    sending = false;
  }
}

let lastPendingKey = '';

function renderActions() {
  const v = view!;
  const panel = $('actions');
  const pending = v.pending;
  const key = pending ? `${pending.kind}:${pending.round}:${v.events.length}` : `none:${v.thinking.join(',')}:${v.phase}`;
  // Don't wipe a half-typed speech on every update.
  if (pending && (pending.kind === 'speak' || pending.kind === 'last_words') && lastPendingKey.startsWith(`${pending.kind}:${pending.round}`) && panel.querySelector('textarea')) {
    return;
  }
  lastPendingKey = key;
  if (v.phase === 'ended') {
    panel.replaceChildren(h('div', { class: 'waiting' }, h('button', { class: 'primary', onclick: () => location.reload() }, 'New game')));
    return;
  }
  if (!pending) {
    const who = v.thinking.map(name);
    panel.replaceChildren(
      h('div', { class: 'waiting' }, who.length ? `${who.join(', ')} ${who.length > 1 ? 'are' : 'is'} thinking…` : v.you ? 'Waiting…' : 'Watching the crew.'),
      paceControl(),
    );
    return;
  }
  const err = h('div', { id: 'action-error', class: 'err' });
  const opts = (pending.options ?? []).filter((o) => o !== 'skip') as PlayerId[];
  switch (pending.kind) {
    case 'night': {
      const verb = { drag: 'Drag under', scan: 'Ping with sonar', protect: 'Seal in the med bay', read: 'Read the file of' }[pending.nightAction ?? 'scan'];
      panel.replaceChildren(
        h('div', { class: 'prompt' }, `${verb}:`),
        h('div', { class: 'targets' }, opts.map((id) => h('button', { onclick: () => void send({ kind: 'night', target: id }) }, name(id))), pending.allowNone ? h('button', { class: 'ghost', onclick: () => void send({ kind: 'night', target: null }) }, 'Nobody') : null),
        err,
      );
      return;
    }
    case 'vote':
      panel.replaceChildren(
        h('div', { class: 'prompt' }, 'Vote to airlock:'),
        h('div', { class: 'targets' }, opts.map((id) => h('button', { class: 'danger', onclick: () => void send({ kind: 'vote', target: id }) }, name(id))), h('button', { class: 'ghost', onclick: () => void send({ kind: 'vote', target: 'skip' }) }, 'Skip')),
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
  const area = h('textarea', { placeholder: kind === 'speak' ? 'Say something to the crew… (e.g. "I pinged Bram last night, he is clean. I\'m voting Mara.")' : 'Your last words…', rows: 3 }) as HTMLTextAreaElement;
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

  const type = h('select', {}, ...['accuse', 'vouch', 'intend_vote', 'role', 'scan', 'clue', 'protect', 'read'].map((t) => h('option', { value: t }, t.replace('_', ' ')))) as HTMLSelectElement;
  const target = h('select', {}, ...targets.map((id) => h('option', { value: id }, name(id))), h('option', { value: 'skip' }, 'skip')) as HTMLSelectElement;
  const extra = h('select', {}) as HTMLSelectElement;
  const target2 = h('select', {}, ...targets.map((id) => h('option', { value: id }, name(id)))) as HTMLSelectElement;
  const target3 = h('select', {}, ...targets.map((id) => h('option', { value: id }, name(id)))) as HTMLSelectElement;
  const syncExtra = () => {
    const t = type.value;
    const roles = Object.keys(ROLES) as RoleId[];
    extra.replaceChildren(...(t === 'scan' ? ['crew', 'undertow'] : t === 'role' || t === 'read' ? roles : []).map((o) => h('option', { value: o }, o)));
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  setTimeout(() => area.focus(), 0);
  return h(
    'div',
    { class: 'composer' },
    h('div', { class: 'prompt' }, kind === 'speak' ? 'Your turn to speak.' : 'You are going into the airlock. Last words:'),
    area,
    chips,
    h('div', { class: 'builder' }, h('span', { class: 'label' }, 'add claim'), type, target, target2, target3, extra, h('button', { class: 'ghost', onclick: add }, '+')),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: submit }, kind === 'speak' ? 'Speak' : 'Say it')),
  );
}

function paceControl(): HTMLElement {
  const input = h('input', { type: 'range', min: '0', max: '3000', step: '100', value: ($('pace-live') as HTMLInputElement).value }) as HTMLInputElement;
  input.addEventListener('change', () => {
    ($('pace-live') as HTMLInputElement).value = input.value;
    client?.setPace(Number(input.value));
  });
  return h('label', { class: 'pace' }, 'pace', input);
}

void initSetup();
