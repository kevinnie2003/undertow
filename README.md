# Undertow

An original social deduction game for the browser. You and a handful of AI crewmates are stationed on Meridian-9, a research station 4,000 metres down. Something came up from the trench, and some of the crew are not themselves any more. Everyone talks, bluffs, deduces and votes. The AI players have their own hidden roles. Each one keeps a private memory, tracks a probability for every other player being an infiltrator, and lies when that serves its side.

You can play a seat yourself, or watch an all-AI game with a view inside each agent's head: its belief bars, its latest private thought, its notes and its full tool-call trace.

```
npm install
npm run dev          # http://localhost:8787
```

Everything runs offline by default. Without an API key, the AI seats use deterministic heuristic agents, or a mock model that drives the full LLM pipeline. Set `ANTHROPIC_API_KEY` (or an OpenAI-compatible endpoint) to seat real language models.

---

## Contents

- [The game](#the-game)
- [Running it](#running-it)
- [Architecture](#architecture)
- [The agents](#the-agents)
- [Simulation and balance](#simulation-and-balance)
- [Testing](#testing)
- [Design notes](#design-notes)
- [Project layout](#project-layout)
- [What's next](#whats-next)

## The game

There are two factions, the **crew** and the **Undertow**.

| Role | Faction | Night action |
|---|---|---|
| Diver | crew | None. Some nights the station log gives one diver a **clue**: three names, at least one of them Undertow. |
| Sonar Tech | crew | Pings a player and hears their echo, crew or undertow. |
| Medic | crew | Seals one player in the med bay, which saves them from the Undertow. Cannot pick the same player two nights running. |
| Archivist | crew | Reads a lost player's file and learns their true role. Nobody else ever does. |
| Drowned | Undertow | Knows the other Undertow. Together they drag one crew member under each night. |
| Siren | Undertow | Like the Drowned, but echoes as **crew** to the Sonar Tech. |

**Night.** The Undertow propose a victim in turn, and each sees the proposals made before theirs. The power roles act. The first night is calm and nobody is dragged.

**Day.** Everyone alive speaks for two rounds in a rotating order. Then all vote at once to airlock one player or skip. An airlock needs a strict plurality, and more votes than skip. The airlocked player gives last words, and their role stays secret.

**Hull.** Every day without an airlocking costs one hull point, out of 3. At zero the station floods.

**Winning.** The crew win when every Undertow is gone. The Undertow win at parity, at a hull breach, or at the round limit.

Talk is free and lying is allowed. Every speech can carry **structured claims** alongside the text:

```json
{"type":"role","role":"sonar"}
{"type":"scan","round":2,"target":"p4","result":"undertow"}
{"type":"protect","round":1,"target":"p0"}
{"type":"read","round":3,"target":"p6","role":"siren"}
{"type":"clue","round":2,"suspects":["p1","p3","p5"]}
{"type":"accuse","target":"p2"}   {"type":"vouch","target":"p7"}   {"type":"intend_vote","target":"skip"}
```

Claims are what every agent reasons over, so they can be true or false, but they must be well formed. In the web client, the claims in what you type are extracted automatically, and you can adjust them with a small claim builder before sending.

## Running it

Requires Node 20 or newer.

| Command | What it does |
|---|---|
| `npm run dev` | Builds the client and server and serves both on port 8787 (`PORT` to change). |
| `npm test` | Runs the unit and integration tests (vitest). |
| `npm run typecheck` | Runs strict TypeScript over the source and the tests. |
| `npm run sim -- --all --games 1000` | Runs agent-only games at every table size and prints statistics. |
| `npm run sim -- --players 7 --seed 3 --transcript` | Prints one full game, with roles and every private event. |

To pit agent kinds against each other, give each faction its own kind:

```
npm run sim -- --players 7 --games 50 --crew anthropic --undertow heuristic
npm run sim -- --players 7 --games 50 --crew heuristic --undertow openai --concurrency 8
```

The report then adds the LLM's decision count, its fallback rate, steps per decision, calls and tokens. As a rough guide, the mock model's prompts come to about 2,400 input tokens per decision, or about 90,000 per seven-player game when every seat is a model.

More simulator flags: `--roles drowned,siren,sonar,...` for a custom setup, `--hull N`, `--rounds N` (discussion rounds), `--clue 0.5` (clue chance), `--reveal` (reveal faction on airlock), `--policy skipRatio=1.5,coordination=0.5` to override agent policy, and `--json sim-results/out.json`.

The built `dist/web` folder also works as a static site without the server. In that case the whole game, agents included, runs in the browser. The build also writes `dist/undertow.html`, the same client in one self-contained file.

**Replays.** When a game ends, **Save replay** downloads it as JSON and **Copy replay** puts it on the clipboard. Open either from **Watch a replay** on the start screen to step through the game with every role, private action and (for watched games) agent mind visible: step a line at a time, jump a phase, scrub, or play it back at any pace. A replay stores each event once and a small frame per moment, so a seven-player game comes to about 100 KB.

### LLM agents

The server offers a model-backed agent kind when its environment is configured:

| Variable | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) | Enables Claude agents, together with the model id below. |
| `UNDERTOW_ANTHROPIC_MODEL` | The Claude model id to seat. Required for Claude agents. |
| `UNDERTOW_ANTHROPIC_EFFORT` | `low`, `medium` or `high` (default `low`, which keeps turns quick and cheap). |
| `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` | Any OpenAI-compatible chat completions endpoint (OpenAI, a local vLLM or Ollama server, and so on). |
| `UNDERTOW_MAX_GAMES` | How many games the server hosts at once (default 20). |

Keys stay on the server. The browser only ever talks to the game API. The header shows the call and token counts for the current game.

## Architecture

```
                 ┌──────────────────────── browser ─────────────────────────┐
                 │  web/main.ts  (vanilla DOM UI)                           │
                 │     │                                                    │
                 │  GameClient ── LocalClient: GameSession in the browser   │
                 │     │       └─ RemoteClient: fetch + EventSource         │
                 └─────┼────────────────────────────────────────────────────┘
                       │  POST /api/games · GET …/stream (SSE) · POST …/act
                 ┌─────▼──────────── server/server.ts ──────────────────────┐
                 │  GameSession  (pacing, human bridge, redacted views)     │
                 │     │                                                    │
                 │  Match  ── asks each seat's Agent, applies to the Game   │
                 │     │                                                    │
                 │  Game  (engine: deterministic state machine)             │
                 └──────────────────────────────────────────────────────────┘
   Agents:  HeuristicAgent ── Memory ── Beliefs
            LLMAgent ── ReAct loop ── LLMProvider { Anthropic | OpenAI-compatible | Mock }
                          └─ heuristic twin (estimate tool, fallback)
```

**Engine (`src/engine`).** `Game` is a pure, deterministic state machine. It has no timers, no I/O and no randomness beyond a seeded mulberry32 stream:

```
night(N) ─▶ day_discussion(N) ─▶ day_vote(N) ─▶ [last_words(N)] ─▶ night(N+1) … ─▶ ended
```

Callers ask `pendingRequests()` which decisions are open, collect them and pass them back with `submit()`. Requests returned together can be answered in any order, which keeps votes simultaneous and night actions independent. Undertow proposals are the exception and are sequential by design. Every event carries a visibility list (`'all'` or a set of player ids), and `eventsFor(player)` gives each seat exactly what it may know. A game serializes to JSON and resumes identically.

**Runner (`src/runner`).** `Match` drives a game to completion. It fans requests out concurrently, catches agent exceptions, and swaps an illegal action for a safe one so a game never stalls. `GameSession` adds what a UI needs: a `HumanAgent` bridge that resolves when the player acts, reading pace for AI turns, a "who is thinking" set, and a `ClientView` that hides roles, insights and traces unless you are spectating or the game is over. Human actions are validated before they reach the engine.

**Server (`src/server`).** A dependency-free Node `http` server. Each game gets a random id and a separate random token. The token is required for the event stream and for actions, so nobody can watch or act in someone else's game. Views stream over server-sent events. Bodies are size-capped, static paths are normalised, and games expire after two hours.

**Client (`src/web`).** Vanilla TypeScript and DOM, bundled with esbuild into one file of about 80 KB. It works against the server or fully offline in the browser.

## The agents

All agents implement one interface: `decide(observation) → Promise<Action>`. An observation is that seat's redacted event stream plus the open request.

### Memory

`Memory` turns the visible event stream into structured, append-only facts. It holds the seat's own scans, saves, reads and clues; every claim, tagged with its speaker, day, and whether it was last words; every vote; deaths and their causes; and partner proposals. Prompts and reasoning code read these facts and never re-parse raw events.

### Beliefs

`computeBeliefs` does exact Bayesian inference over every possible Undertow set. At ten players and three Undertow that is 120 hypotheses, held as bitmasks and enumerated with Gosper's hack. It takes well under a millisecond.

- **Hard constraints** remove hypotheses outright. They come from the agent's own knowledge (its own role, partners, scans, reads and clues), from facts everyone knows (dragged players were crew), and from the fact that the game has not ended.
- **Soft likelihoods** reweight the rest. Crew mostly tell the truth and the Undertow lie. Each claim type, and each vote, gets a likelihood under each hypothesis. Examples: a scan that contradicts the hypothesis is improbable unless the speaker is a liar. Two claimants to a role that exists once cannot both be genuine. Only one clue is dealt per night, so two clue claims for the same night include at least one lie. Two players who pile onto the same target with no evidence of their own look like a team. An accusation, vote intention or vote is a choice among the living players, so pushing someone who is probably crew counts against the pusher. A reported Medic save clears the saved player if the Medic is genuine.
- **Two perspectives.** A *private* posterior uses everything the seat knows. A *public* posterior uses only what everyone saw. The Undertow use the public one to model what the crew believe: whom they can frame, and when a partner is beyond saving.

If the evidence contradicts itself, for example because someone lied in a way that clashes with the agent's own clue, the model relaxes the clue constraints and reports `consistent: false`. It never crashes.

### Heuristic agents

`HeuristicAgent` turns beliefs into play through a small policy with persona dials for aggression, boldness and openness.

- **Crew** reveal information when it pays off. A sonar comes out with a hit, under a counter-claim, under pressure, or after a couple of days. A medic stays hidden unless a save or a counter-claim makes revealing worth it. Crew accuse their top suspect when it stands clearly above the average, vouch for players they know are clean, announce an intended vote, and lean slightly toward the table's vote intentions. They skip only when the evidence is flat and there is hull to spare.
- **Undertow** build a cover story. One member of the team may fake the sonar role, with invented scans that frame dangerous crew and clear partners. Some fake a clue, but only for a night nobody has claimed yet. They frame whichever crew member the public already suspects, accuse only when a crew player in their seat would, stagger their accusations so they don't pile on together, drag the biggest threat at night, split votes away from a partner who is under pressure, and abandon a partner who is clearly lost.

Speech is produced from the claims through persona voice templates, so text and claims always agree.

### LLM agents

`LLMAgent` runs a ReAct loop over a provider-agnostic JSON protocol. Every model turn is exactly one object:

```json
{"thought": "private reasoning", "tool": "estimate", "args": {}}
```

- **Information tools:** `review_claims` (optionally for one player), `review_votes`, `estimate` (the Bayesian posterior, offered as a calculator), and `note` (a private note that later turns see).
- **Final tools:** `speak`, `vote`, `night_action` and `last_words`. Exactly one of these ends a decision.

Each prompt holds the rules, the persona and secret role, a digest of the agent's memory and notes, and the task. Replies are parsed robustly: the first balanced JSON object wins, code fences are stripped, and `action` is accepted as an alias for `tool`. Names are resolved to ids ("Ravi", "Ravi Mehta" and "p3" all work), and claims are validated. Malformed or illegal output goes back to the model as an error so it can repair it. Retryable provider errors back off. After `maxSteps` (4) or a fatal error, the agent falls back to its heuristic twin. Every decision leaves a trace (steps, observations, errors, the final action and whether it fell back), and the spectator view shows these traces.

Providers implement one method, `complete({system, messages, maxTokens})`:

- `AnthropicProvider` uses the official SDK. It caches the system prompt, sets an effort level, and uses server-side model fallback. It reports refusals and maps typed SDK errors to retryable or fatal.
- `OpenAICompatibleProvider` uses plain `fetch` against `/chat/completions` in JSON mode.
- `MockLLMProvider` is an offline model that speaks the same JSON protocol, with a heuristic brain. It consults `estimate` before speaking, and it can be made noisy so that it emits garbage or illegal moves. That noise exercises the repair and fallback paths in tests and demos without a key.

## Simulation and balance

`npm run sim` plays heuristic agents against each other. Results from 2,000 games per table size, seed 11:

| Players | Setup | Clue chance | Crew win | Avg rounds | Airlock accuracy (day 1) |
|---|---|---|---|---|---|
| 5 | siren · sonar, 3 divers | 100% | 54.4% | 1.9 | 40.1% (35.0%) |
| 6 | drowned, siren · sonar, medic, 2 divers | 40% | 53.0% | 2.7 | 68.4% (56.9%) |
| 7 | drowned, siren · sonar, medic, 3 divers | 0% | 52.4% | 2.9 | 53.6% (30.2%) |
| 8 | 2 drowned, siren · sonar, medic, archivist, 2 divers | 80% | 51.1% | 3.2 | 71.4% (48.2%) |
| 9 | 2 drowned, siren · sonar, medic, archivist, 3 divers | 10% | 50.5% | 3.6 | 61.1% (41.2%) |
| 10 | 2 drowned, siren · sonar, medic, archivist, 4 divers | 10% | 52.6% | 4.0 | 57.1% (32.6%) |

The report also tracks outcomes by reason, days without an airlock, medic saves, how often the sonar role was faked, fake clues, sonar survival to day 2, and controller errors (zero across all of these runs). A full 6,000-game sweep takes about a minute.

### How the balance got here

The setups were tuned through several rounds of simulating, reading transcripts and fixing, in both the rules and the agents.

1. **Night one.** With a drag on the first night, seven-player crews won about 42% of games in an average of 2.4 rounds, because the game was decided before anyone had information. The first night is now calm.
2. **Fake clues.** Transcripts showed Undertow inventing clues that the crew could not check, and day-one airlock accuracy fell *below chance* (16% at six players, against a 33% base rate). The belief model then learned that only one clue is dealt per night, which makes the real holder certain the second claimant is lying. Crew accuracy jumped, and the Undertow policy adapted: it now fakes only a clue for a night nobody has claimed yet.
3. **Bandwagons.** The next weakness was two Undertow accusing the same crew member with no evidence, after which the crew followed the crowd. A pile-on likelihood now treats a pair of evidence-free co-accusers as a likely team. The Undertow responded by staggering their accusations.
4. **Setups.** With both sides playing better, the crew won 85–93% of games at some table sizes. Per-size role lists and clue rates bring every size to 50–54%. Clues turned out to be the strongest lever, and the siren the second strongest.
5. **Pointing at the crew.** Accusations, vote intentions and votes used to count only when they hit an Undertow, so an Undertow could accuse a player the table knew was crew for free. They are now modelled as a choice among the living, which makes pushing a likely-crew player evidence against the pusher. A Medic's reported save also clears the saved player, since the Undertow never drag their own. Crew win rates jumped to 63–79%. The Undertow adapted by accusing only when a crew player would, and the setups were retuned: fewer clues at most sizes, a third Undertow at eight players, and no Medic at five.

## Testing

`npm test` runs 64 tests in about 6 seconds.

- **Engine:** setup and determinism, the calm first night, drags and medic saves, the medic's no-repeat rule, siren echoes, clue invariants, archivist reads, discussion order, strict-plurality votes, ties and skips, hull breach, parity, round limit, last words, faction reveal, input validation, speech sanitising, serialize and resume, event redaction, and claim validation.
- **Beliefs:** exact enumeration, posteriors that sum to the Undertow count, private versus public knowledge, hard facts from scans and drags, the one-clue-per-night rule, targeting as a choice among the living, and reported Medic saves.
- **Heuristic agents:** 90 games across every table size with no illegal actions, determinism, a sonar acting on a hit, and a sane simulation report.
- **LLM agent:** JSON extraction, tool use and name resolution, repair of malformed and illegal output, fallback after repeated bad steps, retry on retryable errors and fallback on fatal ones, claim validation, prompt contents, full noisy mock-LLM games, the agent factory, and faction-vs-faction matchups.
- **Session and server:** a human seat (waiting, redaction, reveal at the end), rejection of invalid human actions, spectator insights, claim extraction from typed text, and a complete game played over HTTP and SSE with token checks and a path traversal probe.
- **Replays:** recording a finished game, playing it back one event at a time, phase jumps, refusing actions, and rejecting files that are not replays.
- **Web client:** the real UI in jsdom. One test watches a full game and opens an agent's mind panel. Another plays every decision through the buttons and the speech box. A third copies a replay at the end and plays it back from the start screen.

## Design notes

- **Original by construction.** The setting, roles, mechanics (hull, station-log clues, siren echo, calm first night) and characters are all made for this project.
- **Claims are the interface.** Free text is for flavour. Structured claims are what every agent, human or AI, reasons over. This keeps the reasoning code honest and testable, and lets heuristic and LLM agents share one belief engine. It also means an LLM can bluff in a way the other agents fully understand.
- **Graceful degradation everywhere.** An agent that throws, times out or returns nonsense never breaks a game: the LLM agent falls back to its twin, and the match falls back to a safe action. This matters once a game depends on a network API.
- **The model is not the referee.** The engine validates everything. An LLM cannot vote for a dead player, scan twice or invent players.
- **Determinism.** A seed fixes roles, clues, persona casting and every heuristic choice, so any game can be replayed or turned into a regression test.
- **Small and dependency-light.** The only runtime dependency is the Anthropic SDK, and the server imports it only when Claude agents are enabled.

## Project layout

```
src/
  engine/      types, rng, roles and setups, claim validation, the Game state machine
  agents/      memory, beliefs, personas, voice templates, heuristic agent, factory
    llm/       provider interface, Anthropic and OpenAI-compatible providers, mock model,
               prompts, JSON parsing, the ReAct LLMAgent
  runner/      Match (drives a game), lineup (casting), GameSession (UI bridge)
  server/      HTTP + SSE game server
  sim/         simulation harness, report, transcripts, CLI
  web/         index.html, style.css, UI, clients, replays, claim extraction from typed speech
test/          vitest suites (engine, agents, llm, session and server, replays, web UI)
scripts/       esbuild build
```

## What's next

- Publish tournament results for real models (the `--crew` and `--undertow` flags are ready; this environment has no API key).
- Add a learned or tuned policy: fit the belief likelihoods and policy dials to simulated play instead of setting them by hand.
- Add sound and a little more motion in the UI, such as the hull creaking and the lights dimming at night.
