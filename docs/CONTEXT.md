# Context: "pruned, not lost" and handoff to a new chat

Plan and mechanics. The idea: "history is not context". It is adapted to how Claude Code works: the prompt cache, turn
messages that cannot be rebuilt, and the bulk of history being tool outputs.

## Why (measurements on real sessions, 17.09–05.10.2026)

| Metric | Value |
|---|---|
| Context of a single model request, median | ~430k tokens (up to ~966k) |
| Share of cost (at API prices) | cache read 61%, cache write 24%, output 15% |
| Composition of history | tool results 89%, inputs 9%, dialogue text 1.5% |
| Session "skeleton" (requests + the final answer of each turn) | median ~4k tokens, largest 25–40k |
| "Staleness sieve" (re-read files, repeated commands) | ~2% of results — **not doing it** |

Conclusion: the main lever is context size, not model choice. It can be reduced
in two ways: compact the current chat more aggressively, or move to a new chat
with a small "capsule" instead of 400k of history.

## What we do not do and why

- **Rebuilding the context on every message.** The mod API does not allow touching
  turn messages (`turn.step`), and it would burn the cache: on Opus a write costs 40 times
  more than a read.
- **Embeddings, facts, retellings of replies.** They work on dialogue text, which is
  1.5% of the volume. For long-term facts Claude Code already has CLAUDE.md and
  auto-memory.
- **Staleness sieve.** The measurement gave ~2%; the complexity does not pay off.

## 1. Pruned, not lost (archive and links during compaction)

Currently compaction through Jev discards old tool calls, and of the
results it keeps 300 characters and a note "rerun the tool".

New mechanics:

1. Before returning the compacted history, each pruned call (input and full output)
   is written to the file `outputs/<session>/pruned/<tool_use_id>.txt`. The same
   limits apply as for trimmed outputs: 7 days and 200 MB.
2. In place of the shortened result a link appears: the start of the output plus
   `[jev-governor: … pruned; full output: <path>]`.
3. For calls pruned entirely, a list `pruned/index.md` is kept (tool,
   argument, path). One line in the compacted history points to this list.
4. Reading these files is allowed without a prompt (like trimmed outputs) and is written to the
   ledger as `output-read`. These records show how often the model
   actually needs what was pruned. That is the compaction quality metric.

Effect: compaction stops being irreversible, so thresholds can be set
more aggressively, and enabling active mode everywhere becomes safer.

## 2. Moving the compacted context to a new chat

### Commands

- `/jevg getctx [focus]` — in the old chat. Builds the capsule, saves it and copies
  a short prompt for the new chat to the clipboard. The focus is optional: for example,
  "continuing the projects UI". Flags: `--brief` (always write a brief with the model), `--nobrief`
  (no brief).
- New chat of the same project: paste the prompt from the clipboard. The mod in the new chat sees
  the `jev-ctx:<id>` tag and attaches the capsule to the message as hidden context.
  The model reads it, but it is not visible in the feed. If the mod is not active, the prompt contains
  the path to the capsule file, and the model will read it itself.
- `/jevg ctx` — in a new chat without pasting: attach the project's latest capsule to
  the next message. `/jevg ctx list` — list of the project's capsules,
  `/jevg ctx <id>` — a specific capsule.

### What the capsule consists of (default budget 14k tokens)

1. **Brief** — written by the model of the source chat: goal, state, decisions and why,
   rejected options, open questions and next step, key files and
   commands, pitfalls. This is the only part that cannot be extracted
   mechanically. The brief is made only while the source chat's cache is warm: it is a cache
   read plus ~1.5k output tokens, on the order of $0.1 at API prices for 400k
   of context. On a cold cache the same brief would cost a rewrite of the whole context
   (~$3), so by default it is skipped then.
2. **Course of work** — user requests and final model answers by turn, following
   the "history is not context" principle: the latest turns in full, older ones condensed to the gist, the
   oldest in one line. Which old turns are needed to continue is decided by Jev
   (the question "is this turn needed for <focus>"). Without Jev — by recency.
3. **Files** — what was created and changed (by Edit/Write calls), how many times.
   Contents are not carried over: they are on disk.
4. **Latest checks** — test and build commands and their result ("tests passed
   (59 passed, 0 failed)").
5. **Where the details are** — the path to the full transcript of the old chat and to the archive
   of pruned content.

### Why the old chat is not compacted

The original idea was "compact in the original chat and hand it over". Compaction happens, but not
in place: the capsule is the compacted version. Compacting the old chat itself before leaving
is pointless — it pays for a cache rewrite of a chat you are leaving. If
you stay in it, the usual compaction rules apply.

### Economics

A step in the new chat reads ~45k of system prompt and a ~10k capsule instead of 430k+
of old history: on Opus that is ~$0.011 instead of ~$0.086 per step. The brief pays for itself in
2–3 steps of the new chat.

## 3. Hint on topic change

Jev's per-turn questions now include `new_topic`: "the request starts a new
task, the early conversation is not needed for it". If the probability is ≥ 0.8 and the context is
≥ 150k, the mod shows a hint: "looks like a new task, context 380k —
cheaper to continue with a clean chat: `/jevg fresh`". It is only a hint, no more than once per 10 turns, and
it works in observe mode too. The mod itself switches nothing: topic detection accuracy is 59–75%.

The "cache went cold" hint has been off by default since 0.2.6
(`handoff.suggestColdAtTokens` = 0): after a pause the mod can compact the chat itself
(`compaction.onReturn`, also off by default since 0.2.9: it fired in chats that are never returned to), and on October 6 none of the three hints turned out useful.

## Settings (`config.json`)

- `compaction.archive` (true) — archive and links during compaction.
- `handoff.enabled` (true), `handoff.maxTokens` (14000),
  `handoff.brief` (`auto` | `always` | `never`), `handoff.briefWords` (350),
  `handoff.useJev` (true), `handoff.suggestAtTokens` (150000),
  `handoff.suggestAt` (0.8), `handoff.suggestColdAtTokens` (0, off),
  `handoff.keepDays` (30).
- `compaction.maxPruneRatio` (0.8) — a single compaction does not prune more than this share of
  history; `compaction.resultPreviewChars` (150) — the start and end of each
  output that Jev sees.

## How to check that it works

- Ledger `compact`: the `archived` field — how many calls went to the archive.
- Ledger `output-read` with `pruned/` paths — the model needed what was pruned. If
  there are almost no such records, compaction can be more aggressive.
- Ledger `handoff`: capsule size against the old chat's context, whether there was a brief,
  whether the capsule attached in the new chat.
- Ledger `hint`: how often Jev sees a topic change at large context.

- Ledger `rerun-after-prune`: the model reran a pruned command again or
  read a pruned file. Together with `pruned/` reads this is the "accesses to
  pruned content per compaction" in the `node scripts/monitor.mjs` report.

## 4. `/jevg fresh`: handoff in the same window

`/jevg fresh [--brief|--nobrief] [focus]` builds the capsule like `getctx`,
then runs `/clear` and attaches the capsule to the next message. Work
continues in the same window with a context of ~14k. If `/clear` fails,
the prompt for the new chat stays in the clipboard.

After `/clear` the engine does not send `session.start`: the same process session
gets a new id. The mod catches this in `session.end` (`reason: clear`) and switches to the new id
on the next hook. This was not the case before, and after `/clear` the ledger and routing state
kept being written to the old session.

The hint now names `/jevg fresh` and is shown in one more case:
a context cache of 300k or more went cold (`handoff.suggestColdAtTokens`), and the next turn
will rewrite it in full anyway.

Not yet verified in the live app: that `$.command.run({ command: 'clear' })`
is available to the mod in the Claude app (in tests it is on a fake engine).

## 5. Overlap with built-in Claude Code mechanisms (verified October 5)

- **Large Bash outputs.** A command with ~1 MB of output: Claude Code saved it to
  the file `~/.claude/projects/<project>/<session>/tool-results/<id>.txt`, and into
  history (and into the mod's `session.append`) went a 2.3 KB preview from the start of the output.
  The threshold is about 30k characters (a 33 KB output also went to a file). So:
  - `trim.hugeChars` (40k) never fires for Bash, trimming
    sees Bash outputs only up to ~30k;
  - the preview has no end of the output, that is, no error lines and no test summary.

  Clarification (checked the same night): only **successful** runs go to a file.
  A failing command (`seq 1 9000; exit 1`) arrived whole in history: "Exit
  code 1", start and end, middle cut out; all 8 saved outputs in
  the transcripts have `is_error=false`. So error lines in a failed
  run are visible anyway.

  What was done: for successful tests, builds and installs the mod reads the saved
  file and puts a short digest in place of the preview (result, summary, warning
  lines, up to ~3k without requests to Jev), instead of a 16k log. The file is taken from
  the engine's call record (`persistedOutputPath`), and the path from the preview text
  only if it is in Claude Code's `tool-results` folder: the preview is the output
  of the command, and a command can forge any path in it. Model reads of these files
  are written to the ledger as `output-read`. Commands run to read something
  (`cat`, `git diff`…) keep the Claude Code preview. The `hugeChars` threshold
  was not changed: it is needed for outputs of other tools (MCP,
  WebFetch).
- **Microcompact on idle** (per search results: since 2.1.284 old tool results
  are replaced with links after ~65 minutes of idle). Not verified:
  needs a large chat left for 70+ minutes and a comparison of the transcript before and
  after. Our idle compaction fires after 60 minutes + 30 seconds, that is,
  earlier; if microcompact is confirmed, compare who prunes what and decide
  whether to keep our own.

## 6. Compaction mid-turn and in subagents (0.2.6)

Analysis of October 6 (data since 0.2.2, ≈ $96 at API prices): subagents cost $42 of
$96 and grew from 29–44k to 300–480k within one task (code researchers reading
files of 40–50 thousand characters whole), compactions in subagents — zero. One turn of the main chat
also grew twice from ~60k to 390–670k. Output is under 3% of subagents' cost:
their context makes them expensive, not effort.

The mod cannot start compaction mid-turn: `$.session.compact` refuses while a
turn is running, and the engine's messages in `turn.step` cannot be changed. But Claude Code itself
compacts both mid-turn and in subagents when the context reaches the autocompact
window, and our `session.compact` hook thins such compaction through Jev, like
its own. The window is set by the official variable `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.

- `compaction.autoWindowTokens` (250000; 0 — Claude Code's own window): at
  session start the mod sets this variable for its process via `$.env.set` and
  remembers its own value in `JEV_GOVERNOR_AUTO_WINDOW`. A variable set
  by you is left alone; the mod updates or removes its own value when the setting
  changes.
- The ledger gets one `window` record per session: what the mod set and what
  Claude Code actually counts from (`tokens`, `source` = `env` if the
  variable took effect). The monitor sums this up in the line "Окно автосжатия" (autocompact window).
- A compaction that Claude Code started on this window is recorded with reason
  `window` (in a subagent — with its `agentId`) and in "Savings" is counted exactly like a
  threshold compaction, in its own cycle: in a subagent — by its requests and at the price
  of a 5-minute write.
- If Jev prunes less than `minReductionRatio` (25%), the Claude Code retelling
  remains, as before at the window limit.

Rough estimate from the October 6 transcripts: a 200–250k window gives the main chat
−25…30% of context cost, subagents −7…13%. This is an upper estimate: verify
with the monitor after a day of work ("Окно автосжатия" (autocompact window), "сжатий в субагентах" (compactions in subagents),
"Контекст на шаг" (context per step)). If Claude Code did not accept the window (`source` is not `env`) or
subagents are still not compacted, the variable does not apply to them: then it is needed in
`env` of `~/.claude/settings.json` (a new process is required).

## What next

- A/B on a long session: one task, continued in the old chat and via
  `/jevg fresh` (metrics: cost until the end of the task and result quality).
