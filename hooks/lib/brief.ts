// Short-lived workers: what a subagent is told, what its brief is judged on, and
// which model a role gets. $-free so it can be unit-tested; register.ts does the I/O.
//
// Why: a subagent's cost is its context carried over its steps, not its model price.
// Replay of 84 writing subagents (2026-10-05…13): 479 steps on average at ~217k tokens,
// cache reads 61% and cache writes 35% of their cost; Sonnet instead of Opus saved only
// ~20% (cache reads cost the same). Several narrow workers of ~100 steps at 60–100k
// tokens are what moves the cost, and a narrow worker only does well on a complete brief.

import { choice, noul, score, type JevAnswer, type JevQuestions } from './jev.ts';
import type { Decision } from './router.ts';
import { EFFORTS, type GovernorConfig } from './types.ts';

/**
 * Added to the Agent tool's description (once per session, cached with the tool list): the
 * parent writes the brief. A subagent starts with nothing but this prompt.
 */
export const DELEGATION_GUIDE = `

Writing the prompt (jev-governor): the subagent starts with nothing but this prompt, and one that runs for hundreds of steps carries a huge context, which is where the cost is. Write it as a brief and keep the job narrow:
- Goal: the one deliverable, in a sentence.
- Where: exact files or directories to read and to change, and what not to touch.
- What it cannot guess: decisions already made, interfaces to match, the commands that build and test.
- Done when: a check it can run, and the result to expect.
- Report: what to return (changed files, results, open questions), short.
Prefer several narrow subagents (a few files each, ~100 steps) over one that builds a whole feature, each with its own brief. A complete brief lets a smaller model do the work; a vague one does not.`;

/** Appended to a worker's task: stay narrow, keep files small, read ranges. */
export function scopeNote(fileLines: number): string {
  return `<scope-note>Work narrowly: touch only what the task names. If it turns out larger than described, finish the part you can and report what remains instead of widening it. Write code in small files, one responsibility each, under about ${fileLines} lines; split a bigger file when you create or change it. To read a long file, find the place with grep -n and read only that range (Read with offset and limit) rather than the whole file. Keep the final report short.</scope-note>`;
}

export function withScopeNote(prompt: string, fileLines: number): string {
  return prompt.includes('<scope-note>') ? prompt : `${prompt}\n\n${scopeNote(fileLines)}`;
}

const STEPS_LEGEND = [
  '0: a few tool calls (under 15)',
  '1: a small job (15 to 50 tool calls)',
  '2: a medium job (50 to 150 tool calls)',
  '3: a large job (150 to 400 tool calls)',
  '4: a very large build (over 400 tool calls)',
];
/** Midpoints of STEPS_LEGEND, to turn the expected level into a number of steps. */
const STEPS_AT = [8, 30, 90, 250, 600];

export const ROLES = {
  plan_review: 'planning, design, architecture, code review, security or risk analysis',
  implement: 'writing or changing code according to a clear spec or plan',
  docs_tests: 'documentation, comments, changelogs, translations, or simple tests and boilerplate that follow existing patterns',
} as const;
export type Role = keyof typeof ROLES;

const ROLE_QUESTION = 'What kind of work is the main part of `task`?';

function roleCriteria(order: readonly Role[]): Record<string, string> {
  return Object.fromEntries(order.map((r) => [r, ROLES[r]]));
}

export function briefQuestions(): JevQuestions {
  return {
    brief_complete: {
      type: 'noul',
      instructions:
        '`task` is a complete brief: it states the goal, the files or areas to touch, the constraints and how to tell the work is done, so a fresh assistant with no other context could start at once',
    },
    too_big: {
      type: 'noul',
      instructions:
        '`task` bundles several separate deliverables or a large build: one assistant would need hundreds of steps and a very large context, and it would be better split into narrow tasks of a few files each',
    },
    steps: {
      type: 'score',
      instructions: 'How many tool calls will a capable assistant need to finish `task`?',
      criteria: STEPS_LEGEND,
    },
    role_a: { type: 'choice', instructions: ROLE_QUESTION, criteria: roleCriteria(['plan_review', 'implement', 'docs_tests']) },
    role_b: { type: 'choice', instructions: ROLE_QUESTION, criteria: roleCriteria(['docs_tests', 'implement', 'plan_review']) },
  };
}

export type BriefSignals = {
  /** P(the task text is a complete brief). */
  complete: number;
  /** P(the task bundles too much for one worker). */
  tooBig: number;
  /** Expected tool calls (from the level Jev expects). */
  steps?: number;
  /** Mean P(role) over both option orders. */
  roles: Record<Role, number>;
  /** The most likely role and its probability. */
  role: Role;
  roleP: number;
};

export function readBrief(answers: Record<string, JevAnswer>): BriefSignals | undefined {
  const complete = noul(answers, 'brief_complete');
  const tooBig = noul(answers, 'too_big');
  if (complete === undefined && tooBig === undefined) return undefined;
  const roles = { plan_review: 0, implement: 0, docs_tests: 0 } as Record<Role, number>;
  let seen = 0;
  for (const name of ['role_a', 'role_b']) {
    const answer = choice(answers, name);
    if (!answer) continue;
    seen++;
    for (const r of Object.keys(roles) as Role[]) {
      const p = answer.probabilities[r];
      if (typeof p === 'number' && Number.isFinite(p)) roles[r] += p;
    }
  }
  if (seen > 0) for (const r of Object.keys(roles) as Role[]) roles[r] /= seen;
  const top = (Object.keys(roles) as Role[]).reduce((a, b) => (roles[b] > roles[a] ? b : a));
  const level = score(answers, 'steps');
  const steps = level ? STEPS_AT[Math.min(4, Math.max(0, Math.round(level.expected)))] : undefined;
  return {
    complete: complete ?? 0.5,
    tooBig: tooBig ?? 0,
    ...(steps !== undefined ? { steps } : {}),
    roles,
    role: top,
    roleP: roles[top],
  };
}

export type BriefVerdict = 'ok' | 'weak' | 'big';

/** What the brief looks like: too big for one worker, too thin for a smaller model, or fine. */
export function briefVerdict(b: BriefSignals, cfg: GovernorConfig, lowerModel: boolean): BriefVerdict {
  const a = cfg.agents;
  if (b.tooBig >= a.tooBigAt && (b.steps ?? 0) >= a.bigSteps) return 'big';
  if (lowerModel && b.complete < a.briefWeakAt) return 'weak';
  return 'ok';
}

/** The refusal text the parent reads: what is wrong, what to change, and that the retry goes through. */
export function denyText(verdict: Exclude<BriefVerdict, 'ok'>, b: BriefSignals): string {
  const head =
    verdict === 'big'
      ? `This task looks too large for one subagent (about ${b.steps ?? '100+'} tool calls expected, P(too big) ${b.tooBig.toFixed(2)}): its context would grow for hundreds of steps and cost most of the budget. Split it into narrow subagents of a few files each, every one with its own brief.`
      : `This brief is too thin for a smaller model (P(complete) ${b.complete.toFixed(2)}): it will run on a lighter model than yours, which does well only with a complete brief.`;
  return `${head}${DELEGATION_GUIDE}\n\n(Sent once per task: spawning the same task again goes through as it is.)`;
}

export type RoleChange = {
  decision: Decision;
  /** What the role chose: the tier (and light) it asks for; `none` when it left the decision alone. */
  would: 'none' | 'strong' | 'standard' | 'light';
  reasons: string[];
};

export type RoleContext = {
  /** The agent or the agent type pins the tier. */
  pinnedTier: boolean;
  /** Jev's P(needs Opus) for the task. */
  pStrong: number;
  /** Jev's P(risky). */
  risky: number;
};

/**
 * Role-based model choice: planning, review and security stay on the strong tier; implementing a
 * complete brief goes to the standard tier; documentation and simple tests to the light model.
 * Only with a complete brief and no risk, and never above `rolePStrongMax`, where Jev itself is
 * sure Opus is needed. Returns the decision unchanged (and `would: none`) otherwise.
 */
export function applyRole(decision: Decision, b: BriefSignals, ctx: RoleContext, cfg: GovernorConfig): RoleChange {
  const r = cfg.router;
  const unchanged: RoleChange = { decision, would: 'none', reasons: [] };
  if (r.roles === 'off' || ctx.pinnedTier || b.roleP < r.roleAt) return unchanged;
  const tag = `role ${b.role} (${b.roleP.toFixed(2)})`;
  if (b.role === 'plan_review') {
    if (decision.tier === 'strong') return { ...unchanged, would: 'strong', reasons: [`${tag}: stays on the strong tier`] };
    return { decision: { ...decision, tier: 'strong', light: false }, would: 'strong', reasons: [`${tag}: strong tier`] };
  }
  if (decision.tier === 'standard' && !decision.light && b.role === 'implement') return { ...unchanged, would: 'standard', reasons: [`${tag}: standard tier`] };
  if (ctx.risky >= r.riskyAt) return { ...unchanged, reasons: [`${tag}: kept, risky`] };
  if (b.complete < r.roleBriefOk) return { ...unchanged, reasons: [`${tag}: kept, brief ${b.complete.toFixed(2)} < ${r.roleBriefOk}`] };
  if (ctx.pStrong >= r.rolePStrongMax) return { ...unchanged, reasons: [`${tag}: kept, P(opus) ${ctx.pStrong.toFixed(2)}`] };
  const light = b.role === 'docs_tests' && r.lightSubagents !== 'off' && EFFORTS.indexOf(decision.effort) <= EFFORTS.indexOf('high');
  const next: Decision = { ...decision, tier: 'standard', ...(light ? { light: true } : { light: false }) };
  return {
    decision: next,
    would: light ? 'light' : 'standard',
    reasons: [`${tag}: ${light ? 'light model' : 'standard tier'}, brief ${b.complete.toFixed(2)}`],
  };
}
