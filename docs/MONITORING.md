# Monitoring the first days in active mode

Since October 5, 2026 (evening) the mod runs in **active** mode in all chats:
- model and effort selection;
- specialist subagents;
- trimming of large outputs;
- compaction through Jev with an archive of pruned content;
- `/jevg getctx`;
- new chat hint.

The plan is simple: you use it as usual, the data is written automatically, and after a day I put together a report.

## Where the data comes from

Nothing extra needs to be enabled, everything is already written.

- **Mod ledger** `~/.claude/jev-governor/ledger/<day>/<session>.jsonl`. Records:
  - decisions on each turn (`turn`) and tokens (`usage`);
  - compactions (`compact`, with the number of calls in the archive);
  - trims (`trim`) and reads of saved content (`output-read`);
  - capsules and their attachments (`handoff`, with the reason if there was no brief);
  - hints (`hint`) and errors (`error`).
- **Claude Code transcripts** `~/.claude/projects/*/<session>.jsonl` — the real context size at each step. I also use them for comparison with previous weeks: median context 430k, cache read 61% of cost.
- **Limit pace** 5h/7d — a snapshot in every `turn` and `usage` record.

## What I will check after a day

The report on the questions below is produced by `scripts/monitor.mjs`:

```bash
node scripts/monitor.mjs --days 1
```

`--since 2026-10-05` takes everything from that date, `--since 2026-10-06T09:13` — from that minute, `--since v0.2.2` — from when the version landed in `main` (by git; the live mod is loaded from `main`), so that the old version is not mixed with the new one; `--data` and `--projects` change the ledger and transcript folders; `--help` prints usage. At the end of the report are conclusions: which thresholds to change. Besides the questions below, it counts:
- sessions without a mod ledger (the mod did not load; should be 0);
- `turn` and `usage` records without the `baseModel` / `baseEffort` baseline (savings for them are based on an assumption);
- user corrections after Sonnet and Opus, after low/medium and high (the `correction` question), your `/model` and effort changes (`override`);
- accesses to pruned content per compaction: `pruned/` reads and reruns (`rerun-after-prune`); reads of Claude Code's saved outputs (`tool-results/`) are separate, not counted;
- compaction started via `/compact` in the app (`compaction.via`);
- sessions that never got the auto-compaction window (no `window` record: bound before 0.2.6 and never reloaded) and sessions on an older mod version (`v` in the ledger, since 0.3.2);
- ledger files at the 5000-line limit;
- secret replacements in requests to Jev (`redacted`);
- subagent context, spend across all transcript steps (main dialogue and subagents separately) and subagent cache rebuilds after pauses longer than 5 minutes;
- turns and subagents without Jev: fallback effort and repeated requests.

1. **Did the context get smaller.**
   - Metric: median context per step and the share of steps above 200k, before and after.
   - Good if the median is noticeably below 430k.
2. **Compaction helps and does not hurt.**
   - Metrics: number of compactions (applied, skipped, fallback to the Claude Code retelling), average share pruned, `pruned/` reads per compaction.
   - If the model often goes into the archive (more than ~1 time per compaction), Jev prunes what is needed: raise the keep threshold.
   - If almost never, compaction can be done earlier.
   - Check: every applied compaction has `compaction.archived` in its `compact` record, and files lie in `outputs/<session>/pruned/`. The compaction of this chat on October 5 (95%, 191 calls) was recorded without `archived` and without an archive: this chat ran on mod code from before the merge (`/jevg` in it showed the old output without `getctx`). Make sure the archive is written in new chats.
3. **Routing.**
   - Metrics: share of Sonnet and Opus, effort distribution, model switches on a warm cache (expensive), your manual `/model` (disagreement with the router), escalations after errors.
4. **Handoff to a new chat.**
   - Metrics: how many `getctx` there were, with or without a brief and why, whether the capsule attached, its size against the old chat's context, the new chat's context on the first steps.
5. **New chat hint.**
   - Metrics: how many times shown, how many times `getctx` followed it, ones that look false (by request text).
6. **Spend.**
   - Metrics: limit pace 5h/7d, Jev spend per day, API equivalent against previous weeks.
7. **Errors.**
   - Metrics: `error` records by kind — Jev timeouts, archive, capsules, compaction fallbacks, mod code reloads.

The report will come in chat with conclusions: what to keep, which thresholds to change, what to turn off.

## Turning on and off

Changes apply from the next turn, without restarting chats.

- **Everything at once:** the "Enabled" badge in the UI (http://127.0.0.1:4777) or `/jevg off` / `/jevg on` in any chat.
- **Observe only** (decisions are written, nothing changes): Settings → General → Mode.
- **Piece by piece** (Settings):
  - compaction: "Compact through Jev", "Save removed content to an archive";
  - handoff: "Context handoff to a new chat", the hint ("Suggest a new chat at context from" = 0 — turn off);
  - "Trimming large outputs";
  - model, effort and subagent selection — in the "Main chat" and "Subagents" sections.
- **Check what is enabled, in any chat:** `/jevg`.

## Your part

- Work as usual. Try `/jevg getctx` at least once on a large chat and continue in a new one.
- If something seemed off, a short note "when and in which project" is enough. For example: a strange model, a detail lost after compaction, the capsule did not attach, an unneeded hint. I will find that turn in the ledger.
- Already open chats pick up the new code on their own. If `/jevg` in an old chat does not show `getctx`, open a new chat.
