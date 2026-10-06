// The routing policy: which questions Jev is asked and how its answers turn
// into a tier (Sonnet 5.5 / Opus 5.5) and an effort level. Pure: no engine
// interface, no I/O.
//
// The physics it follows:
// - Each model has its own prompt cache, so moving the main conversation to
//   another model re-reads the whole context uncached. The main model only
//   changes where that is free (no warm cache: session start, after a
//   compaction, after idling past the cache TTL) or cheap (small context),
//   except for a confident upgrade, where quality wins.
// - Effort changes keep the cache on Opus 5.5 / Sonnet 5.5, so effort is the
//   per-turn dial.
// - A subagent starts with an empty context, so its model is free to choose.
// - Asymmetric thresholds: upgrading for quality is easy, downgrading needs
//   confidence. Low budget pressure never forces a downgrade.

import type { Pressure } from './budget.ts';
import { choice, noul, score, type JevAnswer, type JevQuestions } from './jev.ts';
import { familyOf, PRICES } from './savings.ts';
import { EFFORTS, type Effort, type GovernorConfig, type Tier } from './types.ts';

export const TIER_CRITERIA: Record<Tier, string> = {
  standard:
    'Sonnet 5.5 is enough: routine coding with clear requirements, edits in one area, running tests or commands, searching code, explanations, refactors following an obvious pattern, small fixes with a known cause',
  strong:
    'Needs Opus 5.5: debugging with an unclear root cause, architecture or design decisions, subtle concurrency, security or data-integrity issues, large multi-module changes, ambiguous or conflicting requirements, work where a wrong answer is expensive',
};

export const EFFORT_CRITERIA = [
  'low: conversational reply, lookup, status check or a purely mechanical edit',
  'medium: routine change with a clear spec in one or two files',
  'high: debugging or a multi-file change that needs careful step-by-step reasoning',
  'xhigh: hard, subtle bug or design work spanning many files',
  'max: exceptionally hard novel problem where mistakes are very costly',
];

const TIER_QUESTION =
  'Which model is the cheapest one that will still complete the task correctly on the first try?';

/** Tier asked in both option orders (Jev leans toward the first option). */
function tierQuestions(subject: string): JevQuestions {
  const instructions = `${TIER_QUESTION} The task is ${subject}.`;
  return {
    tier_a: {
      type: 'choice',
      instructions,
      criteria: { standard: TIER_CRITERIA.standard, strong: TIER_CRITERIA.strong },
    },
    tier_b: {
      type: 'choice',
      instructions,
      criteria: { strong: TIER_CRITERIA.strong, standard: TIER_CRITERIA.standard },
    },
  };
}

function effortQuestion(subject: string): JevQuestions {
  return {
    effort: {
      type: 'score',
      instructions: `How much reasoning effort does ${subject} need to be done correctly on the first try?`,
      criteria: EFFORT_CRITERIA,
    },
  };
}

const RISKY: JevQuestions = {
  risky: {
    type: 'noul',
    instructions:
      'The task touches something costly to get wrong: data loss, security, credentials, money, production deploys, database migrations, or breaking a public API',
  },
};

export function mainQuestions(): JevQuestions {
  return {
    ...tierQuestions('latest_user_request, done by the assistant in this conversation'),
    ...effortQuestion('the next assistant turn on latest_user_request'),
    ...RISKY,
    continuation: {
      type: 'noul',
      instructions:
        "latest_user_request is a short follow-up such as 'yes', 'go on', 'continue', 'do it' or 'try again' whose meaning comes from the earlier conversation",
    },
    new_topic: {
      type: 'noul',
      instructions:
        'latest_user_request starts a new, separate task: doing it well does not need the earlier conversation (its files, decisions or results)',
    },
    correction: {
      type: 'noul',
      instructions:
        "latest_user_request says the assistant's previous answer or work was wrong, incomplete or not what was asked (a correction or complaint about it)",
    },
  };
}

export function subagentQuestions(): JevQuestions {
  return {
    ...tierQuestions('the subagent task'),
    ...effortQuestion('the subagent task'),
    ...RISKY,
  };
}

export const MAIN_STATE_CONTEXT =
  'Routing for a Claude Code coding session. Judge only what the next assistant turn needs to complete latest_user_request correctly on the first try. recent_conversation is abridged, oldest first.';

export const SUBAGENT_STATE_CONTEXT =
  'Routing for a Claude Code subagent: a fresh assistant that gets only `task` and must complete it on its own and report back.';

export type Signals = {
  /** Mean P(strong) over both option orders. */
  pStrong: number;
  effortExpected?: number;
  effortConfidence: number;
  risky: number;
  continuation: number;
  /** P(the request starts a new task the earlier conversation is not needed for); 0 when not asked. */
  newTopic: number;
  /** P(the request corrects the previous answer: it was wrong or incomplete); 0 when not asked. */
  correction?: number;
};

export function readSignals(answers: Record<string, JevAnswer>): Signals | undefined {
  const tiers = [choice(answers, 'tier_a'), choice(answers, 'tier_b')]
    .map((answer) => answer?.probabilities.strong)
    .filter((p): p is number => typeof p === 'number' && Number.isFinite(p));
  if (tiers.length === 0) return undefined;
  const effort = score(answers, 'effort');
  return {
    pStrong: tiers.reduce((sum, p) => sum + p, 0) / tiers.length,
    effortExpected: effort?.expected,
    effortConfidence: effort?.confidence ?? 0,
    risky: noul(answers, 'risky') ?? 0,
    continuation: noul(answers, 'continuation') ?? 0,
    newTopic: noul(answers, 'new_topic') ?? 0,
    correction: noul(answers, 'correction') ?? 0,
  };
}

/** Words a bare "go on" is made of (Russian and English). */
const FOLLOW_UP_WORDS = new Set([
  'да', 'ок', 'окей', 'ага', 'угу', 'го', 'гоу', 'давай', 'давайте', 'продолжай', 'продолжи', 'продолжаем', 'дальше',
  'делай', 'сделай', 'ну', 'ладно', 'хорошо', 'отлично', 'супер', 'пожалуйста', 'плиз', 'вперёд', 'вперед', 'запускай',
  'yes', 'y', 'yep', 'yeah', 'ok', 'okay', 'sure', 'go', 'on', 'ahead', 'continue', 'proceed', 'do', 'it', 'please',
  'next', 'fine', 'great', 'good',
]);
/** Words that are a follow-up only with another one ("go on", "do it"), not alone. */
const NOT_ALONE = new Set(['on', 'it', 'do', 'ну', 'ahead', 'please', 'пожалуйста', 'плиз']);

/**
 * A short follow-up ("да", "ок", "давай", "продолжай", "go on", "do it")
 * whose meaning is the earlier conversation: decided locally, without Jev
 * (no delay, nothing sent out), by keeping the previous decision.
 */
export function isShortFollowUp(text: string): boolean {
  // "да?" or "ok?" is a doubt, not a go-on.
  if (text.includes('?')) return false;
  const t = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 30) return false;
  const words = t.split(' ');
  if (words.length === 1 && NOT_ALONE.has(words[0]!)) return false;
  return words.length <= 4 && words.every((w) => FOLLOW_UP_WORDS.has(w));
}

/** Extra P(strong) needed to upgrade, per pressure level. */
const UPGRADE_PENALTY = [0, 0.05, 0.15, 0.3] as const;
/** P(standard) bonus toward a downgrade, per pressure level. */
const DOWNGRADE_BONUS = [0, 0.05, 0.1, 0.2] as const;
/**
 * Added to Jev's expected effort level before rounding: between two levels,
 * pick the higher one (quality first).
 */
const EFFORT_BIAS = 0.15;
/** Highest effort allowed per pressure level (before the risky floor). */
const EFFORT_CAP: readonly Effort[] = ['max', 'max', 'high', 'medium'];

export function effortIndex(effort: Effort): number {
  return EFFORTS.indexOf(effort);
}

function clampEffort(index: number, config: GovernorConfig): Effort {
  const min = effortIndex(config.router.minEffort);
  const max = effortIndex(config.router.maxEffort);
  return EFFORTS[Math.min(max, Math.max(min, Math.round(index)))]!;
}

export function chooseEffort(
  signals: Signals,
  pressure: Pressure,
  config: GovernorConfig,
  reasons: string[],
  fallback?: Effort,
): Effort {
  let index: number;
  if (signals.effortExpected !== undefined && signals.effortConfidence >= config.router.effortConfidenceAt) {
    index = Math.round(signals.effortExpected + EFFORT_BIAS);
  } else {
    index = effortIndex(fallback ?? config.router.defaultEffort);
    reasons.push('effort: Jev unsure, default');
  }
  const cap = effortIndex(EFFORT_CAP[pressure]!);
  if (index > cap) {
    index = cap;
    reasons.push(`effort capped by budget pressure ${pressure}`);
  }
  if (signals.risky >= config.router.riskyAt && index < effortIndex('high')) {
    index = effortIndex('high');
    reasons.push('risky: effort ≥ high');
  }
  return clampEffort(index, config);
}

/** Escalates an effort by `steps` levels, within the configured bounds. */
export function escalate(effort: Effort, steps: number, config: GovernorConfig): Effort {
  return clampEffort(effortIndex(effort) + steps, config);
}

export type Decision = {
  tier: Tier;
  effort: Effort;
  /** Leave the request's own effort alone (nothing to judge the turn by). */
  keepEffort?: boolean;
  switched: boolean;
  reasons: string[];
};

export type MainContext = {
  currentTier: Tier;
  /** No warm cache to lose: first request, after compaction, after idling past the TTL. */
  freeSwitch: boolean;
  contextTokens?: number;
  pressure: Pressure;
  previous?: { tier: Tier; effort: Effort };
  /** What a turn of this session usually spends (learned from its usage); defaults otherwise. */
  turnProfile?: TurnProfile;
};

/** A typical main turn: tokens it outputs and newly writes to the cache. */
export type TurnProfile = { output: number; cacheWrite: number };

/**
 * A main turn until the session's own is learned: on purpose below the ledger's medians of
 * 2026-10-05 (output 4.4k, cache write 22k; means on warm turns 15k / 44k). A smaller turn is a
 * smaller gain per turn from Sonnet, so a warm-cache downgrade pays only on small contexts
 * (break-even ~105k instead of ~350k with the means): Opus is kept unless the money is clear.
 */
export const DEFAULT_TURN: TurnProfile = { output: 4_000, cacheWrite: 15_000 };

/**
 * A model switch of the main conversation in dollars (API list prices). The
 * cost: the first request on the new model writes the whole context to its
 * cache, where staying would have read it (or, with a cold cache, written it
 * on the old model). The gain: every later turn's output and new cache writes
 * priced on the new model; cache reads cost the same on Opus and Sonnet 5.5.
 * Positive gain = the new model is cheaper per turn.
 */
export function switchEconomics(
  from: Tier,
  to: Tier,
  ctx: Pick<MainContext, 'contextTokens' | 'freeSwitch' | 'turnProfile'>,
  config: GovernorConfig,
): { cost: number; gain: number } {
  const pf = PRICES[familyOf(config.models[from]) ?? (from === 'strong' ? 'opus' : 'sonnet')];
  const pt = PRICES[familyOf(config.models[to]) ?? (to === 'strong' ? 'opus' : 'sonnet')];
  const tokens = ctx.contextTokens ?? Number.POSITIVE_INFINITY;
  const cost = (tokens * (pt.write1h - (ctx.freeSwitch ? pf.write1h : pf.cacheRead))) / 1e6;
  const turn = ctx.turnProfile ?? DEFAULT_TURN;
  const perTurn = (turn.output * (pf.output - pt.output) + turn.cacheWrite * (pf.write1h - pt.write1h)) / 1e6;
  return { cost, gain: perTurn * config.router.expectedTurns };
}

const usd = (n: number): string =>
  Number.isFinite(n) ? `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(n !== 0 && Math.abs(n) < 0.1 ? 3 : 2)}` : '$?';

export function decideMain(signals: Signals, ctx: MainContext, config: GovernorConfig): Decision {
  const r = config.router;
  const reasons: string[] = [];
  if (signals.continuation >= r.continuationAt) {
    if (ctx.previous) {
      reasons.push('follow-up: previous decision kept');
      return { tier: ctx.previous.tier, effort: ctx.previous.effort, switched: false, reasons };
    }
    // A bare "go on" carries no difficulty of its own: change nothing.
    reasons.push('follow-up without a previous decision: nothing changed');
    return { tier: ctx.currentTier, effort: r.defaultEffort, keepEffort: true, switched: false, reasons };
  }
  const effort = chooseEffort(signals, ctx.pressure, config, reasons, ctx.previous?.effort);
  if (!r.mainModel) return { tier: ctx.currentTier, effort, switched: false, reasons };

  const tokens = ctx.contextTokens ?? Number.POSITIVE_INFINITY;
  const cheap = ctx.freeSwitch || tokens <= r.cheapSwitchTokens;
  const where = ctx.freeSwitch ? 'cache cold' : cheap ? 'small context' : 'warm cache';
  const risky = signals.risky >= r.riskyAt && ctx.pressure < 3;
  let tier: Tier = ctx.currentTier;

  if (ctx.currentTier === 'standard') {
    const up = UPGRADE_PENALTY[ctx.pressure];
    if (signals.pStrong >= r.forceUpgradeAt + up || (risky && signals.pStrong >= r.upgradeAt)) {
      tier = 'strong';
      reasons.push(`upgrade: P(opus)=${signals.pStrong.toFixed(2)}${risky ? ', risky' : ''} (${where})`);
    } else if (cheap && (signals.pStrong >= r.upgradeAt + up || risky)) {
      tier = 'strong';
      reasons.push(`upgrade: P(opus)=${signals.pStrong.toFixed(2)} (${where})`);
    }
  } else {
    const pStandard = 1 - signals.pStrong;
    const down = DOWNGRADE_BONUS[ctx.pressure];
    const fits = tokens <= r.standardMaxContextTokens;
    // A downgrade is for money: it happens where it pays back within `expectedTurns`.
    const money = switchEconomics('strong', 'standard', ctx, config);
    const pays = money.gain > money.cost;
    const sums = `switch ${usd(money.cost)} vs gain ${usd(money.gain)} over ${r.expectedTurns} turns`;
    if (!risky && fits && pays && pStandard >= r.downgradeAt - down) {
      tier = 'standard';
      reasons.push(`downgrade: P(sonnet)=${pStandard.toFixed(2)} (${where}; ${sums})`);
    } else if (!risky && fits && pays && ctx.pressure === 3 && pStandard >= 0.5) {
      // Critical pressure lowers the bar on P(sonnet), not on money: a rewrite that does not pay
      // back spends the very limit that is short.
      tier = 'standard';
      reasons.push(`downgrade: budget critical, P(sonnet)=${pStandard.toFixed(2)} (${sums})`);
    } else if (risky) {
      reasons.push(`kept opus: risky (${signals.risky.toFixed(2)})`);
    } else if (pStandard >= r.downgradeAt - down && fits && !pays) {
      reasons.push(`kept opus: ${sums} (rewrites ${Math.round(tokens / 1000)}k cached tokens)`);
    } else if (!fits) {
      reasons.push('kept opus: context too large for sonnet');
    } else {
      reasons.push(`kept opus: P(sonnet)=${pStandard.toFixed(2)} < ${(r.downgradeAt - down).toFixed(2)}`);
    }
  }
  return { tier, effort, switched: tier !== ctx.currentTier, reasons };
}

export type SubagentContext = {
  pressure: Pressure;
  subagentType: string;
  /**
   * The subagent cannot change anything (a search agent, or a specialist
   * without edit tools): a risky task still gets `high` effort, but not Opus
   * for its sake, since reading is not where the risk is.
   */
  readOnly?: boolean;
  pinnedTier?: Tier;
  pinnedEffort?: Effort;
};

/** Read-only search agents rarely need the strong tier. */
const SEARCH_TYPES = new Set(['Explore']);

export function decideSubagent(
  signals: Signals,
  ctx: SubagentContext,
  config: GovernorConfig,
): Decision {
  const r = config.router;
  const reasons: string[] = [];
  const effort = ctx.pinnedEffort ?? chooseEffort(signals, ctx.pressure, config, reasons);
  if (ctx.pinnedEffort) reasons.push('effort pinned by agent');
  let tier: Tier;
  if (ctx.pinnedTier) {
    tier = ctx.pinnedTier;
    reasons.push('tier pinned by agent');
  } else {
    const bar =
      r.subagentStrongAt + UPGRADE_PENALTY[ctx.pressure] + (SEARCH_TYPES.has(ctx.subagentType) ? 0.2 : 0);
    const readOnly = ctx.readOnly ?? SEARCH_TYPES.has(ctx.subagentType);
    const risky = signals.risky >= r.riskyAt && ctx.pressure < 3 && !readOnly;
    tier = risky || signals.pStrong >= bar ? 'strong' : 'standard';
    reasons.push(
      `P(opus)=${signals.pStrong.toFixed(2)} vs bar ${bar.toFixed(2)}${risky ? ', risky' : ''}${readOnly && signals.risky >= r.riskyAt ? ', risky but read-only' : ''}`,
    );
  }
  return { tier, effort, switched: false, reasons };
}

/** Which tier a model id belongs to; undefined for models outside both tiers. */
/**
 * Jev unreachable and no earlier decision to keep: the model stays as it is
 * (a switch nobody weighed would rewrite the cache), but the effort is
 * `fallbackEffort` instead of the session's own, often xhigh. On 6 October
 * a five-hour turn ran on xhigh this way, Jev having timed out at its start.
 */
export function fallbackDecision(tier: Tier, why: string, config: GovernorConfig, pinnedEffort?: Effort): Decision {
  const effort = pinnedEffort ?? clampEffort(effortIndex(config.router.fallbackEffort), config);
  return { tier, effort, switched: false, reasons: [`${why}: effort ${effort} (fallback)`] };
}

export function tierOf(model: string, config: GovernorConfig): Tier | undefined {
  const m = model.toLowerCase();
  if (m === config.models.strong.toLowerCase() || m.includes('opus')) return 'strong';
  if (m === config.models.standard.toLowerCase() || m.includes('sonnet')) return 'standard';
  return undefined;
}
