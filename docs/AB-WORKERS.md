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
