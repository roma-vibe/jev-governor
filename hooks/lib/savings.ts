// What the mod saved, computed from the ledger, in API-equivalent dollars
// (Anthropic list prices; the subscription's own limit accounting is not
// published, but it scales with the same tokens). Pure: the UI server reads
// the ledger and calls computeSavings.
//
// Exact (measured from the ledger):
// - model: the turn's real tokens priced on the model it would have run on
//   without the mod, minus the same tokens on the model it ran on. Positive
//   for Sonnet instead of Opus; negative ("paid for quality") for Opus instead
//   of Sonnet. Conservative: a stronger model at higher effort usually also
//   spends more tokens.
// - trim: tokens removed from a tool output × the requests after it that would
//   have re-read them (plus the one cache write), until the next compaction.
// - compact: tokens removed × the requests after it; a size-triggered
//   compaction pays for re-writing what is left, one after the cache expired
//   does not (that re-write was unavoidable) and also saves writing the
//   removed part. A compaction Claude Code started at the smaller window the
//   mod set (`window`, also mid-turn and in subagents) is priced as a
//   size-triggered one in its own loop: without the mod it would not have run.
// - jev: what Jev itself cost (negative).
// Estimated (not measurable without a twin run):
// - effort: a lower effort makes the model think and write less; one level is
//   worth roughly `effortFactor` of the turn's output. Only the output: with
//   long contexts most of a turn is cache reads, which effort barely moves
//   (subagents on 2026-10-06: output under 3% of their cost), so the whole
//   turn overstated it several times.
// - a compaction Claude Code asked for: the summary call it avoided.

import { EFFORTS, type Effort, type LedgerEntry } from './types.ts';

export type Family = 'fable' | 'opus' | 'sonnet' | 'haiku';
export type Price = { input: number; output: number; cacheRead: number; write5m: number; write1h: number };

/** $ per million tokens. */
export const PRICES: Record<Family, Price> = {
  fable: { input: 10, output: 50, cacheRead: 0.25, write5m: 12.5, write1h: 20 },
  opus: { input: 4, output: 20, cacheRead: 0.2, write5m: 5, write1h: 8 },
  sonnet: { input: 2, output: 10, cacheRead: 0.2, write5m: 2.5, write1h: 4 },
  haiku: { input: 1, output: 5, cacheRead: 0.1, write5m: 1.25, write1h: 2 },
};

/** Characters per token for the char counts the ledger keeps. */
const CHARS_PER_TOKEN = 3.5;
/** Output of the summary a Claude Code compaction would have written. */
const SUMMARY_OUTPUT_TOKENS = 4000;

export function familyOf(model: string | undefined): Family | undefined {
  const m = (model ?? '').toLowerCase();
  if (m.includes('fable') || m.includes('mythos')) return 'fable';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return undefined;
}

type Usage = NonNullable<LedgerEntry['usage']>;

/** A turn's cost on a model family by token kind; the main conversation writes the 1-hour cache. */
export function usageCostParts(usage: Usage, family: Family, main: boolean): CostBreakdown {
  const p = PRICES[family];
  return {
    input: (usage.input * p.input) / 1e6,
    output: (usage.output * p.output) / 1e6,
    cacheRead: (usage.cacheRead * p.cacheRead) / 1e6,
    cacheWrite: (usage.cacheWrite * (main ? p.write1h : p.write5m)) / 1e6,
  };
}

/** Cost of a turn's tokens on a model family; the main conversation writes the 1-hour cache. */
export function usageCost(usage: Usage, family: Family, main: boolean): number {
  const c = usageCostParts(usage, family, main);
  return c.input + c.output + c.cacheRead + c.cacheWrite;
}

export type SavingSource = 'model' | 'effort' | 'trim' | 'compact' | 'jev';

export type SavingEvent = {
  ts: string;
  session: string;
  project?: string;
  source: SavingSource;
  /** $ saved (positive) or spent (negative). */
  amount: number;
  estimate: boolean;
  scope?: 'main' | 'subagent';
  /** model / effort events */
  fromModel?: Family;
  toModel?: Family;
  fromEffort?: Effort;
  toEffort?: Effort;
  /** trim / compact: tokens removed; requests that would have re-read them */
  tokens?: number;
  laterRequests?: number;
  reason?: string;
  /** The turn's actual cost, for model / effort events. */
  turnCost?: number;
  /** model: tokens the switch rewrote on a warm cache (read, not written, without the mod). */
  rewrite?: number;
  /**
   * The baseline was assumed, not recorded: the ledger entry predates the
   * `baseModel` / `baseEffort` fields, so `defaultBase` stood in (e.g. `opus·xhigh`).
   */
  assumed?: string;
  text?: string;
};

/** API-equivalent $ of the managed turns by token kind: which lever moves what. */
export type CostBreakdown = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type SavingsReport = {
  totals: {
    /** Cost of the turns the mod managed. */
    actual: number;
    exact: number;
    estimated: number;
    jev: number;
    /** exact + estimated − Jev. */
    net: number;
    /** actual + exact + estimated: roughly what those turns would have cost without the mod. */
    withoutMod: number;
    bySource: Record<SavingSource, number>;
    tokensRemoved: number;
    turns: number;
    /** Part of exact + estimated that rests on the assumed baseline (see SavingEvent.assumed). */
    assumed: number;
    /** Turns whose baseline was assumed. */
    assumedTurns: number;
    cost: CostBreakdown;
  };
  byDay: { day: string; exact: number; estimated: number; jev: number; actual: number }[];
  events: SavingEvent[];
};

export type SavingsOptions = {
  /** Share of a turn one effort level is worth (estimate). */
  effortFactor?: number;
  /** Cap on that share. */
  maxEffortFactor?: number;
  /**
   * What a managed turn would have run on when its entry predates the
   * `baseModel` / `baseEffort` fields (the session's usual model and effort).
   */
  defaultBase?: { model?: string; effort?: Effort };
};

type Loop = { session: string; agentId?: string };

function loopKey(l: Loop): string {
  return `${l.session}/${l.agentId ?? 'main'}`;
}

/**
 * Requests made after `ts` in a loop until its next compaction. The turn that
 * was running at `ts` counts half (its usage is logged when it ends).
 */
function requestsAfter(
  timeline: readonly { ts: string; kind: 'usage' | 'compact'; steps: number; family?: Family }[],
  ts: string,
): { requests: number; readPrice: number } {
  let requests = 0;
  let readCost = 0;
  let first = true;
  for (const point of timeline) {
    if (point.ts <= ts) continue;
    if (point.kind === 'compact') break;
    const steps = first ? Math.ceil(point.steps / 2) : point.steps;
    first = false;
    requests += steps;
    readCost += steps * PRICES[point.family ?? 'opus'].cacheRead;
  }
  return { requests, readPrice: requests > 0 ? readCost / requests : 0 };
}

export function computeSavings(entries: readonly LedgerEntry[], options: SavingsOptions = {}): SavingsReport {
  const factor = options.effortFactor ?? 0.3;
  const maxFactor = options.maxEffortFactor ?? 0.6;
  const sorted = [...entries].sort((a, b) => a.ts.localeCompare(b.ts));

  // Per loop: when requests happened and on what model (managed sessions only).
  const timelines = new Map<string, { ts: string; kind: 'usage' | 'compact'; steps: number; family?: Family }[]>();
  for (const e of sorted) {
    if (e.applied === false) continue;
    if (e.kind === 'usage' && e.usage) {
      const key = loopKey({ session: e.session, agentId: e.agentId });
      const list = timelines.get(key) ?? [];
      list.push({ ts: e.ts, kind: 'usage', steps: Math.max(1, e.steps ?? 1), family: familyOf(e.usage.model) });
      timelines.set(key, list);
    } else if (e.kind === 'compact' && e.compaction && !e.compaction.fallback && e.compaction.trigger !== 'precompute') {
      const key = loopKey({ session: e.session, agentId: e.agentId });
      const list = timelines.get(key) ?? [];
      list.push({ ts: e.ts, kind: 'compact', steps: 0 });
      timelines.set(key, list);
    }
  }

  // Older usage entries carry no effort: take the effort the turn / spawn decision applied.
  const lastTurnEffort = new Map<string, Effort>();
  const effortByEntry = new Map<LedgerEntry, Effort>();
  for (const e of sorted) {
    if (e.applied === false) continue;
    if ((e.kind === 'turn' || e.kind === 'subagent') && e.effort) {
      lastTurnEffort.set(loopKey({ session: e.session, agentId: e.kind === 'subagent' ? e.agentId : undefined }), e.effort);
    }
    if (e.kind === 'usage') {
      const eff = lastTurnEffort.get(loopKey({ session: e.session, agentId: e.agentId }));
      if (eff) effortByEntry.set(e, eff);
    }
  }

  const events: SavingEvent[] = [];
  let actual = 0;
  let turns = 0;
  let assumedTurns = 0;
  // A warm-cache switch by the mod (turn `rewrite`): the next main usage of that session wrote the
  // context the base model would have read. Older entries do not say; they are taken as before.
  const switches = new Map<string, { from?: Family; rewrite: number }>();
  const costParts: CostBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const e of sorted) {
    const base = { ts: e.ts, session: e.session, project: e.project, scope: e.scope, text: e.text };
    if (e.jevCost) events.push({ ...base, source: 'jev', amount: -e.jevCost, estimate: false });
    if (e.applied === false) continue;

    if (e.kind === 'turn' && e.scope !== 'subagent' && e.rewrite && e.rewrite > 0) {
      switches.set(e.session, { from: familyOf(e.prevModel ?? ''), rewrite: e.rewrite });
      continue;
    }

    if (e.kind === 'usage' && e.usage) {
      const ran = familyOf(e.usage.model);
      // Not the mod's turn: neither a saving nor part of what it managed.
      if (!ran || e.unrouted) continue;
      const main = e.scope !== 'subagent';
      const switched = main ? switches.get(e.session) : undefined;
      if (switched) switches.delete(e.session);
      const rewrite = switched ? Math.min(switched.rewrite, e.usage.cacheWrite) : 0;
      // Without the mod the rewritten context would have been a cache read.
      const baseUsage = rewrite > 0 ? { ...e.usage, cacheWrite: e.usage.cacheWrite - rewrite, cacheRead: e.usage.cacheRead + rewrite } : e.usage;
      const parts = usageCostParts(e.usage, ran, main);
      const cost = parts.input + parts.output + parts.cacheRead + parts.cacheWrite;
      for (const k of Object.keys(parts) as (keyof CostBreakdown)[]) costParts[k] += parts[k];
      actual += cost;
      turns++;
      const legacy = e.baseModel === undefined && e.baseEffort === undefined;
      const would = familyOf(e.baseModel ?? (legacy ? options.defaultBase?.model : undefined)) ?? ran;
      const baseEffort = e.baseEffort ?? (legacy ? options.defaultBase?.effort : undefined);
      const effort = e.effort ?? (legacy ? effortByEntry.get(e) : undefined);
      const assumed =
        legacy && (options.defaultBase?.model || options.defaultBase?.effort)
          ? [familyOf(options.defaultBase.model) ?? options.defaultBase.model, options.defaultBase.effort].filter(Boolean).join('·')
          : undefined;
      if (assumed) assumedTurns++;
      if (would !== ran || rewrite > 0) {
        events.push({
          ...base,
          source: 'model',
          amount: usageCost(baseUsage, would, main) - cost,
          estimate: false,
          fromModel: would !== ran ? would : (switched?.from ?? would),
          toModel: ran,
          turnCost: cost,
          ...(rewrite > 0 ? { rewrite } : {}),
          ...(assumed ? { assumed } : {}),
        });
      }
      if (baseEffort && effort && baseEffort !== effort) {
        const levels = EFFORTS.indexOf(effort) - EFFORTS.indexOf(baseEffort);
        const share = Math.min(maxFactor, factor * Math.abs(levels));
        // Lower: the output is (1 − share) of what it would have been. Higher: (1 + share).
        const amount = levels < 0 ? (parts.output * share) / (1 - share) : -(parts.output * share) / (1 + share);
        events.push({
          ...base,
          source: 'effort',
          amount,
          estimate: true,
          fromEffort: baseEffort,
          toEffort: effort,
          turnCost: cost,
          ...(assumed ? { assumed } : {}),
        });
      }
      continue;
    }

    if (e.kind === 'trim' && e.trim) {
      // Negative for a saved output brought back larger than Claude Code's preview: a cost.
      const tokens = (e.trim.charsBefore - e.trim.charsAfter) / CHARS_PER_TOKEN;
      const loop = timelines.get(loopKey({ session: e.session, agentId: e.agentId })) ?? [];
      const later = requestsAfter(loop, e.ts);
      const family = loop.find((p) => p.ts >= e.ts && p.family)?.family ?? 'opus';
      const write = e.scope === 'subagent' ? PRICES[family].write5m : PRICES[family].write1h;
      events.push({
        ...base,
        source: 'trim',
        amount: (tokens * (later.requests * (later.readPrice || PRICES[family].cacheRead) + write)) / 1e6,
        estimate: false,
        tokens: Math.round(tokens),
        laterRequests: later.requests,
      });
      continue;
    }

    // A precompute installed nothing: the compaction that came ran (and was logged) on its own.
    if (e.kind === 'compact' && e.compaction && !e.compaction.fallback && e.compaction.trigger !== 'precompute' && !e.text?.startsWith('skipped')) {
      const c = e.compaction;
      const removed = Math.max(0, (c.charsBefore - c.charsAfter) / CHARS_PER_TOKEN);
      const left = c.charsAfter / CHARS_PER_TOKEN;
      const family = familyOf(e.model) ?? 'opus';
      const p = PRICES[family];
      const reason = c.reason ?? 'engine';
      if (reason === 'engine') {
        // Claude Code would have summarized: the summary call is what Jev replaced.
        const avoided = ((c.charsBefore / CHARS_PER_TOKEN) * p.cacheRead + SUMMARY_OUTPUT_TOKENS * p.output) / 1e6;
        events.push({ ...base, source: 'compact', amount: avoided, estimate: true, tokens: Math.round(removed), reason });
        continue;
      }
      const loop = timelines.get(loopKey({ session: e.session, agentId: e.agentId })) ?? [];
      const later = requestsAfter(loop, e.ts);
      const reads = (removed * later.requests * (later.readPrice || p.cacheRead)) / 1e6;
      const write = e.scope === 'subagent' || e.agentId !== undefined ? p.write5m : p.write1h;
      const rewrite = reason === 'return' ? (removed * write) / 1e6 : -(left * write) / 1e6;
      events.push({
        ...base,
        source: 'compact',
        amount: reads + rewrite,
        estimate: false,
        tokens: Math.round(removed),
        laterRequests: later.requests,
        reason,
      });
    }
  }

  const bySource: Record<SavingSource, number> = { model: 0, effort: 0, trim: 0, compact: 0, jev: 0 };
  let exact = 0;
  let estimated = 0;
  let jev = 0;
  let tokensRemoved = 0;
  let assumedAmount = 0;
  const days = new Map<string, { day: string; exact: number; estimated: number; jev: number; actual: number }>();
  const dayOf = (ts: string) => {
    const day = ts.slice(0, 10);
    let d = days.get(day);
    if (!d) days.set(day, (d = { day, exact: 0, estimated: 0, jev: 0, actual: 0 }));
    return d;
  };
  for (const ev of events) {
    bySource[ev.source] += ev.amount;
    const d = dayOf(ev.ts);
    if (ev.source === 'jev') {
      jev += -ev.amount;
      d.jev += -ev.amount;
    } else if (ev.estimate) {
      estimated += ev.amount;
      d.estimated += ev.amount;
    } else {
      exact += ev.amount;
      d.exact += ev.amount;
    }
    if (ev.tokens) tokensRemoved += ev.tokens;
    if (ev.assumed) assumedAmount += ev.amount;
  }
  for (const e of sorted) {
    if (e.applied === false || e.kind !== 'usage' || !e.usage) continue;
    const ran = familyOf(e.usage.model);
    if (ran) dayOf(e.ts).actual += usageCost(e.usage, ran, e.scope !== 'subagent');
  }
  return {
    totals: {
      actual,
      exact,
      estimated,
      jev,
      net: exact + estimated - jev,
      withoutMod: actual + exact + estimated,
      bySource,
      tokensRemoved,
      turns,
      assumed: assumedAmount,
      assumedTurns,
      cost: costParts,
    },
    byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    events: events.reverse(),
  };
}
