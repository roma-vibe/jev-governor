import { describe, expect, it } from 'vitest';

import { resolveConfig } from '../hooks/lib/config.ts';
import { addStepUsage, archiveOf, learnTurn, noteToolResult, S, stepKey, turnUsageParts } from '../hooks/mod/state.ts';
import {
  chooseEffort,
  decideMain,
  decideSubagent,
  escalate,
  fallbackDecision,
  looksLikeReading,
  isShortFollowUp,
  mainQuestions,
  readSignals,
  switchEconomics,
  tierOf,
  type Signals,
} from '../hooks/lib/router.ts';

const cfg = resolveConfig(undefined);

function signals(over: Partial<Signals> = {}): Signals {
  return { pStrong: 0.5, effortExpected: 1, effortConfidence: 0.9, risky: 0, continuation: 0, newTopic: 0, ...over };
}

describe('readSignals', () => {
  it('averages P(strong) over both option orders and reads the effort score', () => {
    const s = readSignals({
      tier_a: { choice: 'standard', confidence: 0.6, probabilities: { standard: 0.7, strong: 0.3 } },
      tier_b: { choice: 'strong', confidence: 0.6, probabilities: { strong: 0.5, standard: 0.5 } },
      effort: { score: 2, confidence: 0.9, probabilities: { '1': 0.2, '2': 0.8 } },
      risky: { noul: 0.1 },
      continuation: { noul: 0.05 },
      new_topic: { noul: 0.85 },
    });
    expect(s?.pStrong).toBeCloseTo(0.4);
    expect(s?.effortExpected).toBeCloseTo(1.8);
    expect(s?.risky).toBe(0.1);
    expect(s?.newTopic).toBe(0.85);
  });

  it('reads a missing new_topic answer as 0', () => {
    const s = readSignals({ tier_a: { choice: 'strong', confidence: 0.6, probabilities: { strong: 0.6, standard: 0.4 } } });
    expect(s?.newTopic).toBe(0);
  });

  it('is undefined without tier answers', () => {
    expect(readSignals({ risky: { noul: 0.2 } })).toBeUndefined();
  });
});

describe('decideMain', () => {
  const base = { freeSwitch: false, contextTokens: 120_000, pressure: 0 as const };

  it('downgrades opus to sonnet only where the cache is cold or small', () => {
    const easy = signals({ pStrong: 0.05 });
    expect(decideMain(easy, { ...base, currentTier: 'strong' }, cfg).tier).toBe('strong');
    expect(decideMain(easy, { ...base, currentTier: 'strong', freeSwitch: true }, cfg).tier).toBe('standard');
    expect(decideMain(easy, { ...base, currentTier: 'strong', contextTokens: 10_000 }, cfg).tier).toBe('standard');
  });

  it('upgrades a hard task to opus even with a warm cache when confident', () => {
    const hard = signals({ pStrong: 0.95 });
    const d = decideMain(hard, { ...base, currentTier: 'standard' }, cfg);
    expect(d.tier).toBe('strong');
    expect(d.switched).toBe(true);
  });

  it('needs a cold or small cache for a moderate upgrade', () => {
    const mid = signals({ pStrong: 0.65 });
    expect(decideMain(mid, { ...base, currentTier: 'standard' }, cfg).tier).toBe('standard');
    expect(decideMain(mid, { ...base, currentTier: 'standard', freeSwitch: true }, cfg).tier).toBe('strong');
  });

  it('never moves a context too large for sonnet', () => {
    const easy = signals({ pStrong: 0.0 });
    const d = decideMain(easy, { ...base, currentTier: 'strong', freeSwitch: true, contextTokens: 400_000 }, cfg);
    expect(d.tier).toBe('strong');
  });

  it('keeps the previous decision for a follow-up', () => {
    const d = decideMain(
      signals({ continuation: 0.9, pStrong: 0.0 }),
      { ...base, currentTier: 'strong', freeSwitch: true, previous: { tier: 'strong', effort: 'xhigh' } },
      cfg,
    );
    expect(d).toMatchObject({ tier: 'strong', effort: 'xhigh', switched: false });
  });

  it('changes nothing for a bare follow-up without a previous decision', () => {
    const d = decideMain(signals({ continuation: 0.97, pStrong: 0.0, effortExpected: 0 }), { ...base, currentTier: 'strong', freeSwitch: true }, cfg);
    expect(d).toMatchObject({ tier: 'strong', keepEffort: true, switched: false });
  });

  it('says why it keeps opus', () => {
    const d = decideMain(signals({ pStrong: 0.57, risky: 0.75 }), { ...base, currentTier: 'strong', freeSwitch: true }, cfg);
    expect(d.reasons.join()).toContain('kept opus: risky');
    const e = decideMain(signals({ pStrong: 0.5 }), { ...base, currentTier: 'strong', freeSwitch: true }, cfg);
    expect(e.reasons.join()).toContain('kept opus: P(sonnet)=0.50');
  });

  it('risky work goes to opus with at least high effort', () => {
    const d = decideMain(
      signals({ pStrong: 0.56, risky: 0.9, effortExpected: 0 }),
      { ...base, currentTier: 'standard' },
      cfg,
    );
    expect(d.tier).toBe('strong');
    expect(d.effort).toBe('high');
  });

  it('budget pressure raises the upgrade bar and eases downgrades', () => {
    const mid = signals({ pStrong: 0.6 });
    expect(decideMain(mid, { ...base, currentTier: 'standard', freeSwitch: true }, cfg).tier).toBe('strong');
    expect(decideMain(mid, { ...base, currentTier: 'standard', freeSwitch: true, pressure: 2 }, cfg).tier).toBe(
      'standard',
    );
    const lean = signals({ pStrong: 0.4 });
    expect(decideMain(lean, { ...base, currentTier: 'strong', freeSwitch: true }, cfg).tier).toBe('strong');
    expect(decideMain(lean, { ...base, currentTier: 'strong', pressure: 3, contextTokens: 100_000 }, cfg).tier).toBe(
      'standard',
    );
    // Critical pressure lowers the bar on P(sonnet), not on money: a rewrite that does not pay back
    // spends the very limit that is short.
    const costly = decideMain(lean, { ...base, currentTier: 'strong', pressure: 3, contextTokens: 170_000 }, cfg);
    expect(costly.tier).toBe('strong');
    expect(costly.reasons.join(' ')).toContain('kept opus');
  });

  it('leaves the model alone when model routing is off', () => {
    const off = resolveConfig({ router: { mainModel: false } });
    const d = decideMain(signals({ pStrong: 0.0 }), { ...base, currentTier: 'strong', freeSwitch: true }, off);
    expect(d.tier).toBe('strong');
  });
});

describe('effort', () => {
  it('follows a confident score, falls back when unsure, caps under pressure', () => {
    expect(chooseEffort(signals({ effortExpected: 3.2 }), 0, cfg, [])).toBe('xhigh');
    expect(chooseEffort(signals({ effortExpected: 3.2, effortConfidence: 0.2 }), 0, cfg, [])).toBe('medium');
    expect(chooseEffort(signals({ effortExpected: 4 }), 2, cfg, [])).toBe('high');
    expect(chooseEffort(signals({ effortExpected: 4 }), 3, cfg, [])).toBe('medium');
    expect(chooseEffort(signals({ effortExpected: 0, risky: 0.95 }), 3, cfg, [])).toBe('high');
  });

  it('rounds up between levels and never goes below medium by default', () => {
    expect(chooseEffort(signals({ effortExpected: 1.4 }), 0, cfg, [])).toBe('high');
    expect(chooseEffort(signals({ effortExpected: 0.1 }), 0, cfg, [])).toBe('medium');
    const lowAllowed = resolveConfig({ router: { minEffort: 'low' } });
    expect(chooseEffort(signals({ effortExpected: 0.1 }), 0, lowAllowed, [])).toBe('low');
  });

  it('respects configured bounds and escalates within them', () => {
    const bounded = resolveConfig({ router: { minEffort: 'medium', maxEffort: 'high' } });
    expect(chooseEffort(signals({ effortExpected: 0 }), 0, bounded, [])).toBe('medium');
    expect(chooseEffort(signals({ effortExpected: 4 }), 0, bounded, [])).toBe('high');
    expect(escalate('medium', 1, cfg)).toBe('high');
    expect(escalate('max', 2, cfg)).toBe('max');
    // Budget pressure caps the raise at its own cap, never below the chosen effort.
    expect(escalate('high', 2, cfg, 2)).toBe('high');
    expect(escalate('medium', 2, cfg, 2)).toBe('high');
    expect(escalate('high', 2, cfg, 3)).toBe('high');
    expect(escalate('high', 2, cfg, 1)).toBe('max');
  });
});

describe('decideSubagent', () => {
  it('chooses by P(strong) with a higher bar for search agents', () => {
    expect(decideSubagent(signals({ pStrong: 0.6 }), { pressure: 0, subagentType: 'general-purpose' }, cfg).tier).toBe(
      'strong',
    );
    expect(decideSubagent(signals({ pStrong: 0.6 }), { pressure: 0, subagentType: 'Explore' }, cfg).tier).toBe(
      'standard',
    );
  });

  it('does not send a read-only subagent to opus just because the task is risky', () => {
    const risky = signals({ pStrong: 0.15, risky: 0.81, effortExpected: 1 });
    const explore = decideSubagent(risky, { pressure: 0, subagentType: 'Explore' }, cfg);
    expect(explore).toMatchObject({ tier: 'standard', effort: 'high' });
    const reviewer = decideSubagent(risky, { pressure: 0, subagentType: 'general-purpose', readOnly: true }, cfg);
    expect(reviewer.tier).toBe('standard');
    const writer = decideSubagent(risky, { pressure: 0, subagentType: 'general-purpose' }, cfg);
    expect(writer.tier).toBe('strong');
  });

  it('sends an easy read-only subagent to the light model, but never a writer or a risky or harder task', () => {
    const on = resolveConfig({ router: { lightSubagents: 'on' } });
    const easy = signals({ pStrong: 0.05, effortExpected: 0 });
    const explore = decideSubagent(easy, { pressure: 0, subagentType: 'Explore' }, on);
    expect(explore).toMatchObject({ tier: 'standard', light: true });
    expect(explore.reasons.join(' ')).toContain('light model (used)');
    expect(decideSubagent(easy, { pressure: 0, subagentType: 'general-purpose', readOnly: true }, on).light).toBe(true);
    // It can edit: reading is not all it does.
    expect(decideSubagent(easy, { pressure: 0, subagentType: 'general-purpose' }, on).light).toBeUndefined();
    // Opus may be needed, the task is risky, or it needs real thinking.
    expect(decideSubagent(signals({ pStrong: 0.3 }), { pressure: 0, subagentType: 'Explore' }, on).light).toBeUndefined();
    expect(decideSubagent(signals({ pStrong: 0.05, risky: 0.9 }), { pressure: 0, subagentType: 'Explore' }, on).light).toBeUndefined();
    expect(decideSubagent(signals({ pStrong: 0.05, effortExpected: 3 }), { pressure: 0, subagentType: 'Explore' }, on).light).toBeUndefined();
    // An agent that pins its tier keeps it; off never marks one.
    expect(decideSubagent(easy, { pressure: 0, subagentType: 'Explore', pinnedTier: 'standard' }, on).light).toBeUndefined();
    const off = resolveConfig({ router: { lightSubagents: 'off' } });
    expect(decideSubagent(easy, { pressure: 0, subagentType: 'Explore' }, off).light).toBeUndefined();
  });

  it('honours an agent pinned tier and effort', () => {
    const d = decideSubagent(
      signals({ pStrong: 0.0 }),
      { pressure: 0, subagentType: 'jev-governor:x', pinnedTier: 'strong', pinnedEffort: 'low' },
      cfg,
    );
    expect(d).toMatchObject({ tier: 'strong', effort: 'low' });
  });
});

describe('fallbackDecision', () => {
  it('keeps the tier and takes fallbackEffort within the effort bounds; a pinned effort wins', () => {
    expect(fallbackDecision('strong', 'Jev unavailable', cfg)).toMatchObject({ tier: 'strong', effort: 'high', switched: false });
    expect(fallbackDecision('standard', 'x', cfg, 'low')).toMatchObject({ tier: 'standard', effort: 'low' });
    const capped = resolveConfig({ router: { fallbackEffort: 'xhigh', maxEffort: 'high' } });
    expect(fallbackDecision('strong', 'x', capped).effort).toBe('high');
    expect(fallbackDecision('strong', 'Jev unavailable', cfg).reasons[0]).toContain('(fallback)');
  });
});

describe('looksLikeReading', () => {
  it('matches research-like titles, not build tasks', () => {
    for (const t of ['Research FLUX API', 'Explore the repo', 'Audit auth flow', ' review PR', '#12 Find callers', 'Look up the docs']) expect(looksLikeReading(t)).toBe(true);
    for (const t of ['#4 AI providers+ connectors', 'Wave 0 frontend shell', 'Fix the parser', 'Researcher agent scaffold']) expect(looksLikeReading(t)).toBe(false);
  });
});

describe('tierOf', () => {
  it('classifies model ids and aliases', () => {
    expect(tierOf('claude-opus-5-5[1m]', cfg)).toBe('strong');
    expect(tierOf('sonnet', cfg)).toBe('standard');
    expect(tierOf('claude-haiku-4-5', cfg)).toBeUndefined();
  });
});

describe('short follow-ups', () => {
  it('recognizes a bare go-on in Russian and English', () => {
    for (const t of ['да', 'Ок!', 'давай', 'да, давай', 'продолжай.', 'го', 'go on', 'Do it', 'yes please', 'ну давай дальше']) {
      expect(isShortFollowUp(t), t).toBe(true);
    }
  });

  it('leaves anything with content of its own to Jev', () => {
    for (const t of ['нет', 'да, но поправь тесты', 'continue with the migration', 'давай сделаем деплой', '', 'ок, а почему упал CI?', 'да?', 'ok?', 'it', 'do', 'on']) {
      expect(isShortFollowUp(t), t).toBe(false);
    }
  });
});

describe('switchEconomics', () => {
  const ctx = { freeSwitch: false, contextTokens: 430_000 };

  it('a warm 430k context costs more to move than Sonnet saves in a few turns', () => {
    const m = switchEconomics('strong', 'standard', ctx, cfg);
    expect(m.cost).toBeCloseTo((430_000 * (4 - 0.2)) / 1e6);
    expect(m.gain).toBeCloseTo(((4_000 * 10 + 15_000 * 4) / 1e6) * cfg.router.expectedTurns);
    expect(m.gain).toBeLessThan(m.cost);
  });

  it('a cold cache makes moving to Sonnet pay at once', () => {
    const m = switchEconomics('strong', 'standard', { ...ctx, freeSwitch: true }, cfg);
    expect(m.cost).toBeLessThan(0);
  });

  it('uses the learned turn profile and says why in the decision', () => {
    const heavy = { output: 40_000, cacheWrite: 120_000 };
    const d = decideMain(
      signals({ pStrong: 0.05 }),
      { currentTier: 'strong', freeSwitch: false, contextTokens: 150_000, pressure: 0, turnProfile: heavy },
      cfg,
    );
    expect(d.tier).toBe('standard');
    expect(d.reasons.join()).toMatch(/switch \$0\.57 vs gain \$\d/);
    const light = decideMain(
      signals({ pStrong: 0.05 }),
      { currentTier: 'strong', freeSwitch: false, contextTokens: 150_000, pressure: 0 },
      cfg,
    );
    expect(light.tier).toBe('strong');
    expect(light.reasons.join()).toContain('kept opus: switch $0.57 vs gain $0.40 over 4 turns');
  });

  it('a turn that re-wrote the whole cache does not inflate the learned profile', () => {
    S.route = { freeSwitch: false, turnProfile: { output: 4_000, cacheWrite: 15_000 } };
    learnTurn({ output_tokens: 4_000, cache_creation_input_tokens: 150_000 }, true);
    expect(S.route.turnProfile).toEqual({ output: 4_000, cacheWrite: 15_000 });
    const warm = { currentTier: 'strong' as const, freeSwitch: false, contextTokens: 150_000, pressure: 0 as const };
    expect(decideMain(signals({ pStrong: 0.05 }), { ...warm, turnProfile: S.route.turnProfile }, cfg).tier).toBe('strong');
    // The same turn on a warm cache is real per-turn writing and counts, as at most 3× the
    // profile: one very long turn does not make every switch after it look worth it.
    learnTurn({ output_tokens: 4_000, cache_creation_input_tokens: 150_000 });
    expect(S.route.turnProfile?.cacheWrite).toBe(15_000 * 0.7 + 45_000 * 0.3);
  });
});

describe('correction signal', () => {
  it('is asked every turn and read as a probability', () => {
    expect(Object.keys(mainQuestions())).toContain('correction');
    const s = readSignals({
      tier_a: { choice: 'strong', confidence: 0.6, probabilities: { strong: 0.6, standard: 0.4 } },
      correction: { noul: 0.8 },
    });
    expect(s?.correction).toBe(0.8);
  });
});

describe('turn usage and tool errors (0.3.4)', () => {
  const u = (model: string, read: number) => ({ model, input_tokens: 1, output_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: 5 });

  it('sums step usage per model, the model the turn ended on last; the turn figure only when larger', () => {
    S.stepUsage.clear();
    const key = stepKey('t1', 'sub');
    addStepUsage(key, u('haiku', 100));
    addStepUsage(key, u('sonnet', 300));
    addStepUsage(key, u('haiku', 100));
    addStepUsage(key, null);
    const parts = turnUsageParts(u('sonnet', 300), S.stepUsage.get(key));
    expect(parts.map((p) => [p.model, p.usage.cache_read_input_tokens, p.steps, p.from])).toEqual([
      ['haiku', 200, 2, 'steps'],
      ['sonnet', 300, 1, 'steps'],
    ]);
    // One model: no per-part steps (the turn's own step count stands).
    expect(turnUsageParts(u('x', 1), new Map([['x', { steps: 3, input_tokens: 3, output_tokens: 30, cache_read_input_tokens: 900, cache_creation_input_tokens: 15 }]]))[0]).toMatchObject({ from: 'steps', usage: { cache_read_input_tokens: 900 } });
    expect(turnUsageParts(u('x', 5000), new Map([['x', { steps: 1, input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }]]))[0]).toMatchObject({ from: 'turn', usage: { cache_read_input_tokens: 5000 } });
    expect(turnUsageParts(undefined, undefined)).toEqual([]);
  });

  it('counts failures within the window and never lowers the count', () => {
    const t = { errors: 0 };
    for (const failed of [true, false, false, false, false, false, false, true]) noteToolResult(t, failed, 6);
    expect(t.errors).toBe(1);
    for (const failed of [true, false, true]) noteToolResult(t, failed, 6);
    expect(t.errors).toBe(3);
    for (let i = 0; i < 10; i++) noteToolResult(t, false, 6);
    expect(t.errors).toBe(3);
    // Five windows in a row without a failure end the raise; a new cluster raises again.
    for (let i = 0; i < 19; i++) noteToolResult(t, false, 6);
    expect(t.errors).toBe(3);
    noteToolResult(t, false, 6);
    expect(t.errors).toBe(0);
    for (const failed of [true, true]) noteToolResult(t, failed, 6);
    expect(t.errors).toBe(2);
    const whole = { errors: 0 };
    for (const failed of [true, false, false, false, false, false, false, true]) noteToolResult(whole, failed, 0);
    expect(whole.errors).toBe(2);
  });

  it('tells which saved text a read goes to', () => {
    const d = '/h/.claude/jev-governor';
    expect(archiveOf(`D=${d}/outputs/s-1/pruned; cat $D/toolu_1.txt`, d)).toBe('pruned');
    expect(archiveOf(`cat ${d}/outputs/s-1/folded/a.md`, d)).toBe('folded');
    expect(archiveOf(`cat ${d}/outputs/s-1/toolu_1.txt`, d)).toBe('trim');
    expect(archiveOf('/p/s/tool-results/x.txt', d)).toBe('tool-results');
  });
});
