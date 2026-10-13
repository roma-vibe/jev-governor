# jev-governor data directory

Everything the mod and the settings UI share lives in one directory:
`~/.claude/jev-governor/` (override with the `JEV_GOVERNOR_HOME` environment
variable, or `--data` for the UI server). The TypeScript source of truth for
every shape is `hooks/lib/types.ts`; validation is `hooks/lib/config.ts`
(`resolveConfig`) and `hooks/lib/registry.ts` (`sanitizeAgent`,
`sanitizeSkill`).

```
config.json                 GovernorConfig — written with defaults on first run
openrouter.key              default key file (config.jev.keyFile); env OPENROUTER_API_KEY wins
agents/<name>.json          AgentRecord, one file per specialist subagent (uses, lastUsedAt;
                            retiredAt when an older mod's size cap turned it off;
                            mergedInto when it was folded into a near-copy, enabled false)
skills/<name>.json          SkillRecord, one file per skill (mergedInto likewise)
drafts/<id>.json            DraftRecord: the UI asks, an open Claude Code session drafts
merge.json                  MergeRequest: the UI asks, an open session folds near-copy agents
merge-auto.json             the last background fold (agents.autoMergeHours)
projects/<id>.json          ProjectRecord: a project page's commands (written by the UI server)
describe/<id>.json          DescribeRequest: command descriptions an open session writes
outputs/<session>/<id>.txt  full tool outputs that were trimmed (7 days / 200 MB)
outputs/<session>/pruned/<tool_use_id>.txt   calls a compaction pruned: input + full output (same caps)
outputs/<session>/folded/<hash>-<chars>.md   old dialog messages a compaction folded: full text
outputs/<session>/memory-read.json   turns already read for facts (memory.autoSave), so a resumed chat does not read them again
outputs/<session>/pruned/index.md            one line per pruned call of the chat, newest last (file names relative to it)
outputs/<session>/pruned/index-<agentId>.md  the same for one subagent
handoffs/<id>.md            a capsule for a new chat (/jevg getctx, /jevg fresh); kept handoff.keepDays (30)
handoffs/<id>.json          its record: id, cwd, session, title, focus, tokens, sourceTokens, turns, brief, jev, path, attached[]
ledger/<YYYY-MM-DD>/<session>.jsonl   LedgerEntry per line, written by the mod only (`v`: mod version, since 0.3.2)
ui.pid                      pid of a detached UI server
```

## Who writes what

| File | Mod | UI |
|---|---|---|
| `config.json` | first run (defaults), `/jevg on|off` | Settings page |
| `agents/*`, `skills/*` | auto-created specialists | create, edit, delete |
| `drafts/*` | `pending` → `working` → `done`/`error` | creates `pending`, accepts or deletes |
| `merge.json` | `pending` → `working` → `done`/`error` | creates `pending`, reads the result |
| `projects/*` | — | scans, merges learned commands, edits |
| `describe/*` | `pending` → `working` → `done`/`error` | creates, merges `done` into `projects/`, deletes |
| `ledger/**` | append | read only |

The mod re-reads `config.json` at the start of every turn (by mtime) and
re-reads the registry before every subagent spawn (by directory mtimes), so UI
edits take effect without a restart.

## Names

Agent and skill names match `^[a-z][a-z0-9-]{1,39}$` and are the file names.
An agent is registered in Claude Code as `jev-governor:<name>`.

## Agents and skills

An agent's system prompt is its `prompt` followed by each of its `skills`
as `## Skill: <name>\n<body>` sections (`composePrompt`). Skills are shared:
one skill can serve several agents. Limits: description 200 chars, prompt
1500, skill body 2000, 4 skills per agent.

`tier`/`effort` set to anything but `auto` pin that agent's model tier
(`standard` = Sonnet 5.5, `strong` = Opus 5.5) or effort; otherwise Jev
decides per task.

## Drafts

1. UI writes `drafts/<id>.json` with `status: "pending"` and
   `request.description`.
2. Any Claude Code session running the mod picks it up within ~8 s, sets
   `working`, drafts with `$.model.complete` (Sonnet 5.5, low effort) and
   writes `done` with `result: { agent, skills }`, or `error`.
3. The UI shows the result for review; accepting saves `agents/` and
   `skills/` files and deletes the draft. When an existing agent already
   covers the description, the draft ends in `error` naming it.

## Merging near-copies

Parallel spawns of one task used to draft near-copies (`judge-packet-v2-grader`
and `-grader-2`), and Jev's vote then split between them. Now:

- A spawn's draft sees every enabled specialist and may answer `{"reuse": name}`;
  a draft under an existing name is that specialist, never a `-2` copy, and a
  "new" skill under an existing skill's name is that skill.
- Jev's pick counts when the likeliest specialist reaches `agents.matchAt`, or
  the specialists together do (near-copies split the vote) and `none` is not the pick.
- The registry has no size cap and nothing is turned off for being idle: a
  specialist drafted once stays available however rarely its kind of task comes.
- `/jevg agents merge`, or the "Merge near-copies" button (`merge.json`), folds
  them on demand with the draft model. The kept specialist takes the group's
  skills, tools, runs and last run, and may get a wider description; the others
  get `enabled: false` and `mergedInto`, and a spawn that names them gets the
  kept one. Nothing is deleted; manual agents and skills are never folded away.
  Turning a merged agent back on in the UI clears `mergedInto`.
- The same fold runs in the background at most every `agents.autoMergeHours`
  (24; 0 is off), and only when a specialist was drafted since the last pass.
  One open session does it: it claims `merge-auto.json` (`at`, `worker`,
  `status`, `result`/`error`); the folds are in the ledger as `agent-created`
  with `change: "merged"`.

## Ledger entries (`kind`)

- `turn` — main-loop decision at the first request of a turn: `model`,
  `prevModel`, `effort`, `switched`, `pStrong`, `effortScore`, `risky`,
  `continuation`, `pressure`, `reasons`, `jevMs`, `jevCost`.
- `subagent` — spawn decision: `subagentType`, `agent`, `created`, `model`,
  `effort`, `pStrong`, `reasons`, `jevMs`, `jevCost`.
- `usage` — tokens of a finished turn (`scope` main/subagent):
  `usage: { model, input, output, cacheRead, cacheWrite }`, plus `steps` (model
  requests in the turn), `effort` (what the mod sent) and `baseModel` /
  `baseEffort` (what the turn would have run on without the mod) — the inputs
  of the savings report (`hooks/lib/savings.ts`). Since 0.3.4 the tokens are the
  turn's steps summed (`usageFrom: steps`): the figure Claude Code reports at the
  end of a turn starts over at a compaction inside it, so earlier entries of
  long turns (`usageFrom` absent or `turn`) hold only what came after the last
  one. A turn that ran on more than one model (a light subagent moved up) gets
  one entry per model, each with its own `steps`.
- `compact` — Jev compaction: `compaction: { charsBefore, charsAfter, ratio,
  requests, fallback?, reason }` (`reason`: engine / threshold / return / window), `jevCost`, `model`
  (in a subagent: `scope: subagent`, its `agentId` and the model it was routed to).
- `window` — once per session: Claude Code's auto-compaction window
  (`compaction.autoWindowTokens`): `autoWindow: { by: mod | user | none, wanted?, tokens?, source? }`;
  `tokens`/`source` are what the engine measures against (`source: env` when the variable took).
- `agent-created` — a specialist was drafted: `agent`, `reasons` (new skills);
  with `change: "merged"` (`mergedInto`) it was folded instead (`retired`: an older mod's size cap).
- `trim` — a trimmed tool output: `trim: { tool, command, charsBefore, charsAfter, outcome, jevChunks, path }`.
- `output-read` — the model opened a saved full output or a pruned call (`text` names the tool and path;
  `archive`: pruned / folded / trim / tool-results / other, since 0.3.4).
- `compact` also carries `compaction.archived`: pruned calls saved to files,
  and `compaction.folded: { candidates, folded, chars, requests, byKind, keeps }`: old
  dialog messages Jev was asked about, folded, the characters that went, and
  per kind (answer / paste / agent / monitor / task); `keeps` (0.3.4) lists each
  candidate as `kind:keep:chars:turnsAgo`, Jev's probability that it must stay.
- `handoff` — a capsule made in the old chat (`action: create`) or attached in a new one (`attach`): `handoff: { id, tokens, sourceTokens, turns, brief, jev, path }`.
- `hint` — the new-chat suggestion was shown: `newTopic`, `reasons` (context size).
- `turn` also carries `newTopic`: Jev's P(the request starts a new task).
- `command` — a command Claude ran in a project, normalized (`| tail`, `2>&1`, a leading `cd x &&` removed; exploratory, compound and secret-looking commands are never recorded): `cwd`, `command`, `dir?`, `success`.
- `turn` also carries `correction` (Jev's P(the request corrects the previous
  answer)) and `local: true` when it was decided without Jev (a short
  follow-up such as «да», «давай», "go on").
- `usage` also carries `escalated`: effort levels added after failed tool calls
  (counted among the `router.errorWindow` latest tool results since 0.3.4).
  Since 0.3.8 the raise ends after `5 × errorWindow` successful results in a
  row, and under budget pressure it stops at that pressure's effort cap.
- `override` — the person disagreed with the router: a `/model` change
  (`model`, `prevModel`) or a change of the session's own effort (`effort`);
  `reasons` says which.
- `subagent` also carries `light: true` when the task qualified for the light model
  (read-only, not risky, P(strong) below `router.lightBelow`, effort `high` or less; before 0.3.5 `medium`) and
  `lightApplied` (whether it ran there: `router.lightSubagents` `on` or `shadow`).
- `chat` — `/jevg chat on|off` or `/jevg idle on|off` in a chat (`text`, `reasons` give the state after).
  The switches themselves live in the engine store under `chat:<session>` (`off`, `idle`).
- `light-up` — a light subagent moved to the standard model after
  `router.lightMaxSteps` steps or failed tool calls (`reasons` says which).
- `rerun-after-prune` — after a compaction the model ran a pruned command or
  read a pruned file again (`text` names the call). With `output-read` of
  `pruned/` files, the measure of how often pruned content is needed.
- `redacted` — secrets replaced in one request to Jev: `count`, `text` (what
  the request was for: decision, subagent, trim, handoff, compaction).
- `compact` also carries `compaction.restored` (calls put back because Jev
  would have removed more than `compaction.maxPruneRatio`) and
  `compaction.via` (`api` / `command`: how our own compaction was started).
- `handoff` also has `action: clear` (the chat cleared by `/jevg fresh`) and
  `handoff.fresh` on a capsule `/jevg fresh` made.
- `trim` also carries `trim.persisted` and `trim.fullChars` when Claude Code
  had already saved a big Bash output to a file and left a 2KB preview: the
  mod trimmed that file instead (`charsBefore` is then the preview).
  `trim.kind: "list"` marks a long listing (ls, du, ps, find…) shortened to
  its first and last rows. `trim.skipped` (with `applied: false`): the output
  qualified, but the trim would have removed under 15%, so it stayed whole.
- `turn` / `subagent` reasons end in `(fallback)` when Jev could not be
  reached and there was no earlier decision: the model stayed, the effort is
  `router.fallbackEffort`. A routing request Jev dropped once is retried (a subagent spawn always, waiting `jev.subagentTimeoutMs`, 8000; with Jev still down, a research-like spawn (`router.fallbackReadOnlyStandard`) goes to the standard model at medium effort); the
  first failure is logged as an `error` ending in `(retrying)`.
- A `subagent` reason `wait note added`: the task got the `<cache-note>`
  (`agents.waitHint`) asking it to keep every wait under 4 minutes.
- `memory` (0.3.5) — a call to the long-term memory server: `memory: { action, for, ok, facts?, chars?, ms?, error? }`.
  `action`: `recall` / `save` / `start` (the mod started the local server) / `refuse` (a model's memory tool
  refused while the memory is off). `for`: `prompt` (first task of a chat), `subagent`, `handoff` (the brief
  saved), `model` (the model's own call; `text` is the tool). `facts` and `chars`: what was added to the prompt;
  `applied: false` in shadow mode (asked, nothing added). A `subagent` entry may carry the same `memory` object.
- `usage` also carries `long` (0.3.5): the part of the turn from steps with a prompt over 100K tokens
  (`input`, `output`, `cacheRead`, `cacheWrite`, `steps`), priced on Haiku 5.5's long rate card.
- `error` — `error` text (Jev timeouts, drafting failures …).

## Projects

The UI lists projects from Claude Code's own session history
(`~/.claude/projects/*/*.jsonl`, the `cwd` of the newest session). A project
page's commands come from the project's files (package.json scripts, Makefile
targets, Cargo crates, justfile, pyproject, compose, `.claude/launch.json`,
shell blocks in README / AGENTS / CLAUDE docs) and from `command` ledger
entries with at least `projects.minSuccesses` successful runs. Project folders
are only read. Descriptions are written in `projects.descriptionLanguage` by
an open Claude Code session with the mod (Sonnet, low effort), only for
commands that lack one; a description the person edits is never replaced.
"Run" opens Terminal.app with `cd <dir> && <stored command>`.

## Savings

`computeSavings` (hooks/lib/savings.ts) turns the ledger into API-equivalent
dollars. Since 0.3.12 the model and effort a turn ran on are taken as given:
the person could have chosen them, so the choice is neither a saving nor a
cost, and every amount is priced on the model that actually ran. `routing`
lists the models and efforts with their turns and cost, for orientation only.

Saved, exact: trimmed and compacted tokens × the later requests that would
have re-read them (minus a size-triggered compaction's re-write); a compaction
Claude Code started at the mod's window (`window`, mid-turn or in a subagent)
is priced like a threshold one in its own loop. Tools behind ToolSearch
(`tools` entries: definitions removed from the prefix, `chars`) × the later
requests of that chat until the next set. Saved, estimated: Claude Code
compactions answered by Jev (the summary call avoided).

Spent: Jev's own cost and the mod's own model calls (`call` entries: purpose,
model, usage — drafts, merges, autosave and its check, command descriptions,
handoff briefs). Spending is counted in any mode; shadow-mode sessions are not
part of the savings or `actual`. `withoutMod` = `actual` + saved. `totals.cost`
splits the managed turns' cost into input, output, cache reads and cache writes.

## Settings added after the first review

- `excludeProjects` — paths whose sessions send nothing to Jev.
- `compaction.maxPruneRatio` (0.8), `compaction.resultPreviewChars` (150).
- `router.expectedTurns` (4) — turns a move to Sonnet must pay back within.
- `router.settleTurns` (3, 0.3.11) — after a model switch on a warm cache, no switch back for this many
  turns: each switch rewrites the cache and drops the reasoning kept so far (Opus 5.5 and Sonnet 5.5
  cannot read each other's thinking). A clear upgrade (P ≥ 0.8), a risky task, a critical budget or a
  cold cache still switch.
- `tools` (0.3.11): `deferIdle` (true), `deferAlso` (Artifact, Workflow, ReportFindings, ScheduleWakeup,
  the plugin/skill suggestion tools, the iOS simulator, visualize, spawn/dismiss task), `keep` ([]),
  `idleDays` (14), `minChars` (800). Every request carries the full text of each listed tool; one used
  once in a hundred chats (Artifact's alone is ~5k tokens) is read from the cache at every step for
  nothing. Such a tool goes behind ToolSearch; one called within `idleDays` stays listed. Calls are
  counted in the store (`tool-use`, shared by all chats); placements are decided once per process,
  never mid-chat (that would rewrite the cache). The `tools` ledger line lists what was deferred.
- `handoff.suggestColdAtTokens` (300k) — suggest `/jevg fresh` when the cache
  of a context this large went cold.
- `projects.enabled` — the whole project panel.
- Short-lived workers (0.3.13) — a subagent's cost is its context carried over its steps (84 writing
  subagents: 479 steps at ~217k on average; 29% of agents ran over 150 steps and made 84% of subagent
  cost), so the mod pushes work toward several narrow workers on complete briefs:
  - `agents.delegationGuide` (true) — a brief template (goal, files, what it cannot guess, done-when,
    report; prefer several narrow subagents) appended to the Agent tool's description.
  - `agents.scopeNote` (true), `agents.fileLines` (300) — a `<scope-note>` on every writing worker's
    task: touch only what the task names, small files of one responsibility, read ranges not whole files.
  - `agents.brief` (`shadow` | `on` | `off`, default `shadow`), `briefWeakAt` (0.35), `tooBigAt` (0.6),
    `bigSteps` (150) — Jev judges each brief (complete? too big for one worker? expected tool calls). In
    `shadow` it only records; in `on` the parent is refused once per task when it is too big, or too thin
    for a lighter model (the retry of the same task goes through). Read-only agents are never refused.
  - `router.roles` (`shadow` | `on` | `off`, default `shadow`), `roleAt` (0.5), `roleBriefOk` (0.5),
    `rolePStrongMax` (0.9) — model by kind of work: planning/review/security stay strong, implementing a
    complete brief goes to the standard tier, documentation and simple tests to the light model; never when
    risky, with a thin brief, or when Jev is sure Opus is needed. Ledger `brief` carries `roleWould`.
  - `node scripts/monitor.mjs` §4b prints verdicts, roles, steps/context/cost per worker and the share of
    cost in workers over 150 steps.
- `router.lightSubagents` (`shadow` | `on` | `off`, default `on` since 0.3.5), `router.lightBelow` (0.25),
  `router.lightMaxSteps` (80), `models.light` (`claude-haiku-5-5`; a config naming Haiku 4.5 is moved to it) —
  read-only subagents with an easy task on the light model: Haiku 5.5 costs $0.10/$0.50 per MTok with cache
  reads at $0.01 under a 100K-token prompt and $0.50/$2.50, $0.05 above (Sonnet 5.5: $2/$10, $0.20), and
  reading is where subagents spend. It takes the chosen effort. In `shadow` the mod only records what it
  would have chosen (`light`, `lightApplied: false`); `node scripts/monitor.mjs` prints what those
  subagents would have cost on Haiku.
- `memory` (0.3.5): `enabled` (false), `server` (`mnema-memory`, the MCP server's name), `autoStart` (true),
  `startCommand` (empty: `scripts/mnema-local.sh start`), `recallOnStart` (true), `recallForSubagents` (true),
  `subagentMinChars` (200), `saveOnHandoff` (true), `autoSave` (true, 0.3.10), `autoSaveModel` (`claude-haiku-5-5`, reads the dialog), `autoSaveCheckModel` (`claude-sonnet-5-5`, checks the few candidates), `autoSaveEveryTurns` (6), `autoSaveIdleMinutes` (3), `autoSaveMaxFacts` (3), `modelTools` (true), `modelRecall` (false), `maxChars` (2500), `maxFacts` (12),
  `timeoutMs` (2500). See README, "Long-term memory".
