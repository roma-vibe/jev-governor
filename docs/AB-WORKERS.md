# A/B: short-lived workers and roles (0.3.13)

Question: do narrow workers on complete briefs, with a model by role, cost less than the same job in one
long worker, without a drop in quality?

Baseline (monitor §4b, 2026-10-05…13): 226 workers, median 63 steps, 29% over 150 steps = 84% of cost.

## Arms (same task, two clones of the repo, hidden tests kept out of both)
- **A** `agents.brief off`, `agents.delegationGuide false`, `agents.scopeNote false`, `router.roles off`.
- **B** `agents.brief on`, `delegationGuide`/`scopeNote` true, `router.roles on`.
Run each arm on 3 tasks of different kinds (a feature of 5–10 files, a refactor, docs + tests for existing code).

## Measure (scripts/monitor.mjs --since <start>, per arm)
- cost per task (API-eq), workers per task, steps and context per worker, share of cost in workers over 150 steps;
- refusals (`brief` entries with `denied`) and whether the retry was narrower;
- role choices (`roleWould`) and whether lighter models needed `light-up`;
- quality: hidden tests, a diff review by a stronger model, user corrections.

## Decide
Keep `on` if B costs ≥15% less and passes the same hidden tests. If B fails tests only where a role chose
Sonnet/Haiku, raise `roleBriefOk` / lower `rolePStrongMax`, or keep `roles` in `shadow` and only `brief on`.

## Results (2026-10-13, one run per arm)

Cost is API-equivalent, recomputed from transcripts (main chat + subagents). Hidden tests passed in every run, so quality did not differ on these tasks. W3 (five injected bugs) was prepared and verified but not run.

| Task | A control | B brief + scope | C brief + scope + roles |
|---|---|---|---|
| W1, three Rust modules (63 hidden tests) | $4.32, 3 Opus workers, median 9 steps / 83k context | $3.42 (−21%), median 5 steps / 47k | $3.10 (−28%), 2 Sonnet + 1 Opus, median 6 steps / 64k |
| W2, three TS libraries (229 hidden tests) | $1.93, 2 Sonnet + 1 Opus workers | $2.27 (+17%), 3 Sonnet | $2.09 (+8%), 3 Sonnet, roles verdict `standard` ×3 |

Reading: no worker passed 150 steps in any arm, so the case the change targets (long workers) was not exercised. In W2 the control already picked Sonnet, and the briefs cost the parent 5 extra steps. One run per arm cannot separate these differences from noise; repeat before drawing a conclusion.
