import { describe, expect, it } from 'vitest';

import { computeSavings, familyOf, usageCost } from '../hooks/lib/savings.ts';
import type { LedgerEntry } from '../hooks/lib/types.ts';

const S = 'sess-1';
const at = (m: number) => new Date(Date.UTC(2026, 9, 5, 12, m)).toISOString();

function usage(m: number, model: string, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    ts: at(m),
    session: S,
    kind: 'usage',
    scope: 'main',
    usage: { model, input: 10, output: 5_000, cacheRead: 200_000, cacheWrite: 20_000 },
    steps: 4,
    ...over,
  };
}

describe('prices', () => {
  it('prices a main turn with 1-hour cache writes', () => {
    const u = { model: 'claude-opus-5-5', input: 0, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 };
    expect(usageCost(u, 'opus', true)).toBeCloseTo(20 + 0.2 + 8);
    expect(usageCost(u, 'opus', false)).toBeCloseTo(20 + 0.2 + 5);
    expect(familyOf('claude-sonnet-5-5')).toBe('sonnet');
    expect(familyOf('gpt-x')).toBeUndefined();
  });
});

describe('computeSavings', () => {
  it('counts Sonnet instead of Opus as exact savings and the opposite as spend', () => {
    const down = usage(1, 'claude-sonnet-5-5', { baseModel: 'claude-opus-5-5' });
    const up = usage(2, 'claude-opus-5-5', { baseModel: 'claude-sonnet-5-5' });
    const r = computeSavings([down, up]);
    const sonnet = usageCost(down.usage!, 'sonnet', true);
    const opus = usageCost(down.usage!, 'opus', true);
    expect(r.totals.bySource.model).toBeCloseTo(opus - sonnet - (opus - sonnet));
    expect(r.events.find((e) => e.toModel === 'sonnet')!.amount).toBeCloseTo(opus - sonnet);
    expect(r.events.find((e) => e.toModel === 'opus')!.amount).toBeCloseTo(sonnet - opus);
  });

  it('charges a warm-cache switch for the context it rewrote, both ways', () => {
    // The mod moves a warm 100k Opus chat to Sonnet: the first Sonnet turn writes the context.
    const down: LedgerEntry = { ts: at(1), session: S, kind: 'turn', scope: 'main', model: 'claude-sonnet-5-5', prevModel: 'claude-opus-5-5', switched: true, rewrite: 100_000 };
    const turnDown = usage(2, 'claude-sonnet-5-5', {
      baseModel: 'claude-opus-5-5',
      usage: { model: 'claude-sonnet-5-5', input: 0, output: 2_000, cacheRead: 0, cacheWrite: 105_000 },
    });
    // Later it moves back: the Opus turn writes it again, where Opus all along would have read it.
    const up: LedgerEntry = { ts: at(3), session: S, kind: 'turn', scope: 'main', model: 'claude-opus-5-5', prevModel: 'claude-sonnet-5-5', switched: true, rewrite: 110_000 };
    const turnUp = usage(4, 'claude-opus-5-5', {
      baseModel: 'claude-opus-5-5',
      usage: { model: 'claude-opus-5-5', input: 0, output: 2_000, cacheRead: 0, cacheWrite: 112_000 },
    });
    const r = computeSavings([down, turnDown, up, turnUp]);
    const first = r.events.find((e) => e.source === 'model' && e.toModel === 'sonnet');
    const second = r.events.find((e) => e.source === 'model' && e.toModel === 'opus');
    // Opus would have read the 100k ($0.02) and written 5k ($0.04): $0.10 with the output, against
    // $0.44 on Sonnet. It was a cost, not the +$0.44 a plain re-pricing shows.
    expect(first!.amount).toBeCloseTo((2_000 * 20 + 100_000 * 0.2 + 5_000 * 8) / 1e6 - (2_000 * 10 + 105_000 * 4) / 1e6);
    expect(first!.amount).toBeLessThan(0);
    expect(first!.rewrite).toBe(100_000);
    expect(second).toMatchObject({ fromModel: 'sonnet', toModel: 'opus', rewrite: 110_000 });
    expect(second!.amount).toBeCloseTo(-(110_000 * (8 - 0.2)) / 1e6);
  });

  it('leaves turns the mod did not route out of what it managed', () => {
    const r = computeSavings([usage(1, 'claude-sonnet-5-5', { unrouted: true, baseModel: 'claude-sonnet-5-5' }), usage(2, 'claude-opus-5-5', { baseModel: 'claude-opus-5-5' })]);
    expect(r.totals.turns).toBe(1);
    expect(r.totals.actual).toBeCloseTo(usageCost(usage(2, 'claude-opus-5-5').usage!, 'opus', true));
  });

  it('estimates lower effort separately, on the output only', () => {
    const r = computeSavings([usage(1, 'claude-opus-5-5', { baseModel: 'claude-opus-5-5', baseEffort: 'xhigh', effort: 'high' })]);
    const output = r.totals.cost.output;
    expect(output).toBeCloseTo((5_000 * 20) / 1e6);
    expect(r.totals.exact).toBe(0);
    expect(r.totals.estimated).toBeCloseTo((output * 0.3) / 0.7);
    // Cache reads (200k) are not scaled: they are most of the turn and effort barely moves them.
    expect(r.totals.estimated).toBeLessThan(r.totals.actual * 0.3);
    expect(r.totals.withoutMod).toBeCloseTo(r.totals.actual + (output * 0.3) / 0.7);
  });

  it('values a trim by the requests that would have re-read it, until a compaction', () => {
    const trim: LedgerEntry = {
      ts: at(1),
      session: S,
      kind: 'trim',
      scope: 'main',
      trim: { tool: 'Bash', charsBefore: 35_000, charsAfter: 3_500, linesBefore: 900, linesAfter: 40, outcome: 'tests passed', jevChunks: 0 },
    };
    const entries = [trim, usage(2, 'claude-opus-5-5', { steps: 4 }), usage(3, 'claude-opus-5-5', { steps: 6 })];
    const r = computeSavings(entries);
    const ev = r.events.find((e) => e.source === 'trim')!;
    expect(ev.tokens).toBe(9_000);
    expect(ev.laterRequests).toBe(2 + 6);
    expect(ev.amount).toBeCloseTo((9_000 * (8 * 0.2 + 8)) / 1e6);
    const cut = computeSavings([
      ...entries.slice(0, 2),
      { ts: at(2) + 'x', session: S, kind: 'compact', compaction: { charsBefore: 1, charsAfter: 1, ratio: 0, requests: 1, reason: 'threshold' } },
      entries[2]!,
    ]);
    expect(cut.events.find((e) => e.source === 'trim')!.laterRequests).toBe(2);
  });

  it('charges a size-triggered compaction for the re-write, not one after the cache expired', () => {
    const compact = (reason: 'threshold' | 'return'): LedgerEntry => ({
      ts: at(1),
      session: S,
      kind: 'compact',
      model: 'claude-opus-5-5',
      jevCost: 0.01,
      compaction: { charsBefore: 700_000, charsAfter: 350_000, ratio: 0.5, requests: 6, reason },
    });
    const later = [usage(2, 'claude-opus-5-5', { steps: 20 }), usage(3, 'claude-opus-5-5', { steps: 30 })];
    const threshold = computeSavings([compact('threshold'), ...later]).events.find((e) => e.source === 'compact')!;
    const idle = computeSavings([compact('return'), ...later]).events.find((e) => e.source === 'compact')!;
    const reads = (100_000 * 40 * 0.2) / 1e6;
    expect(threshold.amount).toBeCloseTo(reads - (100_000 * 8) / 1e6);
    expect(idle.amount).toBeCloseTo(reads + (100_000 * 8) / 1e6);
    expect(computeSavings([compact('return')]).totals.jev).toBeCloseTo(0.01);
  });

  it('prices a window compaction in a subagent in its own loop, at the 5-minute write price', () => {
    const A = 'agent-1';
    const compact: LedgerEntry = {
      ts: at(1),
      session: S,
      kind: 'compact',
      scope: 'subagent',
      agentId: A,
      model: 'claude-opus-5-5',
      compaction: { charsBefore: 700_000, charsAfter: 350_000, ratio: 0.5, requests: 6, reason: 'window', trigger: 'auto' },
    };
    const sub = usage(2, 'claude-opus-5-5', { scope: 'subagent', agentId: A, steps: 20 });
    // The main chat's requests are not the subagent's: they do not re-read what it removed.
    const main = usage(3, 'claude-opus-5-5', { steps: 50 });
    const ev = computeSavings([compact, sub, main]).events.find((e) => e.source === 'compact')!;
    expect(ev.estimate).toBe(false);
    expect(ev.laterRequests).toBe(10);
    expect(ev.amount).toBeCloseTo((100_000 * 10 * 0.2) / 1e6 - (100_000 * 5) / 1e6);
  });

  it('ends a subagent trim at the compaction of that subagent', () => {
    const A = 'agent-2';
    const trim: LedgerEntry = {
      ts: at(1),
      session: S,
      kind: 'trim',
      scope: 'subagent',
      agentId: A,
      trim: { tool: 'Bash', charsBefore: 35_000, charsAfter: 3_500, linesBefore: 900, linesAfter: 130, outcome: 'trimmed', jevChunks: 0 },
    };
    const later = usage(2, 'claude-opus-5-5', { scope: 'subagent', agentId: A, steps: 4 });
    const cut: LedgerEntry = {
      ts: at(3),
      session: S,
      kind: 'compact',
      scope: 'subagent',
      agentId: A,
      compaction: { charsBefore: 1, charsAfter: 1, ratio: 0, requests: 1, reason: 'window' },
    };
    const after = usage(4, 'claude-opus-5-5', { scope: 'subagent', agentId: A, steps: 40 });
    expect(computeSavings([trim, later, cut, after]).events.find((e) => e.source === 'trim')!.laterRequests).toBe(2);
  });

  it('ignores shadow sessions and skipped compactions', () => {
    const r = computeSavings([
      usage(1, 'claude-sonnet-5-5', { baseModel: 'claude-opus-5-5', applied: false }),
      { ts: at(2), session: S, kind: 'compact', text: 'skipped (return)', compaction: { charsBefore: 10, charsAfter: 10, ratio: 0, requests: 0, fallback: 'reduction 0% below 15%' } },
    ]);
    expect(r.totals.exact).toBe(0);
    expect(r.totals.turns).toBe(0);
  });

  it('marks what rests on the assumed baseline and breaks the cost down', () => {
    const legacy = usage(1, 'claude-sonnet-5-5');
    const recorded = usage(2, 'claude-sonnet-5-5', { baseModel: 'claude-opus-5-5', baseEffort: 'high', effort: 'high' });
    const r = computeSavings([legacy, recorded], { defaultBase: { model: 'claude-opus-5-5', effort: 'xhigh' } });
    const model = r.events.filter((e) => e.source === 'model');
    expect(model).toHaveLength(2);
    expect(model.find((e) => e.ts === legacy.ts)!.assumed).toBe('opus·xhigh');
    expect(model.find((e) => e.ts === recorded.ts)!.assumed).toBeUndefined();
    expect(r.totals.assumedTurns).toBe(1);
    expect(r.totals.assumed).toBeCloseTo(model.find((e) => e.ts === legacy.ts)!.amount);
    const c = r.totals.cost;
    expect(c.cacheRead).toBeCloseTo((2 * 200_000 * 0.2) / 1e6);
    expect(c.output).toBeCloseTo((2 * 5_000 * 10) / 1e6);
    expect(c.input + c.output + c.cacheRead + c.cacheWrite).toBeCloseTo(r.totals.actual);
  });
});
