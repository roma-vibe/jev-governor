import { describe, expect, it } from 'vitest';

import {
  attachedPrompt,
  BRIEF_MARKER,
  briefPrompt,
  buildSkeleton,
  candidateTurns,
  capsuleId,
  cleanText,
  CTX_REF,
  parseGetctxArgs,
  pastePrompt,
  planTurns,
  projectSlug,
  renderCapsule,
  turnQuestions,
  type CapsuleMessage,
  type CapsuleMeta,
  type Turn,
} from '../hooks/lib/capsule.ts';

function user(text: string): CapsuleMessage {
  return { role: 'user', text, toolUses: [] };
}

function assistant(text: string, toolUses: CapsuleMessage['toolUses'] = []): CapsuleMessage {
  return { role: 'assistant', text, toolUses };
}

function results(...items: { tool_use_id: string; text: string; isError?: boolean }[]): CapsuleMessage {
  return { role: 'user', text: '', toolUses: [], toolResults: items };
}

const META: CapsuleMeta = {
  id: '20261005-1912-a3f0',
  project: 'aiCompaction',
  cwd: '/p/aiCompaction',
  session: 's1',
  createdAt: '2026-10-05T19:12:00.000Z',
  focus: '',
};

describe('cleanText', () => {
  it('drops engine wrappers and keeps what the person typed', () => {
    const text = '<system-reminder>memory: x</system-reminder>\nпочини тесты\n<command-name>/jevg</command-name><command-args>getctx</command-args>';
    expect(cleanText(text)).toBe('почини тесты');
    expect(cleanText('<pasted_content id="1">log</pasted_content> что это?')).toBe('log что это?');
  });
});

describe('buildSkeleton', () => {
  const messages: CapsuleMessage[] = [
    user('<system-reminder>context</system-reminder>Добавь архив в сжатие'),
    assistant('Смотрю код.', [{ tool_use_id: 'a', tool: 'Read', input: { file_path: '/p/hooks/register.ts' } }]),
    results({ tool_use_id: 'a', text: 'code' }),
    assistant('', [
      { tool_use_id: 'b', tool: 'Edit', input: { file_path: '/p/hooks/register.ts', old_string: 'x', new_string: 'y' } },
      { tool_use_id: 'c', tool: 'Bash', input: { command: 'npx vitest run' } },
    ]),
    results({ tool_use_id: 'b', text: 'ok' }, { tool_use_id: 'c', text: '      Tests  60 passed (60)\n' }),
    assistant('Готово: архив пишется в outputs/pruned.'),
    user(`${BRIEF_MARKER} The person is moving this work…`),
    assistant('**Goal** …'),
    user('теперь капсула'),
    assistant('', [{ tool_use_id: 'd', tool: 'Write', input: { file_path: '/p/hooks/lib/capsule.ts', content: '…' } }]),
    results({ tool_use_id: 'd', text: 'File created' }),
    assistant('', [{ tool_use_id: 'e', tool: 'Bash', input: { command: 'npx vitest run' } }]),
    results({ tool_use_id: 'e', text: ' FAIL  tests/capsule.test.ts > x\n      Tests  1 failed | 60 passed (61)\n', isError: true }),
    assistant('Один тест падает, чиню.'),
  ];
  const skeleton = buildSkeleton(messages);

  it('splits turns at typed prompts and skips the brief turn', () => {
    expect(skeleton.turns.map((t) => t.user)).toEqual(['Добавь архив в сжатие', 'теперь капсула']);
    expect(skeleton.turns[0]!.answer).toBe('Готово: архив пишется в outputs/pruned.');
    expect(skeleton.turns[1]!.answer).toBe('Один тест падает, чиню.');
    expect(skeleton.turns[1]!.errors).toBe(1);
  });

  it('collects changed files and the latest check per command', () => {
    expect(skeleton.files.map((f) => [f.path, f.edits, f.lastTurn])).toEqual([
      ['/p/hooks/register.ts', 1, 1],
      ['/p/hooks/lib/capsule.ts', 1, 2],
    ]);
    expect(skeleton.checks).toHaveLength(1);
    expect(skeleton.checks[0]!.outcome).toContain('tests FAILED (60 passed, 1 failed)');
    expect(skeleton.checks[0]!.failed).toBe(true);
    expect(skeleton.checks[0]!.turn).toBe(2);
  });

  it('lists files relative to the project and only checks with a result', () => {
    const s = buildSkeleton(
      [
        user('go'),
        assistant('', [
          { tool_use_id: 'w', tool: 'Write', input: { file_path: '/p/src/a.ts', content: 'x' } },
          { tool_use_id: 'x', tool: 'Bash', input: { command: "python3 - <<'PY'\n# run the tests after\nPY" } },
          { tool_use_id: 'y', tool: 'Bash', input: { command: 'npm run build' } },
          { tool_use_id: 'z', tool: 'Bash', input: { command: 'cd /p && cargo test 2>&1 | tail -3' } },
          { tool_use_id: 'v', tool: 'Bash', input: { command: 'cd /p && cat scripts/check.mjs | head' } },
        ]),
        results(
          { tool_use_id: 'w', text: 'ok' },
          { tool_use_id: 'x', text: 'Tests  3 passed (3)' },
          { tool_use_id: 'y', text: 'built in 2s' },
          { tool_use_id: 'z', text: 'test result: ok. 4 passed; 0 failed; 0 ignored' },
          { tool_use_id: 'v', text: 'no such file', isError: true },
        ),
        assistant('done'),
      ],
      '/p',
    );
    expect(s.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(s.checks.map((c) => [c.command, c.outcome])).toEqual([['cargo test 2>&1 | tail -3', 'tests passed (4 passed, 0 failed)']]);
  });

  it('keeps a Claude Code compaction summary apart from the turns', () => {
    const s = buildSkeleton([
      user('This session is being continued from a previous conversation that ran out of context. Summary: …'),
      user('продолжай'),
      assistant('Продолжаю.'),
    ]);
    expect(s.summary).toMatch(/^This session is being continued/);
    expect(s.turns.map((t) => t.user)).toEqual(['продолжай']);
  });
});

function turns(count: number, size = 3000): Turn[] {
  return Array.from({ length: count }, (_, i) => ({
    n: i + 1,
    user: `request ${i + 1} ${'word '.repeat(size / 5)}`,
    answer: `answer ${i + 1} ${'done '.repeat(size / 5)}`,
    calls: 3,
    errors: 0,
    edited: [],
  }));
}

describe('planTurns', () => {
  it('keeps the newest two whole and the rest by recency', () => {
    const plans = planTurns(turns(10, 100), 1_000_000);
    expect(plans.get(10)).toBe('full');
    expect(plans.get(9)).toBe('full');
    expect(plans.get(8)).toBe('gist');
    expect(plans.get(2)).toBe('line');
    // The first turn is usually the task itself: at least condensed.
    expect(plans.get(1)).toBe('gist');
  });

  it("follows Jev's need for older turns", () => {
    const plans = planTurns(turns(10, 100), 1_000_000, new Map([[1, 0.9], [8, 0.1]]));
    expect(plans.get(1)).toBe('full');
    expect(plans.get(8)).toBe('line');
  });

  it('without Jev cuts the oldest first, keeping the first turn and the newest two', () => {
    const plans = planTurns(turns(80), 3_000);
    expect(plans.get(80)).not.toBe('omit');
    expect(plans.get(79)).not.toBe('omit');
    expect(plans.get(1)).not.toBe('omit');
    expect(plans.get(2)).toBe('omit');
    const firstKept = [...plans.entries()].find(([n, p]) => n > 1 && p !== 'omit')![0];
    for (let n = firstKept; n <= 80; n++) expect(plans.get(n)).not.toBe('omit');
  });

  it("with Jev cuts the least needed turns first, whatever their age", () => {
    const need = new Map(Array.from({ length: 78 }, (_, i) => [i + 1, i + 1 === 5 ? 0.95 : i + 1 === 60 ? 0.05 : 0.5] as [number, number]));
    const plans = planTurns(turns(80), 3_000, need);
    expect(plans.get(60)).toBe('omit');
    expect(plans.get(5)).not.toBe('omit');
  });
});

describe('renderCapsule', () => {
  it('stays near the budget for a long session and names its sources', () => {
    const skeleton = { turns: turns(80), files: [{ path: '/p/a.ts', edits: 3, lastTurn: 70 }], checks: [] };
    const meta = { ...META, transcript: '/h/.claude/projects/-p/s1.jsonl', focus: 'UI проектов' };
    const out = renderCapsule({ meta, skeleton, plans: planTurns(skeleton.turns, 10_000), brief: '**Goal** ship it' });
    expect(out.tokens).toBeLessThan(13_000);
    expect(out.text).toContain('jev-ctx:20261005-1912-a3f0');
    expect(out.text).toContain('## Brief from the previous chat');
    expect(out.text).toContain('full transcript of the previous chat: /h/.claude/projects/-p/s1.jsonl');
    expect(out.text).toContain('Focus: UI проектов');
    expect(out.text).toContain('- /p/a.ts (3 edits, last in turn 70)');
    expect(out.text).toContain('### Turn 80');
    expect(out.text).toContain('### Turn 1 (condensed)');
    expect(out.text).toContain('- Turn 2: request 2');
  });

  it('says when the oldest turns did not fit', () => {
    const skeleton = { turns: turns(80), files: [], checks: [] };
    const out = renderCapsule({ meta: META, skeleton, plans: planTurns(skeleton.turns, 3_000) });
    expect(out.text).toContain('least needed are left out');
    expect(out.tokens).toBeLessThan(4_000);
  });
});

describe('Jev turn selection', () => {
  it('asks about older turns only, newest 60 at most', () => {
    const all = turns(100, 50);
    const candidates = candidateTurns(all);
    expect(candidates).toHaveLength(60);
    expect(candidates.at(-1)!.n).toBe(98);
    expect(Object.keys(turnQuestions(candidates))).toContain('need_t98');
  });
});

describe('paste prompt', () => {
  it('carries the reference, the file and the focus; attaching drops the read hint', () => {
    const prompt = pastePrompt({ id: META.id, focus: 'UI' }, '/d/handoffs/20261005-1912-a3f0.md', 'Добавь архив');
    expect(CTX_REF.exec(prompt)?.[1]).toBe(META.id);
    expect(prompt).toContain('/d/handoffs/20261005-1912-a3f0.md');
    const en = pastePrompt({ id: META.id, focus: 'UI' }, '/d/h.md', 'Add archive', 'en');
    expect(en).toContain('Previous chat context: /d/h.md');
    expect(attachedPrompt(en)).toContain('is attached to this message');
    expect(attachedPrompt(en)).not.toContain('/d/h.md');
    const attached = attachedPrompt(prompt);
    expect(attached).not.toContain('/d/handoffs/');
    expect(attached).toContain('подключён к этому сообщению');
    expect(attached).toContain('Задача: UI');
  });

  it('makes ids the reference pattern accepts', () => {
    const id = capsuleId(new Date(2026, 9, 5, 9, 7), 0.5);
    expect(id).toBe('20261005-0907-8000');
    expect(CTX_REF.exec(`jev-ctx:${id}`)?.[1]).toBe(id);
  });
});

describe('helpers', () => {
  it('parses getctx flags and focus', () => {
    expect(parseGetctxArgs(' --nobrief продолжаем UI ')).toEqual({ brief: false, focus: 'продолжаем UI' });
    expect(parseGetctxArgs('--brief')).toEqual({ brief: true, focus: '' });
    expect(parseGetctxArgs('')).toEqual({ brief: undefined, focus: '' });
  });

  it("names a project's folder the way Claude Code does", () => {
    expect(projectSlug('/Users/r/Claude/shop/.claude/worktrees/x')).toBe('-Users-r-Claude-shop--claude-worktrees-x');
  });

  it('asks the brief without tools, with the focus', () => {
    const prompt = briefPrompt('UI', 300);
    expect(prompt.startsWith(BRIEF_MARKER)).toBe(true);
    expect(prompt).toContain('At most 300 words');
    expect(prompt).toContain('Do not call any tools');
    expect(prompt).toContain('UI');
  });
});
