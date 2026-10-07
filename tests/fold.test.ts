// Folding old dialog text at a compaction (hooks/lib/compaction/fold.ts):
// which messages are asked about, what a folded message reads, and Jev's
// answers turned into folds.

import { describe, expect, it } from 'vitest';

import {
  applyFolds,
  askFolds,
  batchFolds,
  collectFoldCandidates,
  DEFAULT_FOLD_OPTIONS,
  FOLD_MARK,
  foldedText,
  foldFileName,
  foldQuestion,
  foldKeeps,
  foldStats,
  headOf,
  isPrompt,
  type FoldDecision,
} from '../hooks/lib/compaction/fold.ts';
import type { CompactionState, JevAsker, Message } from '../hooks/lib/compaction/types.ts';

const words = (n: number, word = 'detail'): string => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');
const user = (text: string): Message => ({ role: 'user', text, toolUses: [] });
const assistant = (text: string): Message => ({ role: 'assistant', text, toolUses: [] });
const notice = (id: string, body: string, kind: 'result' | 'event' = 'result'): Message =>
  user(
    `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "${id}" finished</summary>\n<note>A task-notification fires each time this agent stops.</note>\n<${kind}>${body}</${kind}>\n</task-notification>`,
  );
const toolStep = (id: string): Message[] => [
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: `step ${id}` } }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: 'ok' }] },
];

/** Three tasks: an old answer, an agent result and monitor events, a long paste, then the newest turns. */
function chat(): Message[] {
  return [
    user('analyse the project'), // 0: pinned first message, a prompt
    ...toolStep('a1'), // 1, 2
    assistant(`Report.\n${words(200)}`), // 3: answer, 4 prompts ago (the paste is one)
    notice('agent-1', `Findings: ${words(200)}`), // 4: agent result
    notice('mon-1', `checkpoint 1 ${words(60)}`, 'event'), // 5: monitor, superseded by 13
    user(`Here is the spec:\n${words(600, 'spec')}`), // 6: long paste (a prompt)
    assistant(`Spec read.\n${words(200)}`), // 7
    user('now fix the bug'), // 8: prompt
    assistant(`Fixed. ${words(30)}`), // 9: short answer, not a candidate
    user('and the tests'), // 10: prompt, 2nd newest
    ...toolStep('a2'), // 11, 12
    notice('mon-1', `checkpoint 2 ${words(60)}`, 'event'), // 13: newest event of mon-1
    assistant(`Tests pass. ${words(200)}`), // 14
    user('ship it'), // 15: newest prompt
    ...toolStep('a3'), // 16, 17
    assistant('Shipped.'), // 18
  ];
}

const options = { ...DEFAULT_FOLD_OPTIONS, preserveRecentMessages: 3 };

describe('fold candidates', () => {
  it('asks about old answers, notifications and pastes; never the newest turns, the first message or short texts', () => {
    const messages = chat();
    const candidates = collectFoldCandidates(messages, options);
    const byIndex = new Map(candidates.map((c) => [c.index, c]));
    expect([...byIndex.keys()]).toEqual([3, 4, 5, 6, 7]);
    expect(byIndex.get(3)).toMatchObject({ id: 'm3', kind: 'answer', role: 'assistant', turnsAgo: 4 });
    expect(byIndex.get(4)).toMatchObject({ kind: 'agent', label: 'Agent "agent-1" finished' });
    expect(byIndex.get(5)).toMatchObject({ kind: 'monitor', supersededBy: 13 });
    expect(byIndex.get(6)).toMatchObject({ kind: 'paste', role: 'user' });
    expect(isPrompt(messages[6]!)).toBe(true);
    expect(isPrompt(messages[4]!)).toBe(false);
  });

  it('a superseded notification is a candidate even inside the newest turns; a folded text never again', () => {
    const messages = chat();
    // Two events of another monitor, both inside the newest two turns.
    messages.splice(11, 0, notice('mon-2', `checkpoint A ${words(60)}`, 'event'));
    messages.splice(16, 0, notice('mon-2', `checkpoint B ${words(60)}`, 'event'));
    const candidates = collectFoldCandidates(messages, options);
    expect(candidates.find((c) => c.index === 11)).toMatchObject({ kind: 'monitor', supersededBy: 16 });
    expect(candidates.find((c) => c.index === 16)).toBeUndefined();

    const folded = messages.map((m, i) => (i === 3 ? assistant(`${FOLD_MARK} 1500 chars …]\nReport.`) : m));
    expect(collectFoldCandidates(folded, options).find((c) => c.index === 3)).toBeUndefined();
  });

  it('keepTurns 1 opens the turn before the newest prompt; 0 protects no turn', () => {
    const messages = chat();
    expect(collectFoldCandidates(messages, { ...options, keepTurns: 1 }).map((c) => c.index)).toEqual([3, 4, 5, 6, 7, 13, 14]);
    // 0: the newest prompt's own turn too (only the pinned newest messages stay).
    expect(collectFoldCandidates(messages, { ...options, preserveRecentMessages: 1, keepTurns: 0 }).map((c) => c.index)).toEqual([
      3, 4, 5, 6, 7, 13, 14,
    ]);
  });

  it('a notification too short for its fold to save much is not asked about', () => {
    const messages = chat();
    messages[5] = notice('mon-1', `checkpoint 1 ${words(30)}`, 'event');
    expect(collectFoldCandidates(messages, options).map((c) => c.index)).toEqual([3, 4, 6, 7]);
  });
});

describe('folded text', () => {
  it('cuts a head at a line or sentence end near the limit', () => {
    expect(headOf('short', 300)).toBe('short');
    expect(headOf(`line one is here\nline two goes on and on`, 25)).toBe('line one is here\n…');
    expect(headOf(`First sentence ends here. Second one runs past the limit`, 40)).toBe('First sentence ends here. …');
    expect(headOf('x'.repeat(50), 20)).toBe(`${'x'.repeat(20)}…`);
  });

  it('an answer keeps the pointer and its first lines; a notification keeps its envelope', () => {
    const answer = `Report.\n${words(200)}`;
    const text = foldedText(answer, { kind: 'answer', chars: answer.length }, '/data/folded/a.md', 120);
    expect(text.startsWith(`${FOLD_MARK} ${answer.length} chars`)).toBe(true);
    expect(text).toContain('/data/folded/a.md');
    expect(text).toContain('\nReport.');
    expect(text.length).toBeLessThan(330);

    const agent = notice('agent-1', `Findings: ${words(200)}`).text;
    const folded = foldedText(agent, { kind: 'agent', chars: agent.length }, '/data/folded/b.md', 100);
    expect(folded).toContain('<task-id>agent-1</task-id>');
    expect(folded).toContain('<summary>Agent "agent-1" finished</summary>');
    expect(folded).not.toContain('<note>');
    expect(folded).toMatch(/<result>\[jev-governor folded \d+ chars[^\]]*\]\nFindings: detail0/);
    expect(folded).toContain('</result>\n</task-notification>');
    expect(folded.length).toBeLessThan(agent.length / 3);
  });

  it('the same text always gets the same file name', () => {
    expect(foldFileName('abc')).toBe(foldFileName('abc'));
    expect(foldFileName('abc')).not.toBe(foldFileName('abd'));
    expect(foldFileName('abc')).toMatch(/^[0-9a-f]{8}-3\.md$/);
  });
});

describe('asking Jev', () => {
  const state = { goal: 'ship it', history: [] } as unknown as CompactionState;

  it('one noul question per candidate, secrets filtered from its preview', () => {
    const messages = chat();
    const [first] = collectFoldCandidates(messages, options);
    const questions = foldQuestion(first!, `${messages[3]!.text} sk-or-v1-abcdef`, { previewChars: 240, previewFilter: (t) => t.replace(/sk-or-\S+/g, '[key]') });
    const q = questions['keep_m3']!;
    expect(q.type).toBe('noul');
    expect(q.instructions).toContain('Message i=3 (an earlier message of the assistant');
    expect(q.instructions).toContain('4 user prompt(s) ago');
    expect(q.instructions).toContain('[key]');
    expect(q.instructions).not.toContain('sk-or-v1');
  });

  it('folds below the cut-off of its kind; batches fit the request budget', async () => {
    const messages = chat();
    const candidates = collectFoldCandidates(messages, options);
    const keep: Record<string, number> = { keep_m3: 0.31, keep_m4: 0.2, keep_m5: 0.3, keep_m6: 0.25, keep_m7: 0.1 };
    const asked: string[][] = [];
    const asker: JevAsker = {
      ask: async (_s, questions) => {
        asked.push(Object.keys(questions));
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: keep[k] ?? 0.9 }])) };
      },
    };
    const { decisions, requests } = await askFolds(asker, state, 100, candidates, messages, options);
    expect(requests).toBe(1);
    const fold = Object.fromEntries(decisions.map((d) => [d.index, d.fold]));
    // answer 0.31 ≥ 0.3 stays; agent 0.2 < 0.25 folds; monitor 0.3 < 0.35 folds; paste 0.25 ≥ 0.2 stays.
    expect(fold).toEqual({ 3: false, 4: true, 5: true, 6: false, 7: true });

    const small = batchFolds(candidates, messages, 100, { ...options, maxRequestTokens: 700 });
    expect(small.length).toBeGreaterThan(1);
    expect(small.flat().map((c) => c.index)).toEqual(candidates.map((c) => c.index));
    expect(() => batchFolds(candidates, messages, 690, { ...options, maxRequestTokens: 700 })).toThrow(/no room/);
  });

  it('applies folds that have an archive path and counts what they saved', () => {
    const messages = chat();
    const decisions: FoldDecision[] = collectFoldCandidates(messages, options).map((c) => ({ ...c, keep: 0.1, fold: true }));
    const paths = new Map([3, 4, 5].map((i) => [i, `/data/folded/${i}.md`] as const));
    const out = applyFolds(messages, decisions, paths, DEFAULT_FOLD_OPTIONS.headChars);
    expect(out[3]!.text.startsWith(FOLD_MARK)).toBe(true);
    expect(out[4]!.text).toContain('<task-id>agent-1</task-id>');
    // No path for 6 and 7 (their file could not be written): they stay whole, the same objects.
    expect(out[6]).toBe(messages[6]);
    expect(out[7]).toBe(messages[7]);
    expect(out[1]).toBe(messages[1]);
    const stats = foldStats(decisions, messages, out);
    expect(stats).toMatchObject({ candidates: 5, folded: 3, byKind: { answer: 1, agent: 1, monitor: 1 } });
    expect(stats.charsSaved).toBeGreaterThan(2000);
    const keeps = foldKeeps(decisions);
    expect(keeps).toHaveLength(5);
    expect(keeps[0]).toMatch(/^answer:0\.10:\d+:\d+$/);
  });
});
