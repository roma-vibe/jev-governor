import { describe, expect, it } from 'vitest';

import { applyRole, briefQuestions, briefVerdict, denyText, readBrief, scopeNote, withScopeNote, type BriefSignals } from '../hooks/lib/brief.ts';
import { resolveConfig } from '../hooks/lib/config.ts';
import type { Decision } from '../hooks/lib/router.ts';

const cfg = (agents: Record<string, unknown> = {}, router: Record<string, unknown> = {}) => resolveConfig({ agents, router });
const signals = (patch: Partial<BriefSignals> = {}): BriefSignals => ({
  complete: 0.8,
  tooBig: 0.1,
  steps: 30,
  roles: { plan_review: 0.1, implement: 0.8, docs_tests: 0.1 },
  role: 'implement',
  roleP: 0.8,
  ...patch,
});
const decision = (patch: Partial<Decision> = {}): Decision => ({ tier: 'strong', effort: 'high', switched: false, reasons: [], ...patch });
const ctx = { pinnedTier: false, pStrong: 0.6, risky: 0.1 };

describe('scope note', () => {
  it('names the file size and is added once', () => {
    expect(scopeNote(250)).toContain('under about 250 lines');
    const once = withScopeNote('Do the job.', 300);
    expect(once.startsWith('Do the job.')).toBe(true);
    expect(withScopeNote(once, 300)).toBe(once);
  });
});

describe('readBrief', () => {
  it('reads complete, too big, steps and the role over both option orders', () => {
    const answers = {
      brief_complete: { noul: 0.9 },
      too_big: { noul: 0.2 },
      steps: { score: 3, confidence: 0.9, probabilities: { '3': 1 } },
      role_a: { choice: 'implement', confidence: 0.9, probabilities: { implement: 0.8, docs_tests: 0.2 } },
      role_b: { choice: 'implement', confidence: 0.9, probabilities: { implement: 0.6, plan_review: 0.2, docs_tests: 0.2 } },
    };
    const b = readBrief(answers)!;
    expect(b.complete).toBe(0.9);
    expect(b.steps).toBe(250);
    expect(b.role).toBe('implement');
    expect(b.roleP).toBeCloseTo(0.7);
  });
  it('is undefined when Jev answered none of the brief questions', () => {
    expect(readBrief({ tier_a: { choice: 'strong', confidence: 1, probabilities: { strong: 1 } } })).toBeUndefined();
  });
  it('asks every question the reading needs', () => {
    expect(Object.keys(briefQuestions()).sort()).toEqual(['brief_complete', 'role_a', 'role_b', 'steps', 'too_big']);
  });
});

describe('briefVerdict', () => {
  it('too big needs both the probability and the expected steps', () => {
    const c = cfg();
    expect(briefVerdict(signals({ tooBig: 0.9, steps: 250 }), c, false)).toBe('big');
    expect(briefVerdict(signals({ tooBig: 0.9, steps: 30 }), c, false)).toBe('ok');
    expect(briefVerdict(signals({ tooBig: 0.3, steps: 600 }), c, false)).toBe('ok');
  });
  it('a thin brief matters only for a lighter model', () => {
    const c = cfg();
    expect(briefVerdict(signals({ complete: 0.1 }), c, true)).toBe('weak');
    expect(briefVerdict(signals({ complete: 0.1 }), c, false)).toBe('ok');
    expect(briefVerdict(signals({ complete: 0.9 }), c, true)).toBe('ok');
  });
  it('the refusal carries the template and says it is sent once', () => {
    const text = denyText('big', signals({ tooBig: 0.9, steps: 600 }));
    expect(text).toContain('Split it into narrow subagents');
    expect(text).toContain('Done when:');
    expect(text).toContain('goes through');
  });
});

describe('applyRole', () => {
  const on = cfg({}, { roles: 'on' });
  it('does nothing when off, when the role is unsure, or when the tier is pinned', () => {
    expect(applyRole(decision(), signals(), ctx, cfg({}, { roles: 'off' })).would).toBe('none');
    expect(applyRole(decision(), signals({ roleP: 0.3 }), ctx, on).would).toBe('none');
    expect(applyRole(decision(), signals(), { ...ctx, pinnedTier: true }, on).would).toBe('none');
  });
  it('implementing a complete brief goes to the standard tier', () => {
    const r = applyRole(decision(), signals(), ctx, on);
    expect(r.would).toBe('standard');
    expect(r.decision.tier).toBe('standard');
    expect(r.decision.light).toBe(false);
  });
  it('keeps the tier when risky, when the brief is thin, or when Jev is sure Opus is needed', () => {
    expect(applyRole(decision(), signals(), { ...ctx, risky: 0.9 }, on).decision.tier).toBe('strong');
    expect(applyRole(decision(), signals({ complete: 0.3 }), ctx, on).decision.tier).toBe('strong');
    expect(applyRole(decision(), signals(), { ...ctx, pStrong: 0.97 }, on).decision.tier).toBe('strong');
  });
  it('planning and review stay on, or go back to, the strong tier', () => {
    const plan = signals({ role: 'plan_review', roleP: 0.9 });
    expect(applyRole(decision({ tier: 'strong' }), plan, ctx, on).decision.tier).toBe('strong');
    const up = applyRole(decision({ tier: 'standard', light: true }), plan, ctx, on);
    expect(up.decision).toMatchObject({ tier: 'strong', light: false });
  });
  it('docs and simple tests go to the light model unless light is off or the effort is high', () => {
    const docs = signals({ role: 'docs_tests', roleP: 0.9 });
    expect(applyRole(decision({ effort: 'medium' }), docs, ctx, on).decision.light).toBe(true);
    expect(applyRole(decision({ effort: 'xhigh' }), docs, ctx, on)).toMatchObject({ would: 'standard' });
    const noLight = cfg({}, { roles: 'on', lightSubagents: 'off' });
    expect(applyRole(decision({ effort: 'medium' }), docs, ctx, noLight).would).toBe('standard');
  });
});
