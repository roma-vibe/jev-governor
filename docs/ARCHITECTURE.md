# jev-governor: architecture

## Goal

Spend Claude subscription limits where they buy quality and save them
everywhere else, using Jev (TypeSafe's System One decision model, via
OpenRouter) to make the decisions. Only official Claude Code mechanisms are
used: a mod (plugin of function hooks) inside the unmodified client. No proxy,
no token handling (the hooks API cannot read the OAuth session at all).

## What it decides

| Where | Lever | When | Why there |
|---|---|---|---|
| Main conversation | effort (`low`…`max`) | every turn | Changing effort keeps the prompt cache on Opus 5.5 / Sonnet 5.5 |
| Main conversation | model (Sonnet 5.5 ↔ Opus 5.5) | to Sonnet where it pays in dollars: the re-write of the context on Sonnet's cache against what Sonnet saves on output and new cache writes over `expectedTurns` turns; to Opus where the cache is cold or the context small, a confident upgrade (P ≥ 0.8) always | Each model has its own cache; cache reads cost the same on both, so only output and writes differ |
| In-turn | effort +1 per N failed tool calls (max +2) | during a turn | Evidence beats prediction; cache-safe |
| Subagents | model + effort | at spawn | A subagent starts with an empty context: switching costs nothing |
| Subagents | light model (Haiku 5.5) for read-only, easy tasks (P(opus) < `lightBelow`, not risky, effort ≤ high) | at spawn, `router.lightSubagents` (`on`) | Reading is where subagents spend, and Haiku 5.5 reads the cache at $0.01/MTok under a 100K prompt ($0.05 above) against Sonnet's $0.20; it takes the chosen effort; moves up after `lightMaxSteps` steps or tool errors |
| Subagents and first prompt | long-term memory notes (`memory.*`, MCP server Mnema) | first task of a chat; subagent spawn (recall runs alongside the plan) | A cold start finds again by reading what earlier chats decided; a few hundred tokens of recalled notes, fetched by the mod without a model step, replace some of those reads. The notes say the task is already recalled, so the model does not spend a step on its own recall |
| Subagents | specialist agent (reuse or create) | at spawn of a generic agent | Short, task-class-specific prompts instead of a generic one |
| Compaction | Jev prunes stale tool calls, text stays verbatim | at 200k tokens if Jev removes ≥ 40% (then not again before +60k); when the cache expired during idle (timer, or on resume) if ≥ 15%; when Claude Code compacts (≥ 25%, else its own summary) | No lossy summary; a rewrite of the cache pays back after (1−r)/r × 40 steps on Opus, so weak prunes are skipped |
| Pruned calls | every call the compaction drops or truncates is saved (input + full output) to `outputs/<session>/pruned/`; the truncated result names its file, an index lists calls removed whole | at compaction | Pruning becomes reversible: the model reads a detail back instead of re-running a tool, so pruning can be bolder; `output-read` entries measure how often that is needed |
| New chat | `/jevg fresh [focus]` makes a capsule, runs `/clear` and attaches it to the next prompt (same window); `/jevg getctx [focus]` makes a capsule (brief by the old chat's model while its cache is warm, turns: newest whole / Jev-picked condensed / one line, changed files, last checks); a `jev-ctx:<id>` reference in a new chat's prompt attaches it as hidden context | on request; a hint when Jev sees a new task on ≥ 150k, or the cache of ≥ 300k went cold | Each step of a new chat reads ~10–15k instead of the old 400k+; see docs/CONTEXT.md |
| Tool outputs | test/build/install output (and anything huge) trimmed before it enters the history: outcome line, every error/warning/failure line with context, summaries, head/tail, Jev-picked middle parts; full output saved and pointed at. A Bash output over ~30k never reaches the mod whole: Claude Code saves it and leaves a 2KB preview of its start; for a test or build run the mod trims the saved file instead, so the failures at its end are in the history | at append | Cheaper than compaction: nothing cached is rewritten; capped at 7 days / 200 MB |
| Data sent to Jev | secrets (known key formats, private keys, JWTs, `NAME_TOKEN=…`, quoted secret values, high-entropy strings) replaced with `[secret]` in every request; `excludeProjects` sends nothing at all | every request | Jev sees the conversation, commands and outputs; keys that slip into them must not reach OpenRouter |
| Budget | thresholds shift with 5-hour / weekly pace | every decision | Max 20x is large, not infinite |

## Flow of a main turn

```
turn.start ──► decideMainTurn (async, ≤ timeout)
                 ├─ $.session.usage()      → context tokens, rate-limit windows → pressure
                 ├─ $.session.messages()   → recent_conversation (≤ 3.5k tokens)
                 └─ Jev: tier_a, tier_b (both option orders), effort (score),
                         risky, continuation, new_topic, correction (noul)
turn.step #0 ──► await decision → decideMain(): tier + effort (+ reasons)
             └─► next({ ...e, model, effort })        (every step of the turn)
tool.call    ──► counts failures → effort escalation for the next steps
turn.complete ─► usage → ledger; maybe trigger compaction
```

`decideMain` (hooks/lib/router.ts):
- a short follow-up («да», «давай», "go on") is recognized locally
  (`isShortFollowUp`) and keeps the previous decision without asking Jev;
- follow-up (`continuation` ≥ 0.6) → previous decision unchanged;
- effort = Jev's expected level if confident, else default; capped by budget
  pressure (2 → `high`, 3 → `medium`); `risky` lifts it to at least `high`;
- on Sonnet: upgrade if P(opus) ≥ `forceUpgradeAt` (or risky), or ≥
  `upgradeAt` where the switch is free/cheap;
- on Opus: downgrade only where it pays (`switchEconomics`: the cache
  re-write against the per-turn gain × `expectedTurns`, the turn profile
  learned from the session), P(sonnet) ≥ `downgradeAt`, the context fits
  Sonnet, and the task is not risky; under critical pressure P(sonnet) ≥ 0.5
  suffices; both sums are in the decision's reasons;
- a `/model` change by the person is adopted, not overridden, for that turn.

## Flow of a subagent spawn

```
agent.spawn (not a fork)
  ├─ rank registry specialists by word overlap (≤ 12)
  ├─ Jev: tier_a, tier_b, effort, risky, agent (choice over candidates + none)
  ├─ specialist chosen (P ≥ matchAt)       → its role + skills are prepended to the task
  ├─ none fits & autoCreate                → $.model.complete (Sonnet 5.5, low effort)
  │                                          drafts {name, description, prompt, tools,
  │                                          reuse_skills, new_skills} → saved to the registry,
  │                                          used for this task and every similar one later;
  │                                          one draft at a time: a spawn that waited asks Jev
  │                                          whether the specialist drafted meanwhile fits first;
  │                                          no size cap: near-copies are kept out by the draft
  │                                          (`reuse`) and folded by `/jevg agents merge`
  └─ model = Sonnet/Opus by P(opus) vs bar (search agents +0.2), effort per step
```

Verified against the engine (2.1.286): a spawn can only be rewritten to an
agent type that was offered to the model when the turn began; a hidden or
freshly registered type is refused, the Agent call fails, and the hook cannot
retry. So the spawn's type is never rewritten: the generic subagent runs with
the specialist's `<role>` (prompt + skills) in front of its `<task>`. The
model's agent listing, and with it the main prompt cache, never changes. With
`agents.exposeToModel` the specialists are also registered and listed, so the
model may call one by name (that call is routed like any other spawn).

Each subagent costs ~45k cache-write tokens just to start (system prompt and
tools, measured), so delegating tiny tasks is not free.

A subagent's first steps can run before its spawn resolves with an id, so
the per-step effort is matched to its spawn by the task text the subagent's
transcript opens with.

## Failure behaviour

Every path fails open: no key, a Jev error or timeout (2.5 s default), an
unusable draft — the engine proceeds exactly as without the mod. Failures go
to the ledger as `error` entries; after 3 failed Jev requests in a row the
status line shows `jev ✕`, so a silent mod is visible. A mod the engine
refused to load shows no `jev ▸` line at all; `scripts/monitor.mjs` counts
sessions without a ledger file.

`/clear` and a resume end the conversation without a new `session.start`; a
`session.end` hook marks it and the next hook rebinds to the new session id.

## Cost of the router itself

A main-turn decision is ~1–4k input tokens to Jev (≈ $0.00005–0.0002 at
$0.042/M); a spawn decision similar; compaction up to ~30k per request
(≈ $0.0013). Drafting a specialist is one Sonnet call (~2k in / ~600 out)
from the subscription, only when a new kind of task appears.

## Codex (next version)

`hooks/lib/providers.ts` models a decision's target as
`{ provider: 'claude' | 'codex', model, effort }`. The Codex provider would be
a registered tool or agent that runs the official `codex exec --json -m … -c
model_reasoning_effort=…` under the person's own ChatGPT login (via
`$.process.run`), chosen by a Jev question such as "self-contained
implementation task with a clear spec" and by the Claude windows' pressure.
`codex mcp-server` is not an option: OpenAI removed it.

## One module file: an engine rule, and how far it reaches

`claude plugin validate` follows `$` (the engine interface) statically and
refuses a module that passes it to a function imported from another file:
"$ is followed only into a function declared in this same file, never across
an import". So every `$.…` call is written in `hooks/register.ts`; what needs
no engine interface lives elsewhere: the policies in `hooks/lib/` (pure,
tested) and the session state with its engine-free helpers in
`hooks/mod/state.ts`.

The rule is about `$` itself, not about I/O: a closure written in
`register.ts` (`(path) => $.fs.read(path)`) may be handed to an imported
function, as `jevAsker({ http })` and `withTimeout(…, (ms) => $.clock.sleep(ms))`
already are. So more could move out behind a small I/O object built in
`register.ts` (the handoff, the archive, the trim, the ledger writer); only the
`$.…` call sites and the `on(...)` registrations must stay. Not done yet.

Several modules in `hooks.json` would not help: each runs in an environment of
its own and would hold its own copy of the ledger lines it rewrites. A separate
plugin (the projects panel, say) is possible: it has its own `register.ts`; what
it would share with this one is the ledger.

## Files

- `hooks/register.ts` — wiring to the engine (`$`), storage, ledger.
- `hooks/mod/state.ts` — the session state `S`, its types, engine-free helpers.
- `hooks/lib/redact.ts` — secrets out of every request to Jev.
- `scripts/monitor.mjs` — the monitoring report (ledger + transcripts).
- `hooks/lib/router.ts` — questions and decision policy (pure, tested).
- `hooks/lib/budget.ts` — pace-based pressure from rate-limit windows.
- `hooks/lib/history.ts` — compact recent-conversation view for Jev.
- `hooks/lib/registry.ts` — agents/skills validation, ranking, drafting prompt.
- `hooks/lib/jev.ts` — System One protocol over an injected transport.
- `hooks/lib/compaction/` — vendored fast-jev-compaction (MIT) + adapter.
- `hooks/lib/archive.ts` — pruned calls to files, pointers in the compacted history.
- `hooks/lib/capsule.ts` — the new-chat capsule: turns, Jev turn selection, rendering, paste prompt.
- `ui/` — Vue 3 + Tailwind 4 settings UI and its local server.
