// What the mod saved, computed from the ledger, in API-equivalent dollars
// (Anthropic list prices; the subscription's own limit accounting is not
// published, but it scales with the same tokens). Pure: the UI server reads
// the ledger and calls computeSavings.
//
// The model and effort a turn ran on are taken as given: the person could have
// picked them as well, so a choice is neither a saving nor a cost (they are
// listed apart, in `routing`). Saved is only what the mod did to the tokens
// after that choice, priced on the model that actually ran:
// - compact: tokens removed × the requests after it that would have re-read
//   them; a size-triggered compaction pays for re-writing what is left, one
//   after the cache expired does not (that re-write was unavoidable) and also
//   saves writing the removed part. A compaction Claude Code started at the
//   smaller window the mod set (`window`, also mid-turn and in subagents) is
//   priced as a size-triggered one in its own loop: without the mod it would
//   not have run. One Claude Code asked for is an estimate: the summary call
//   it avoided.
// - trim: tokens removed from a tool output × the requests after it that would
//   have re-read them (plus the one cache write), until the next compaction.
// - tools: tool definitions put behind ToolSearch leave the prefix of every
//   later request of that chat: their tokens × those requests (+ one write).
// Spent, deducted from it:
// - jev: what Jev itself cost.
// - calls: the mod's own model calls (specialist drafts and merges, autosave
//   of facts, command descriptions, handoff briefs), ledger kind `mod-call`.

import type { LedgerEntry } from './types.ts';

/** `haiku` is Haiku 5.5 and later; `haiku4` the Haiku 4.x / 3.x models before it. */
export type Family = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'haiku4';
export type Price = { input: number; output: number; cacheRead: number; write5m: number; write1h: number };

/** $ per million tokens; for a family in LONG_PRICES, the rate for prompts up to its threshold. */
export const PRICES: Record<Family, Price> = {
  fable: { input: 10, output: 50, cacheRead: 0.25, write5m: 12.5, write1h: 20 },
  opus: { input: 4, output: 20, cacheRead: 0.2, write5m: 5, write1h: 8 },
  sonnet: { input: 2, output: 10, cacheRead: 0.2, write5m: 2.5, write1h: 4 },
  haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, write5m: 0.125, write1h: 0.2 },
  haiku4: { input: 1, output: 5, cacheRead: 0.1, write5m: 1.25, write1h: 2 },
};

/**
 * Families with a second rate card for long prompts: a request whose prompt (input + cache read +
 * cache write) is above `above` tokens bills every token of it, output too, at `price`. Haiku 5.5
 * has two cards, split at a 100K-token prompt.
 */
export const LONG_PRICES: Partial<Record<Family, { above: number; price: Price }>> = {
  haiku: { above: 100_000, price: { input: 0.5, output: 2.5, cacheRead: 0.05, write5m: 0.625, write1h: 1 } },
};

/** Requests with a prompt above this are counted apart (`usage.long`): the long rate card starts here. */
export const LONG_PROMPT_TOKENS = 100_000;

/** The rate card a request with this many prompt tokens is billed on. */
export function priceAt(family: Family, promptTokens?: number): Price {
  const long = LONG_PRICES[family];
  return long && promptTokens !== undefined && promptTokens > long.above ? long.price : PRICES[family];
}

/** Characters per token for the char counts the ledger keeps. */
const CHARS_PER_TOKEN = 3.5;
/** Output of the summary a Claude Code compaction would have written. */
const SUMMARY_OUTPUT_TOKENS = 4000;

export function familyOf(model: string | undefined): Family | undefined {
  const m = (model ?? '').toLowerCase();
  if (m.includes('fable') || m.includes('mythos')) return 'fable';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return /haiku-[34]|3(-5)?-haiku/.test(m) ? 'haiku4' : 'haiku';
  return undefined;
}

type Usage = NonNullable<LedgerEntry['usage']>;

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

function priced(t: Tokens, p: Price, main: boolean): CostBreakdown {
  return {
    input: (t.input * p.input) / 1e6,
    output: (t.output * p.output) / 1e6,
    cacheRead: (t.cacheRead * p.cacheRead) / 1e6,
    cacheWrite: (t.cacheWrite * (main ? p.write1h : p.write5m)) / 1e6,
  };
}

/**
 * A turn's cost on a model family by token kind; the main conversation writes the 1-hour cache.
 * The part of it from long-prompt requests (`usage.long`) is priced on the family's long rate card.
 */
export function usageCostParts(usage: Usage, family: Family, main: boolean): CostBreakdown {
  const long = LONG_PRICES[family];
  if (!long || !usage.long) return priced(usage, PRICES[family], main);
  const l = usage.long;
  const short = {
    input: Math.max(0, usage.input - l.input),
    output: Math.max(0, usage.output - l.output),
    cacheRead: Math.max(0, usage.cacheRead - l.cacheRead),
    cacheWrite: Math.max(0, usage.cacheWrite - l.cacheWrite),
  };
  const a = priced(short, PRICES[family], main);
  const b = priced(l, long.price, main);
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

/** Cost of a turn's tokens on a model family; the main conversation writes the 1-hour cache. */
export function usageCost(usage: Usage, family: Family, main: boolean): number {
  const c = usageCostParts(usage, family, main);
  return c.input + c.output + c.cacheRead + c.cacheWrite;
}


/** What the mod saved (`compact`, `trim`, `tools`) and what it spent (`jev`, `calls`). */
export type SavingSource = 'compact' | 'trim' | 'tools' | 'jev' | 'calls';

export const GAIN_SOURCES: readonly SavingSource[] = ['compact', 'trim', 'tools'];
export const SPEND_SOURCES: readonly SavingSource[] = ['jev', 'calls'];

export type SavingEvent = {
  ts: string;
  session: string;
  project?: string;
  source: SavingSource;
  /** $ saved (positive) or spent (negative). */
  amount: number;
  estimate: boolean;
  scope?: 'main' | 'subagent';
  /** compact / trim / tools: tokens removed; requests that would have re-read them */
  tokens?: number;
  laterRequests?: number;
  reason?: string;
  /** tools: how many tool definitions went behind ToolSearch. */
  deferred?: number;
  /** calls: what the mod asked a model for, and which model. */
  purpose?: string;
  model?: string;
  text?: string;
};

/** API-equivalent $ of the managed turns by token kind: which lever moves what. */
export type CostBreakdown = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** Turns (or subagent runs) on one model and effort, and what they cost. Not part of the savings. */
export type RouteRow = { model: string; effort?: string; turns: number; steps: number; cost: number };

export type SavingsReport = {
  totals: {
    /** Cost of the turns the mod managed, on the models they ran on. */
    actual: number;
    /** Saved: measured (compact, trim, tools). */
    exact: number;
    /** Saved: estimated (compactions Claude Code asked for). */
    estimated: number;
    /** exact + estimated. */
    saved: number;
    jev: number;
    /** The mod's own model calls. */
    calls: number;
    /** jev + calls. */
    spent: number;
    /** saved − spent. */
    net: number;
    /** actual + saved: what the same turns would have cost without the mod's context work. */
    withoutMod: number;
    bySource: Record<SavingSource, number>;
    tokensRemoved: number;
    turns: number;
    cost: CostBreakdown;
  };
  byDay: { day: string; exact: number; estimated: number; spent: number; actual: number }[];
  /** Which models and efforts the turns ran on: shown for orientation, never priced against anything. */
  routing: { main: RouteRow[]; subagent: RouteRow[] };
  events: SavingEvent[];
};

type Loop = { session: string; agentId?: string };

function loopKey(l: Loop): string {
  return `${l.session}/${l.agentId ?? 'main'}`;
}

type Point = { ts: string; kind: 'usage' | 'compact'; steps: number; family?: Family };

/**
 * Requests made after `ts` in a loop until its next compaction (or to the end with
 * `throughCompactions`). The turn that was running at `ts` counts half (its usage is
 * logged when it ends).
 */
function requestsAfter(timeline: readonly Point[], ts: string, throughCompactions = false): { requests: number; readCost: number } {
  let requests = 0;
  let readCost = 0;
  let first = true;
  for (const point of timeline) {
    if (point.ts <= ts) continue;
    if (point.kind === 'compact') {
      if (throughCompactions) continue;
      break;
    }
    const steps = first ? Math.ceil(point.steps / 2) : point.steps;
    first = false;
    requests += steps;
    readCost += steps * PRICES[point.family ?? 'opus'].cacheRead;
  }
  return { requests, readCost };
}

const callTokens = (c: NonNullable<LedgerEntry['call']>): Usage => ({
  model: c.model,
  input: c.input,
  output: c.output,
  cacheRead: c.cacheRead,
  cacheWrite: c.cacheWrite,
});

export function computeSavings(entries: readonly LedgerEntry[]): SavingsReport {
  const sorted = [...entries].sort((a, b) => a.ts.localeCompare(b.ts));

  // Per loop: when requests happened and on what model (managed sessions only).
  const timelines = new Map<string, Point[]>();
  const push = (e: LedgerEntry, p: Point) => {
    const key = loopKey({ session: e.session, agentId: e.agentId });
    const list = timelines.get(key) ?? [];
    list.push(p);
    timelines.set(key, list);
  };
  for (const e of sorted) {
    if (e.applied === false) continue;
    if (e.kind === 'usage' && e.usage) {
      push(e, { ts: e.ts, kind: 'usage', steps: Math.max(1, e.steps ?? 1), family: familyOf(e.usage.model) });
    } else if (e.kind === 'compact' && e.compaction && !e.compaction.fallback && e.compaction.trigger !== 'precompute') {
      push(e, { ts: e.ts, kind: 'compact', steps: 0 });
    }
  }
  /** The model a loop ran on at `ts`: the first request after it, else the last before. */
  const familyAt = (loop: readonly Point[], ts: string): Family =>
    loop.find((p) => p.ts >= ts && p.family)?.family ?? [...loop].reverse().find((p) => p.family)?.family ?? 'opus';

  const events: SavingEvent[] = [];
  let actual = 0;
  let turns = 0;
  const costParts: CostBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const routes = { main: new Map<string, RouteRow>(), subagent: new Map<string, RouteRow>() };
  for (const e of sorted) {
    const base = { ts: e.ts, session: e.session, project: e.project, scope: e.scope, text: e.text };
    if (e.jevCost) events.push({ ...base, source: 'jev', amount: -e.jevCost, estimate: false });

    // The mod's own model calls cost in any mode.
    if (e.kind === 'mod-call' && e.call) {
      const family = familyOf(e.call.model);
      if (family) {
        // A handoff brief forks the main chat and reads its 1-hour cache; the rest are fresh calls.
        const cost = usageCost(callTokens(e.call), family, e.call.purpose === 'handoff');
        events.push({ ...base, source: 'calls', amount: -cost, estimate: false, purpose: e.call.purpose, model: family });
      }
      continue;
    }
    if (e.applied === false) continue;

    if (e.kind === 'usage' && e.usage) {
      const ran = familyOf(e.usage.model);
      // Not the mod's turn: neither a saving nor part of what it managed.
      if (!ran || e.unrouted) continue;
      const main = e.scope !== 'subagent';
      const parts = usageCostParts(e.usage, ran, main);
      const cost = parts.input + parts.output + parts.cacheRead + parts.cacheWrite;
      for (const k of Object.keys(parts) as (keyof CostBreakdown)[]) costParts[k] += parts[k];
      actual += cost;
      turns++;
      const table = main ? routes.main : routes.subagent;
      const key = `${ran}·${e.effort ?? ''}`;
      const row = table.get(key) ?? { model: ran, ...(e.effort ? { effort: e.effort } : {}), turns: 0, steps: 0, cost: 0 };
      row.turns++;
      row.steps += Math.max(1, e.steps ?? 1);
      row.cost += cost;
      table.set(key, row);
      continue;
    }

    if (e.kind === 'tools' && e.tools && e.tools.chars > 0) {
      // Out of every later request of this chat's own loop, compactions or not: the prefix stays.
      const tokens = e.tools.chars / CHARS_PER_TOKEN;
      const loop = timelines.get(loopKey({ session: e.session })) ?? [];
      const later = requestsAfter(loop, e.ts, true);
      const write = PRICES[familyAt(loop, e.ts)].write1h;
      events.push({
        ...base,
        source: 'tools',
        amount: later.requests > 0 ? (tokens * (later.readCost + write)) / 1e6 : 0,
        estimate: false,
        tokens: Math.round(tokens),
        laterRequests: later.requests,
        deferred: e.tools.deferred.length,
      });
      continue;
    }

    if (e.kind === 'trim' && e.trim) {
      // Negative for a saved output brought back larger than Claude Code's preview: a cost.
      const tokens = (e.trim.charsBefore - e.trim.charsAfter) / CHARS_PER_TOKEN;
      const loop = timelines.get(loopKey({ session: e.session, agentId: e.agentId })) ?? [];
      const later = requestsAfter(loop, e.ts);
      const family = familyAt(loop, e.ts);
      const write = e.scope === 'subagent' ? PRICES[family].write5m : PRICES[family].write1h;
      events.push({
        ...base,
        source: 'trim',
        amount: (tokens * (later.readCost + write)) / 1e6,
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
      const reads = (removed * later.readCost) / 1e6;
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

  const bySource: Record<SavingSource, number> = { compact: 0, trim: 0, tools: 0, jev: 0, calls: 0 };
  let exact = 0;
  let estimated = 0;
  let tokensRemoved = 0;
  const days = new Map<string, { day: string; exact: number; estimated: number; spent: number; actual: number }>();
  const dayOf = (ts: string) => {
    const day = ts.slice(0, 10);
    let d = days.get(day);
    if (!d) days.set(day, (d = { day, exact: 0, estimated: 0, spent: 0, actual: 0 }));
    return d;
  };
  for (const ev of events) {
    bySource[ev.source] += ev.amount;
    const d = dayOf(ev.ts);
    if (SPEND_SOURCES.includes(ev.source)) {
      d.spent += -ev.amount;
    } else if (ev.estimate) {
      estimated += ev.amount;
      d.estimated += ev.amount;
    } else {
      exact += ev.amount;
      d.exact += ev.amount;
    }
    if (ev.tokens && ev.source !== 'tools') tokensRemoved += ev.tokens;
  }
  for (const e of sorted) {
    if (e.applied === false || e.kind !== 'usage' || !e.usage || e.unrouted) continue;
    const ran = familyOf(e.usage.model);
    if (ran) dayOf(e.ts).actual += usageCost(e.usage, ran, e.scope !== 'subagent');
  }
  const jev = -bySource.jev;
  const calls = -bySource.calls;
  const saved = exact + estimated;
  const spent = jev + calls;
  const byCost = (m: Map<string, RouteRow>) => [...m.values()].sort((a, b) => b.cost - a.cost);
  return {
    totals: {
      actual,
      exact,
      estimated,
      saved,
      jev,
      calls,
      spent,
      net: saved - spent,
      withoutMod: actual + saved,
      bySource,
      tokensRemoved,
      turns,
      cost: costParts,
    },
    byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    routing: { main: byCost(routes.main), subagent: byCost(routes.subagent) },
    events: events.reverse(),
  };
}
