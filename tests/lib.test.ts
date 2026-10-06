import { describe, expect, it } from 'vitest';

import { budgetPressure, windowPace } from '../hooks/lib/budget.ts';
import { isShadow, resolveConfig } from '../hooks/lib/config.ts';
import { clip, estimateContextTokens, recentHistory } from '../hooks/lib/history.ts';
import { jevAsker, parseJevResponse, score, withTimeout } from '../hooks/lib/jev.ts';
import {
  agentQuestion,
  composePrompt,
  NONE,
  parseDraft,
  rankCandidates,
  sanitizeAgent,
  uniqueName,
  withRolePreamble,
  withWaitNote,
} from '../hooks/lib/registry.ts';
import type { AgentRecord, SkillRecord } from '../hooks/lib/types.ts';

const NOW = '2026-10-05T12:00:00.000Z';

describe('budget pressure', () => {
  const now = Date.parse(NOW);
  const resets = (hours: number) => new Date(now + hours * 3600_000).toISOString();

  it('is relaxed when on pace', () => {
    // 7-day window, 3.5 days left (50% elapsed), 45% used.
    expect(windowPace({ kind: 'seven_day', percentUsed: 45, resetsAt: resets(84) }, now).pressure).toBe(0);
  });

  it('rises when burning ahead of pace or near the cap', () => {
    // 6 days left (~14% elapsed) but 45% used: far ahead.
    expect(windowPace({ kind: 'seven_day', percentUsed: 45, resetsAt: resets(144) }, now).pressure).toBe(2);
    expect(windowPace({ kind: 'five_hour', percentUsed: 96 }, now).pressure).toBe(3);
    expect(windowPace({ kind: 'five_hour', percentUsed: 20, resetsAt: resets(4.9) }, now).pressure).toBe(0);
  });

  it('takes the worst window', () => {
    const { pressure } = budgetPressure(
      [
        { kind: 'five_hour', percentUsed: 10, resetsAt: resets(1) },
        { kind: 'seven_day', percentUsed: 88, resetsAt: resets(10) },
      ],
      now,
    );
    expect(pressure).toBe(2);
  });
});

describe('config', () => {
  it('fills defaults, clamps numbers and drops junk', () => {
    const c = resolveConfig({ router: { upgradeAt: 7, minEffort: 'high', maxEffort: 'low' }, jev: { timeoutMs: 'x' } });
    expect(c.router.upgradeAt).toBe(1);
    expect(c.router.maxEffort).toBe('high');
    expect(c.jev.timeoutMs).toBe(2500);
    expect(c.models.strong).toBe('claude-opus-5-5');
  });
});

describe('shadow mode', () => {
  it('applies globally or by path prefix', () => {
    const byPath = resolveConfig({ shadowPaths: ['~/ab/fastdev-A/'] });
    expect(isShadow(byPath, '/Users/r/ab/fastdev-A', '/Users/r')).toBe(true);
    expect(isShadow(byPath, '/Users/r/ab/fastdev-A/src', '/Users/r')).toBe(true);
    expect(isShadow(byPath, '/Users/r/ab/fastdev-AB', '/Users/r')).toBe(false);
    expect(isShadow(resolveConfig({ mode: 'shadow' }), '/x', '/h')).toBe(true);
    expect(isShadow(resolveConfig({}), '/x', '/h')).toBe(false);
    const onlyB = resolveConfig({ mode: 'shadow', activePaths: ['/ab/fastdev-B'] });
    expect(isShadow(onlyB, '/ab/fastdev-B/src', '/h')).toBe(false);
    expect(isShadow(onlyB, '/work/other', '/h')).toBe(true);
  });
});

describe('jev protocol', () => {
  it('builds the request and parses answers', async () => {
    let seen: { url: string; body: string } | undefined;
    const asker = jevAsker({
      endpoint: 'https://example.test/systemone',
      apiKey: 'k',
      model: 'jev-latest',
      http: async (url, init) => {
        seen = { url, body: init.body };
        return { status: 200, ok: true, text: JSON.stringify({ answers: { q: { noul: 0.7 } } }) };
      },
    });
    const response = await asker.ask({ a: 1 }, { q: { type: 'noul', instructions: 'x' } });
    expect(seen?.url).toBe('https://example.test/systemone');
    expect(JSON.parse(seen!.body)).toMatchObject({ model: 'jev-latest', state: { a: 1 } });
    expect(response.answers.q).toEqual({ noul: 0.7 });
  });

  it('rejects failures and malformed bodies', () => {
    expect(() => parseJevResponse(500, false, 'boom')).toThrow(/500/);
    expect(() => parseJevResponse(200, true, '{')).toThrow(/malformed/);
    expect(() => parseJevResponse(200, true, '{}')).toThrow(/answers/);
  });

  it('reads a score as its expected level', () => {
    const s = score({ e: { score: 2, confidence: 0.9, probabilities: { '0': 0, '1': 0.5, '2': 0.5 } } }, 'e');
    expect(s?.expected).toBeCloseTo(1.5);
  });

  it('times out', async () => {
    const never = new Promise<number>(() => undefined);
    await expect(withTimeout(never, () => Promise.resolve(), 10)).rejects.toThrow(/timeout/);
  });
});

describe('history', () => {
  const messages = [
    { role: 'user' as const, text: 'Fix the flaky test in envfile', toolUses: [] },
    {
      role: 'assistant' as const,
      text: 'Running it.',
      toolUses: [{ tool: 'Bash', input: { command: 'cargo test -p fastdev-core envfile::' }, isError: true }],
    },
    { role: 'user' as const, text: '', toolUses: [], toolResults: [{ isError: true }] },
    { role: 'user' as const, text: 'yes, do it', toolUses: [] },
  ];

  it('estimates context before the engine knows it, and unwraps pasted text', () => {
    expect(estimateContextTokens([])).toBe(30_000);
    expect(estimateContextTokens([{ role: 'user', text: 'x'.repeat(3500), toolUses: [] }])).toBe(31_000);
    expect(clip('<pasted_content id="ab12">\nFix it</pasted_content>', 50)).toBe('Fix it');
  });

  it('abridges recent messages and leaves the latest prompt out', () => {
    const lines = recentHistory(messages, { maxTokens: 1000, maxMessages: 10, latest: 'yes, do it' });
    expect(lines[0]).toBe('user: Fix the flaky test in envfile');
    expect(lines[1]).toContain('Bash(cargo test -p fastdev-core envfile::) → error');
    expect(lines.join('\n')).not.toContain('yes, do it');
  });

});

describe('registry', () => {
  it('withWaitNote appends the cache note once, after the task', () => {
    const once = withWaitNote('Review the skeleton.');
    expect(once.startsWith('Review the skeleton.')).toBe(true);
    expect(once).toContain('<cache-note>');
    expect(withWaitNote(once)).toBe(once);
  });

  const agent = (name: string, description: string): AgentRecord => ({
    name,
    description,
    prompt: 'Do the thing.',
    skills: [],
    tier: 'auto',
    effort: 'auto',
    enabled: true,
    origin: 'auto',
    createdAt: NOW,
    updatedAt: NOW,
  });

  it('validates agents', () => {
    expect(sanitizeAgent({ name: 'Bad Name', description: 'x', prompt: 'y' }, NOW)).toBeUndefined();
    expect(sanitizeAgent({ name: 'ok-name', description: 'x', prompt: 'y', tier: 'huge' }, NOW)?.tier).toBe('auto');
  });

  it('ranks related agents first and always offers none', () => {
    const agents = [agent('vue-ui-builder', 'Builds Vue components'), agent('rust-test-fixer', 'Fixes failing Rust tests in Cargo crates')];
    const ranked = rankCandidates(agents, 'cargo test fails in fastdev-core crate', 5);
    expect(ranked[0]?.name).toBe('rust-test-fixer');
    const q = agentQuestion(ranked, () => 0.5);
    expect(Object.keys(q.criteria)).toContain(NONE);
    expect(Object.keys(q.criteria).at(-1)).toBe(NONE);
  });

  it('composes skills into the prompt', () => {
    const skill: SkillRecord = { name: 'cargo-offline', description: 'd', body: 'Use --offline.', origin: 'auto', createdAt: NOW, updatedAt: NOW };
    const composed = composePrompt({ ...agent('a-b', 'd'), skills: ['cargo-offline', 'missing'] }, new Map([[skill.name, skill]]));
    expect(composed).toBe('Do the thing.\n\n## Skill: cargo-offline\nUse --offline.');
  });

  it('parses a drafted agent, reusing and creating skills, with unique names', () => {
    const existingSkill: SkillRecord = { name: 'cargo-offline', description: 'd', body: 'b', origin: 'auto', createdAt: NOW, updatedAt: NOW };
    const reply = 'Here:\n```json\n' +
      JSON.stringify({
        name: 'Rust Test Fixer',
        description: 'Use for failing Rust tests.',
        prompt: 'You fix failing Rust tests. Reproduce, find root cause, fix, rerun. Report the cause and diff.',
        tools: ['Read', 'Bash', 'Edit', 'Teleport'],
        reuse_skills: ['cargo-offline', 'nope'],
        new_skills: [{ name: 'fastdev crates', description: 'Crate layout', body: 'Run tests per crate with -p.' }],
      }) + '\n```';
    const parsed = parseDraft(reply, { agents: new Set(['rust-test-fixer']), skills: new Map([[existingSkill.name, existingSkill]]) }, NOW);
    expect(parsed?.agent.name).toBe('rust-test-fixer-2');
    expect(parsed?.agent.tools).toEqual(['Read', 'Bash', 'Edit']);
    expect(parsed?.agent.skills).toEqual(['cargo-offline', 'fastdev-crates']);
    expect(parsed?.skills.map((s) => s.name)).toEqual(['fastdev-crates']);
    expect(parseDraft('no json here', { agents: new Set(), skills: new Map() }, NOW)).toBeUndefined();
  });

  it('puts the role, skills and tool list in front of the task', () => {
    const text = withRolePreamble({ ...agent('ro', 'd'), tools: ['Read', 'Grep'] }, new Map(), 'Do X.');
    expect(text).toBe('<role>\nDo the thing.\n\nUse only these tools: Read, Grep.\n</role>\n\n<task>\nDo X.\n</task>');
  });

  it('makes unique names', () => {
    expect(uniqueName('x-y', new Set(['x-y', 'x-y-2']))).toBe('x-y-3');
  });
});
