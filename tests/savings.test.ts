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
  it('takes the model and effort as given: no saving or cost from the choice', () => {
    const down = usage(1, 'claude-sonnet-5-5', { baseModel: 'claude-opus-5-5', baseEffort: 'xhigh', effort: 'medium' });
    const up = usage(2, 'claude-opus-5-5', { baseModel: 'claude-haiku-5-5', baseEffort: 'low', effort: 'xhigh' });
    const r = computeSavings([down, up]);
    expect(r.events).toHaveLength(0);
    expect(r.totals.net).toBe(0);
    expect(r.totals.actual).toBeCloseTo(usageCost(down.usage!, 'sonnet', true) + usageCost(up.usage!, 'opus', true));
    expect(r.totals.withoutMod).toBeCloseTo(r.totals.actual);
    // Listed apart, for orientation.
    expect(r.routing.main.map((x) => `${x.model}·${x.effort}`)).toEqual(['opus·xhigh', 'sonnet·medium']);
    expect(r.routing.main[0]).toMatchObject({ turns: 1, steps: 4 });
  });

  it('leaves turns the mod did not route out of what it managed', () => {
    const r = computeSavings([usage(1, 'claude-sonnet-5-5', { unrouted: true }), usage(2, 'claude-opus-5-5')]);
    expect(r.totals.turns).toBe(1);
    expect(r.totals.actual).toBeCloseTo(usageCost(usage(2, 'claude-opus-5-5').usage!, 'opus', true));
  });

  it('values tools put behind ToolSearch by every later request of the chat, compactions or not', () => {
    const tools: LedgerEntry = { ts: at(1), session: S, kind: 'tools', tools: { deferred: ['Artifact', 'Workflow'], chars: 35_000 } };
    const cut: LedgerEntry = { ts: at(3), session: S, kind: 'compact', compaction: { charsBefore: 1, charsAfter: 1, ratio: 0, requests: 1, reason: 'threshold' } };
    const sub = usage(4, 'claude-sonnet-5-5', { scope: 'subagent', agentId: 'a', steps: 50 });
    const r = computeSavings([tools, usage(2, 'claude-sonnet-5-5', { steps: 4 }), cut, usage(5, 'claude-sonnet-5-5', { steps: 6 }), sub]);
    const ev = r.events.find((e) => e.source === 'tools')!;
    expect(ev).toMatchObject({ tokens: 10_000, laterRequests: 2 + 6, deferred: 2, estimate: false });
    expect(ev.amount).toBeCloseTo((10_000 * (8 * 0.2 + 4)) / 1e6);
    // Its tokens are not removed from the context: they never entered it.
    expect(r.totals.tokensRemoved).toBe(0);
  });

  it('deducts the mod’s own model calls and Jev from what it saved', () => {
    const call = (purpose: NonNullable<LedgerEntry['call']>['purpose'], model: string, m: number): LedgerEntry => ({
      ts: at(m),
      session: S,
      kind: 'mod-call',
      applied: false,
      call: { purpose, model, input: 10_000, output: 1_000, cacheRead: 0, cacheWrite: 0 },
    });
    const trim: LedgerEntry = {
      ts: at(1),
      session: S,
      kind: 'trim',
      scope: 'main',
      jevCost: 0.002,
      trim: { tool: 'Bash', charsBefore: 35_000, charsAfter: 3_500, linesBefore: 900, linesAfter: 40, outcome: 'tests passed', jevChunks: 0 },
    };
    const r = computeSavings([trim, usage(2, 'claude-sonnet-5-5', { steps: 4 }), call('autosave', 'claude-haiku-5-5', 3), call('draft', 'claude-sonnet-5-5', 4)]);
    const haiku = (10_000 * 0.1 + 1_000 * 0.5) / 1e6;
    const sonnet = (10_000 * 2 + 1_000 * 10) / 1e6;
    expect(r.totals.calls).toBeCloseTo(haiku + sonnet);
    expect(r.totals.jev).toBeCloseTo(0.002);
    expect(r.totals.spent).toBeCloseTo(haiku + sonnet + 0.002);
    expect(r.totals.net).toBeCloseTo(r.totals.saved - r.totals.spent);
    expect(r.byDay[0]!.spent).toBeCloseTo(r.totals.spent);
    expect(r.events.filter((e) => e.source === 'calls').map((e) => e.purpose).sort()).toEqual(['autosave', 'draft']);
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

  it('ignores shadow sessions and skipped compactions, and breaks the cost down', () => {
    const r = computeSavings([
      usage(1, 'claude-sonnet-5-5', { applied: false }),
      { ts: at(2), session: S, kind: 'compact', text: 'skipped (return)', compaction: { charsBefore: 10, charsAfter: 10, ratio: 0, requests: 0, fallback: 'reduction 0% below 15%' } },
      usage(3, 'claude-sonnet-5-5'),
    ]);
    expect(r.totals.exact).toBe(0);
    expect(r.totals.turns).toBe(1);
    const c = r.totals.cost;
    expect(c.cacheRead).toBeCloseTo((200_000 * 0.2) / 1e6);
    expect(c.output).toBeCloseTo((5_000 * 10) / 1e6);
    expect(c.input + c.output + c.cacheRead + c.cacheWrite).toBeCloseTo(r.totals.actual);
  });
});
