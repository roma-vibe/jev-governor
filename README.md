# jev-governor

[English](README.md) · [Русский](README.ru.md)

A mod for Claude Code that cuts what a long session costs without lowering the quality of the work. It uses **Jev**, a fast judge model on OpenRouter ($0.042 per million input tokens, ~300 ms), to decide per step how much model each step needs, and to prune old context verbatim instead of summarising it.

Mods shipped in Claude Code 2.1.287. This one uses only that official mechanism: function hooks inside the unmodified client. No proxy, no `ANTHROPIC_BASE_URL`, no OAuth token handling (the mods API has no access to it). Jev is called with your own OpenRouter key.

## What it does

- **Model and effort per turn.** Effort (`low`…`max`) is picked on every turn. Switching to Sonnet 5.5 is priced in dollars: rewriting the context into the other model's cache against what Sonnet saves on output over the next turns (cache reads cost the same on both). Short continuations ("yes", "go on") are decided locally, without asking Jev.
- **Subagents.** Model and effort are chosen per task at spawn. Read-only subagents with an easy task can run on Haiku (half the cache-read price; off by default in "shadow" mode, which only records what it would choose) and move up to Sonnet when the task grows. Generic subagents get the role of a matching specialist; if none exists, one is created (short English prompt and skills, drafted by Sonnet 5.5).
- **Compaction without a summary.** Jev removes stale tool calls and results; the remaining text stays verbatim. It runs when the context reaches 200k (Jev can remove ≥40%), and whenever Claude Code compacts itself. Optionally (off by default, `compaction.onReturn`) also while you are away, once the cache has expired, so that the rewrite on your return is smaller. The mod also sets Claude Code's auto-compact window (`compaction.autoWindowTokens`, 250k) so the engine starts a compaction in the middle of a long turn and inside subagents; those go through Jev too.
- **Nothing is lost.** Everything compaction removes is archived to files and the history keeps a pointer; Claude reads it back when it needs an old detail.
- **Large output trimming.** Test, build and install output is cut before it enters history: the outcome, every error line with context, and the summary lines. File reads are left alone.
- **Escalation on facts.** After repeated tool errors the effort goes up for the rest of the turn.
- **Limits-aware.** If the 5-hour or weekly window is burning faster than normal, thresholds shift toward saving.
- **Short waits in subagents.** Each subagent task asks to wait for builds no longer than 4 minutes per call: its cache lives 5 minutes, and a longer pause rewrites its whole context.
- **Move to a new chat.** `/jevg getctx` builds a compact "capsule" of the chat (brief, work steps, changed files, latest checks); `/jevg fresh` does it in the same window: capsule, `/clear`, capsule attached to your next message.
- **Settings UI.** Vue 3 + Tailwind 4: cost overview with exact and estimated savings, settings, agents, skills, journal, a projects board. English by default, Russian available.
- **Shadow mode.** Decisions are only logged, nothing changes. Use it for an honest with/without comparison.
- **Privacy.** What goes to Jev: the request, a shortened recent history, commands and parts of outputs. Keys, tokens, passwords, private keys and similar strings are replaced with `[secret]` before every request. Projects in the "Projects without Jev" list (`excludeProjects`) send nothing.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DATA.md](docs/DATA.md), [docs/CONTEXT.md](docs/CONTEXT.md), [docs/MONITORING.md](docs/MONITORING.md) (the last two are in Russian).

## How much it saves, honestly

The UI shows two numbers: **exact** (computed from the journal: tokens a compaction or trim removed × the requests that would have re-read them from the cache, minus the cache rewrite it caused, plus model price differences) and **estimated** (the effort lever, a rule of thumb). In our own use over one day of mixed work it came to roughly 7–13% of the API-equivalent spend; on long single-task sessions with big contexts it was far higher in A/B runs (~60%). It does not know what you would have spent without it, so treat the numbers as a lower bound, and run your own A/B on one task with and without the mod before you trust them.

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
