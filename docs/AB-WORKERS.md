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

Cost is API-equivalent, recomputed from transcripts (main chat + subagents). Hidden tests passed in every run, so quality did not differ on these tasks. 

| Task | A control | B brief + scope | C brief + scope + roles |
|---|---|---|---|
| W1, three Rust modules (63 hidden tests) | $4.32, 3 Opus workers, median 9 steps / 83k context | $3.42 (−21%), median 5 steps / 47k | $3.10 (−28%), 2 Sonnet + 1 Opus, median 6 steps / 64k |
| W2, three TS libraries (229 hidden tests) | $1.93, 2 Sonnet + 1 Opus workers | $2.27 (+17%), 3 Sonnet | $2.09 (+8%), 3 Sonnet, roles verdict `standard` ×3 |

Reading: no worker passed 150 steps in any arm, so the case the change targets (long workers) was not exercised. In W2 the control already picked Sonnet, and the briefs cost the parent 5 extra steps. One run per arm cannot separate these differences from noise; repeat before drawing a conclusion.

**W3, five injected bugs (2026-10-15, 18 hidden tests):** A $2.26 (5 Sonnet workers), B $1.86 (−18%; three workers, one of them Haiku fixed bugs 1, 2 and 5 and passed), C $2.10 (−7%; 5 Sonnet workers, roles `standard` ×5). All hidden tests passed. W1+W2+W3 together: A $8.51, B $7.55 (−11%), C $7.29 (−14%). Still one run per arm, no worker over 150 steps.
