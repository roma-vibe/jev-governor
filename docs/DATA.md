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
agents/<name>.json          AgentRecord, one file per specialist subagent
skills/<name>.json          SkillRecord, one file per skill
drafts/<id>.json            DraftRecord: the UI asks, an open Claude Code session drafts
projects/<id>.json          ProjectRecord: a project page's commands (written by the UI server)
describe/<id>.json          DescribeRequest: command descriptions an open session writes
outputs/<session>/<id>.txt  full tool outputs that were trimmed (7 days / 200 MB)
outputs/<session>/pruned/<tool_use_id>.txt   calls a compaction pruned: input + full output (same caps)
outputs/<session>/pruned/index.md            one line per pruned call, newest last
handoffs/<id>.md            a capsule for a new chat (/jevg getctx, /jevg fresh); kept handoff.keepDays (30)
handoffs/<id>.json          its record: id, cwd, session, title, focus, tokens, sourceTokens, turns, brief, jev, path, attached[]
ledger/<YYYY-MM-DD>/<session>.jsonl   LedgerEntry per line, written by the mod only
ui.pid                      pid of a detached UI server
```

## Who writes what

| File | Mod | UI |
|---|---|---|
| `config.json` | first run (defaults), `/jevg on|off` | Settings page |
| `agents/*`, `skills/*` | auto-created specialists | create, edit, delete |
| `drafts/*` | `pending` → `working` → `done`/`error` | creates `pending`, accepts or deletes |
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
   `skills/` files and deletes the draft.

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
  of the savings report (`hooks/lib/savings.ts`).
- `compact` — Jev compaction: `compaction: { charsBefore, charsAfter, ratio,
  requests, fallback?, reason }` (`reason`: engine / threshold / return / window), `jevCost`, `model`
  (in a subagent: `scope: subagent`, its `agentId` and the model it was routed to).
- `window` — once per session: Claude Code's auto-compaction window
  (`compaction.autoWindowTokens`): `autoWindow: { by: mod | user | none, wanted?, tokens?, source? }`;
  `tokens`/`source` are what the engine measures against (`source: env` when the variable took).
- `agent-created` — a specialist was drafted: `agent`, `reasons` (new skills).
- `trim` — a trimmed tool output: `trim: { tool, command, charsBefore, charsAfter, outcome, jevChunks, path }`.
- `output-read` — the model opened a saved full output or a pruned call (`text` names the tool and path).
- `compact` also carries `compaction.archived`: pruned calls saved to files.
- `handoff` — a capsule made in the old chat (`action: create`) or attached in a new one (`attach`): `handoff: { id, tokens, sourceTokens, turns, brief, jev, path }`.
- `hint` — the new-chat suggestion was shown: `newTopic`, `reasons` (context size).
- `turn` also carries `newTopic`: Jev's P(the request starts a new task).
- `command` — a command Claude ran in a project, normalized (`| tail`, `2>&1`, a leading `cd x &&` removed; exploratory, compound and secret-looking commands are never recorded): `cwd`, `command`, `dir?`, `success`.
- `turn` also carries `correction` (Jev's P(the request corrects the previous
  answer)) and `local: true` when it was decided without Jev (a short
  follow-up such as «да», «давай», "go on").
- `usage` also carries `escalated`: effort levels added after failed tool calls.
- `override` — the person disagreed with the router: a `/model` change
  (`model`, `prevModel`) or a change of the session's own effort (`effort`);
  `reasons` says which.
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
  `router.fallbackEffort`. A routing request Jev dropped once is retried; the
  first failure is logged as an `error` ending in `(retrying)`.
- A `subagent` reason `wait note added`: the task got the `<cache-note>`
  (`agents.waitHint`) asking it to keep every wait under 4 minutes.
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
dollars. Exact: model choice (the same tokens on the model the turn would have
used), trimmed and compacted tokens × the later requests that would have
re-read them (minus a size-triggered compaction's re-write), Jev's own cost.
A compaction Claude Code started at the mod's window (`window`, mid-turn or in a
subagent) is exact too, priced like a threshold one in its own loop.
Estimated: lower effort (`savings.effortFactor` of a turn's **output** per level;
cache reads, most of a long turn, are not scaled) and Claude Code compactions
answered by Jev (the summary call avoided). Shadow-mode
sessions are not counted; entries older than the base fields use
`savings.defaultBaseModel` / `defaultBaseEffort`, and the events priced that
way carry `assumed` (the baseline that stood in), so the report can show how
much rests on the assumption. `totals.cost` splits the managed turns' cost
into input, output, cache reads and cache writes.

## Settings added after the first review

- `excludeProjects` — paths whose sessions send nothing to Jev.
- `compaction.maxPruneRatio` (0.8), `compaction.resultPreviewChars` (150).
- `router.expectedTurns` (4) — turns a move to Sonnet must pay back within.
- `handoff.suggestColdAtTokens` (300k) — suggest `/jevg fresh` when the cache
  of a context this large went cold.
- `projects.enabled` — the whole project panel.
