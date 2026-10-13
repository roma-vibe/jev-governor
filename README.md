# jev-governor

[English](README.md) · [Русский](README.ru.md)

![version](https://img.shields.io/badge/version-0.3.14-blue)
![Claude Code](https://img.shields.io/badge/Claude_Code-%E2%89%A5%202.1.287-D97757)
![license](https://img.shields.io/badge/license-MIT-green)
![ToS](https://img.shields.io/badge/ToS-white%20zone%20only-brightgreen)
![no proxy](https://img.shields.io/badge/proxy-none-brightgreen)
![no OAuth](https://img.shields.io/badge/OAuth%20tokens-never%20touched-brightgreen)
![platform](https://img.shields.io/badge/platform-macOS-lightgrey)
![node](https://img.shields.io/badge/node-26-339933)
![savings](https://img.shields.io/badge/measured%20saving-17%25%20net%20(real%20use)-orange)

> **White-zone methods only.** This mod uses nothing but the official Claude Code mod mechanism (function hooks inside the unmodified client). No proxy, no `ANTHROPIC_BASE_URL` override, no OAuth token handling, no `claude -p` over a subscription, and nothing that works around a limit or a terms-of-service rule. Every test in this repository, A/B runs included, follows the same rule.

A mod for Claude Code that cuts what a long session costs without lowering the quality of the work. It uses **Jev**, a fast judge model on OpenRouter ($0.042 per million input tokens, ~300 ms), to decide per step how much model each step needs, and to prune old context verbatim instead of summarising it.

Mods shipped in Claude Code 2.1.287. This one uses only that official mechanism: function hooks inside the unmodified client. No proxy, no `ANTHROPIC_BASE_URL`, no OAuth token handling (the mods API has no access to it). Jev is called with your own OpenRouter key.

## What it does

- **Model and effort per turn.** Effort (`low`…`max`) is picked on every turn. Switching to Sonnet 5.5 is priced in dollars: rewriting the context into the other model's cache against what Sonnet saves on output over the next turns (cache reads cost the same on both). Short continuations ("yes", "go on") are decided locally, without asking Jev.
- **Subagents.** Model and effort are chosen per task at spawn. Read-only subagents with an easy task run on Haiku 5.5 (a twentieth of Sonnet's price under a 100K-token prompt, a quarter above) and move up to Sonnet when the task grows or tools keep failing. Generic subagents get the role of a matching specialist; if none exists, one is created (short English prompt and skills, drafted by Sonnet 5.5). Near-copies are not drafted, and existing ones are folded into one once a day in the background, or now with `/jevg agents merge` (or the UI button).
- **Compaction without a summary.** Jev removes stale tool calls and results; the remaining text stays verbatim. It runs when the context reaches 200k (Jev can remove ≥40%), and whenever Claude Code compacts itself. Optionally (off by default, `compaction.onReturn`) also while you are away, once the cache has expired, so that the rewrite on your return is smaller. The mod also sets Claude Code's auto-compact window (`compaction.autoWindowTokens`, 250k) so the engine starts a compaction in the middle of a long turn and inside subagents; those go through Jev too.
- **Old dialog folded.** At every compaction, earlier answers, agent reports, monitor events and long pastes older than the last two turns keep their first lines and a link to a file with the full text (`compaction.fold`). Jev keeps the ones the current work still relies on. On a long real chat this removed 35–67% of the dialog text per compaction.
- **Nothing is lost.** Everything compaction removes is archived to files and the history keeps a pointer; Claude reads it back when it needs an old detail.
- **Large output trimming.** Test, build and install output is cut before it enters history: the outcome, every error line with context, and the summary lines. File reads are left alone.
- **Escalation on facts.** When tool calls fail close together (by default 2 of the last 6 results), the effort goes up for the rest of the turn; scattered failures over a long turn do not count.
- **Limits-aware.** If the 5-hour or weekly window is burning faster than normal, thresholds shift toward saving.
- **Short waits in subagents.** Each subagent task asks to wait for builds no longer than 4 minutes per call: its cache lives 5 minutes, and a longer pause rewrites its whole context.
- **Long-term memory (optional, `memory.*`).** With a memory MCP server ([Mnema](#long-term-memory)) the mod recalls what earlier chats decided and learned, itself and without a model step, and adds a few hundred tokens of notes to the first task of a chat and to subagent tasks, so they find less by reading files. The handoff brief is saved there. `/jevg memory on|off`.
- **Move to a new chat.** `/jevg getctx` builds a compact "capsule" of the chat (brief, work steps, changed files, latest checks); `/jevg fresh` does it in the same window: capsule, `/clear`, capsule attached to your next message.
- **Settings UI.** Vue 3 + Tailwind 4: cost overview with exact and estimated savings, settings, agents, skills, journal, a projects board. English by default, Russian available.
- **Shadow mode.** Decisions are only logged, nothing changes. Use it for an honest with/without comparison.
- **Privacy.** What goes to Jev: the request, a shortened recent history, commands and parts of outputs. Keys, tokens, passwords, private keys and similar strings are replaced with `[secret]` before every request. Projects in the "Projects without Jev" list (`excludeProjects`) send nothing.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DATA.md](docs/DATA.md), [docs/CONTEXT.md](docs/CONTEXT.md), [docs/MONITORING.md](docs/MONITORING.md) (the last two are in Russian).

## How much it saves, honestly

All figures are API-equivalent dollars (list prices, cache reads and writes priced separately) recomputed from Claude Code's own transcripts, not from the mod's journal. They say nothing about your Max/Pro limits, which are not measured.

| Where measured | Without the mod | With the mod | Change | What produced it |
|---|---|---|---|---|
| **Real use, 2026-09-23…10-13** (main chat, cost per step; before/after periods, not a controlled test) | $0.14–0.20 | $0.06–0.075 | **about −50%** | Median context 430k → ~150k. Almost all from the lowered auto-compact window (250k) plus Jev's pruning |
| **Real use, mod's own ledger** (net of Jev and its model calls) | — | $3,599 spent | **$604 saved, 17% of spend** | $601 compaction; trimming $2.6, deferred tools $0.7, folded dialog ≈ 0 |
| **A/B, six small tasks T1–T6** (fastDev, 2026-10-05, one run per arm) | $5.01 | $2.35 | **−53%**, 6 of 6 solved in both arms | Mostly routing easy tasks to Sonnet 5.5 (T1–T3, T5). T4 −5%, T6 +18% |
| **A/B, W1 three-module job via subagents** (2026-10-13) | $4.32 | $3.42 brief / $3.10 brief + roles | **−21% / −28%**, hidden tests pass in all | Shorter workers (median 5 steps, 47k context vs 9 steps, 83k); with roles two of three on Sonnet |
| **A/B, W2 three-library job via subagents** (2026-10-13) | $1.93 | $2.27 brief / $2.09 brief + roles | **+17% / +8%**, hidden tests pass in all | None: the control run already chose Sonnet for two of three workers, and the brief cost the parent extra steps |

How to read it:

- **One mechanism does nearly all of the saving: smaller contexts.** Cache reads are about 61% of the bill, so keeping the context near 150k instead of 430k is what counts. Per-step trimming of tool output, deferring unused tools, folding old dialog and the memory notes together add up to well under 1%.
- **Choosing a cheaper model is a given, not a saving.** You could pick Sonnet yourself, so the UI no longer counts it. The T1–T6 and W1 rows include it, which is why they look larger than the ledger.
- **The subagent changes of 0.3.13 (brief template, size note, roles) are unproven.** One run per arm, two tasks, opposite signs. No worker went past 150 steps, which is the case they target (29% of 226 real workers, 84% of subagent spend). Do not expect a gain from them yet.
- **Not measured:** the effect of the lowered window alone (a plain `CLAUDE_CODE_AUTO_COMPACT_WINDOW` against Jev's pruning), quality over weeks (14–17% of turns are user corrections with or without it), and real limit use.

Run an A/B on one of your own tasks, with and without the mod, before trusting any of these numbers. The plan and scripts are in [docs/AB-WORKERS.md](docs/AB-WORKERS.md).

## Install

Requires Claude Code 2.1.287 or newer (2.1.286 with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`). A recent Node (it runs the TypeScript files directly; developed on Node 26) for the UI and scripts. macOS only for now: the projects board opens Terminal.app and uses `pbcopy`/`osascript`; the core (routing, compaction, trimming) does not depend on the OS but is untested elsewhere.

```bash
git clone https://github.com/roma-vibe/jev-governor.git
cd jev-governor
npm install
```

1. Put your OpenRouter key in `~/.claude/jev-governor/openrouter.key`, or in `OPENROUTER_API_KEY`, or save it from the UI (Settings).
2. Load the mod in every session through `env` in `~/.claude/settings.json`:

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/jev-governor"
     }
   }
   ```

   For a one-off check: `claude --plugin-dir /absolute/path/to/jev-governor`.
3. Start a new session. After the first reply the status line shows `jev ▸ model·effort │ 5h N% · 7d M%`. No such line means the mod did not load; `npm run validate` shows why. `jev ✕` means Jev has not answered several times in a row; the mod then changes nothing and Claude Code behaves as without it.

Mods run with your permissions and are not sandboxed: read the code before you enable one. Everything this mod sends out goes to `openrouter.ai` with your key.

## Commands

- `/jevg`: status (key, last decision, limits, agents)
- `/jevg on` / `/jevg off`: enable or disable the mod
- `/jevg chat on|off`: switch the mod off (or back on) for this chat only; nothing is routed, trimmed, compacted or sent to Jev there. Remembered for the chat, also after a restart or resume
- `/jevg idle on|off`: compact this chat after a pause (cache expired) even though the setting `compaction.onReturn` is off
- `/jevg ui`: start the settings UI in the background (http://127.0.0.1:4777)
- `/jevg reload`: re-read config, key and the agent registry
- `/jevg fresh [--brief|--nobrief] [focus]`: continue in this window with a clean chat
- `/jevg getctx [--brief|--nobrief] [focus]`: a compact context of this chat for a new one (prompt copied to the clipboard)
- `/jevg ctx [list|<id>]`: in a new chat, attach a project capsule to the next message
- `/jevg agents [merge]`: the specialists (on, merged, retired, most used); `merge` folds near-copies into one now
- `/jevg memory [on|off|start]`: long-term memory: its state and the server's, switch it, start the local server

The mod's own messages (chat notices, toasts, command replies) and the UI come in English and Russian. Setting `ui.language`: `auto` (default) follows the language set in Claude Code (`language` in `~/.claude/settings.json`), then the system language; `en` or `ru` forces one.

## Long-term memory

Optional, off by default. The mod talks to a memory MCP server (Mnema) through Claude Code's own connection:

- **First task of a chat:** the mod runs `recall` on it and adds the notes as hidden context (a few hundred tokens; nothing when nothing relevant is stored). Not when a capsule is attached, which already carries the context.
- **Subagents:** a subagent with a real task (`memory.subagentMinChars`) gets the notes appended to its prompt; the recall runs while the model is chosen.
- **Handoff:** the brief of `/jevg getctx` / `/jevg fresh` is saved with `save_session`, in the background.
- **Facts from the dialog (`memory.autoSave`, on):** every `memory.autoSaveEveryTurns` (6) finished turns and after `memory.autoSaveIdleMinutes` (3) of quiet, the mod reads the turns not read yet (what you typed and the model's last message of each turn, never tool output; secrets are cut) with `memory.autoSaveModel` (Haiku 5.5), shown the facts already stored. It offers at most `memory.autoSaveMaxFacts` (3) durable facts: decisions and their reasons, conventions, traps, how to build or release. Progress, plans and descriptions of code are not facts. A second pass on `memory.autoSaveCheckModel` (Sonnet 5.5, only when something was offered) drops what is doubtful, the filter drops repeats, progress wording and anything with a secret, and the memory server refuses a fact it has. Most readings save nothing. Saved facts carry the tag `auto` (find them with `list_facts`, remove with `forget_fact`). `/jevg memory save` reads now and shows what was saved. Not in excluded projects or shadow mode; a chat closed within a few turns of its last reading loses those turns.
- **The model's own calls:** allowed (`memory.modelTools`), except `recall` (`memory.modelRecall`, off): the mod already recalls at the start of a chat and for subagents, and the server asks every subagent to recall again, a step over the whole context that mostly returns nothing. `save_fact`, `search` and the rest stay. Off `modelTools`, all the memory tools are refused.
- **Failures cost one timeout:** `memory.timeoutMs` (2.5 s), then the memory is left alone for a minute. A server that does not answer is started (`scripts/mnema-local.sh start`, at most every 10 minutes).

Set up locally (once):

```bash
scripts/mnema-local.sh start
```

```bash
~/Documents/mnema-mcp/.venv/bin/mnema-mcp configure --api-key "$(scripts/mnema-local.sh key claude-code)" --base-url http://127.0.0.1:8787
```

```bash
claude mcp add mnema-memory --scope user -- ~/Documents/mnema-mcp/.venv/bin/mnema-mcp
```

Then `/jevg memory on`. `mnema-mcp doctor` checks the chain; `node scripts/monitor.mjs` reports recalls, facts added, failures and the model's own memory calls (section 6). `scripts/mnema-local.sh` runs the server on real models through OpenRouter when `.openrouter_key` (or `OPENROUTER_API_KEY`) exists: `recall` then matches by meaning (about 0.5 s; texts of facts and tasks go to OpenRouter). Without a key it falls back to the offline mock, where `recall` matches only shared words. After switching, `scripts/mnema-local.sh reembed` embeds the facts saved earlier.

## UI

```bash
npm run ui:install
npm run ui:build
npm run ui
```

## Data

`~/.claude/jev-governor/` (override with `JEV_GOVERNOR_HOME`): `config.json`, `agents/`, `skills/`, `drafts/`, `ledger/` (decisions and token usage), archives of removed output. Formats: [docs/DATA.md](docs/DATA.md).

## Monitoring

```bash
node scripts/monitor.mjs --since v0.2.6
```

Prints a report from the mod's journal and Claude Code's transcripts: context per step, compaction counts and how often the model needed something that was removed, routing, cost, and what to change. See [docs/MONITORING.md](docs/MONITORING.md).

## Development

```bash
npm test
npm run typecheck
npm run validate
sh scripts/install-hooks.sh
```

The pre-commit hook checks, on what is staged, that the engine loads the mod, the types and the tests.

## Limits

- Claude only; a provider abstraction for Codex exists (`hooks/lib/providers.ts`) but is not implemented.
- Function hooks are new and the API may change between versions; types were checked against 2.1.286/2.1.287.
- A specialist agent reaches the subagent as a role at the start of its task; the tool restriction on the agent card is not applied.
- Each subagent costs about 45k tokens of cache write at start: small tasks are cheaper without one.

## Credits and license

MIT. The compaction library is adapted from [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT).
