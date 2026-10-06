// jev-governor's changes to the vendored compaction: result previews in the
// Jev state, the prune cap, and the re-run key of pruned calls.

import { describe, expect, it } from 'vitest';

import { rerunKey } from '../hooks/lib/archive.ts';
import { redact } from '../hooks/lib/redact.ts';
import { compact, limitPruning, reductionRatio } from '../hooks/lib/compaction/compact.ts';
import { collectToolCalls, fitState, resultNote } from '../hooks/lib/compaction/state.ts';
import type { HistoryToolCall, JevAsker, Message } from '../hooks/lib/compaction/types.ts';

function chat(calls: number, outputChars = 2000): Message[] {
  const messages: Message[] = [{ role: 'user', text: 'fix the build', toolUses: [] }];
  for (let i = 1; i <= calls; i++) {
    messages.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: `u${i}`, tool: 'Bash', input: { command: `step ${i}` } }] });
    const body = `start of output ${i} ` + 'x'.repeat(Math.max(0, outputChars - 60)) + ` end of output ${i}`;
    messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `u${i}`, text: body }] });
  }
  messages.push({ role: 'assistant', text: 'done', toolUses: [] });
  return messages;
}

/** Jev that drops every call's output, keep probability growing with the call number. */
const dropAll: JevAsker = {
  ask: async (_state, questions) => ({
    answers: Object.fromEntries(
      Object.keys(questions).map((name) => {
        const n = Number(/t(\d+)/.exec(name)?.[1] ?? 0);
        return [name, { noul: name.startsWith('call_') ? 0.1 : Math.min(0.49, n / 100) }];
      }),
    ),
  }),
};

describe('result previews', () => {
  it('shows the start and end of an output, or the whole of a short one', () => {
    const call = { isError: false, resultChars: 500, result: `head ${'a'.repeat(480)} tail` };
    expect(resultNote(call)).toBe('ok, 500 chars (omitted)');
    const note = resultNote(call, 20);
    expect(note.startsWith('ok, 500 chars: head aaaa')).toBe(true);
    expect(note.endsWith('aaaa tail')).toBe(true);
    expect(note).toContain(' […] ');
    expect(resultNote({ isError: true, resultChars: 12, result: 'not\n found' }, 20)).toBe('error, 12 chars: not found');
  });

  it('puts previews in the state and leaves out the oldest first when it does not fit', () => {
    const messages = chat(30);
    const calls = collectToolCalls(messages, 2);
    const roomy = fitState(messages, calls, { maxStateTokens: 25_000, preserveRecentMessages: 2, goal: '', resultPreviewChars: 100 });
    expect(roomy.stage).toBe('full');
    expect(JSON.stringify(roomy.state)).toContain('end of output 1');

    const tight = fitState(messages, calls, { maxStateTokens: 3_000, preserveRecentMessages: 2, goal: '', resultPreviewChars: 100 });
    expect(tight.stage).toBe('previews left out');
    expect(tight.tokens).toBeLessThanOrEqual(3_000);
    const results = tight.state.history.flatMap((e) => (e.tool_calls ?? []) as HistoryToolCall[]).map((c) => c.result);
    // The newest keep their preview longest.
    expect(results.at(-1)).toContain('end of output 30');
    expect(results[0]).toBe(`ok, ${messages[2]!.toolResults![0]!.text.length} chars (omitted)`);
  });

  it('leaves previews out before it cuts call inputs to a few dozen characters', () => {
    const messages: Message[] = [{ role: 'user', text: 'refactor the payments module', toolUses: [] }];
    for (let i = 1; i <= 40; i++) {
      const file_path = `/Users/r/Documents/projects/shop/services/payments/src/handlers/refunds/partial/handler_${i}.ts`;
      messages.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: `u${i}`, tool: 'Read', input: { file_path, limit: 400, note: 'n'.repeat(900) } }] });
      messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `u${i}`, text: `export const h${i} = ` + 'c'.repeat(3000) }] });
    }
    messages.push({ role: 'assistant', text: 'done', toolUses: [] });
    const calls = collectToolCalls(messages, 2);
    const bare = fitState(messages, calls, { maxStateTokens: 9_000, preserveRecentMessages: 2, goal: '' });
    expect(bare.stage).toBe('inputs<=200');
    const fitted = fitState(messages, calls, { maxStateTokens: bare.tokens + 20, preserveRecentMessages: 2, goal: '', resultPreviewChars: 150 });
    expect(fitted.stage).toBe('previews left out');
    expect(JSON.stringify(fitted.state)).toContain('refunds/partial/handler_1.ts');
  });

  it('filters a preview with a margin past the cut, so a key across the cut is caught whole', () => {
    const key = 'sk-ant-api03-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv';
    // The key starts 10 characters before the 150-character cut.
    const result = 'x'.repeat(140) + key + ' ' + 'y'.repeat(2000);
    const note = resultNote({ isError: false, resultChars: result.length, result }, 150, (t) => redact(t).text);
    expect(note).not.toContain('sk-ant-api03');
    expect(note).toContain('x'.repeat(140));
  });

  it('upstream behaviour without previews', () => {
    const messages = chat(3);
    const state = fitState(messages, collectToolCalls(messages, 2), { maxStateTokens: 25_000, preserveRecentMessages: 2, goal: '' });
    expect(JSON.stringify(state.state)).not.toContain('end of output');
  });
});

describe('limitPruning', () => {
  it('puts back the calls Jev was least sure about until the cap holds', async () => {
    const messages = chat(20);
    const raw = await compact(messages, dropAll, { preserveRecentMessages: 2, truncateHeadChars: 100 });
    expect(reductionRatio(raw)).toBeGreaterThan(0.8);
    const capped = limitPruning(messages, raw, { maxPruneRatio: 0.5, preserveRecentMessages: 2, truncateHeadChars: 100 });
    expect(reductionRatio(capped)).toBeLessThanOrEqual(0.5);
    expect(reductionRatio(capped)).toBeGreaterThan(0.4);
    const restored = capped.decisions.filter((d) => d.reason === 'restored');
    expect(capped.stats.restored).toBe(restored.length);
    // Highest keepResult (the newest calls here) first.
    const least = Math.min(...restored.map((d) => d.keepResult));
    const stillDropped = capped.decisions.filter((d) => d.action !== 'keep');
    expect(stillDropped.every((d) => d.keepResult <= least)).toBe(true);
    // Untouched messages stay the same objects.
    expect(capped.messages[0]).toBe(messages[0]);
  });

  it('does not put back one huge output while smaller ones do the job', async () => {
    const messages = chat(20);
    // The newest candidate (highest keepResult) is huge.
    const huge = messages[messages.length - 4]!.toolResults![0]!;
    huge.text = huge.text + 'y'.repeat(60_000);
    const raw = await compact(messages, dropAll, { preserveRecentMessages: 2, truncateHeadChars: 100 });
    const capped = limitPruning(messages, raw, { maxPruneRatio: 0.8, preserveRecentMessages: 2, truncateHeadChars: 100 });
    expect(reductionRatio(capped)).toBeLessThanOrEqual(0.8);
    expect(reductionRatio(capped)).toBeGreaterThan(0.7);
    const hugeCall = collectToolCalls(messages, 2).find((c) => c.tool_use_id === huge.tool_use_id)!;
    expect(capped.decisions.find((d) => d.id === hugeCall.id)!.action).not.toBe('keep');
  });

  it('when a big output must go back, puts back the smallest that does, not the surest-kept huge one', async () => {
    // Five small outputs, then 30k and 60k: the 60k one has the highest keepResult.
    const sizes = [1000, 1000, 1000, 1000, 1000, 30_000, 60_000];
    const messages: Message[] = [{ role: 'user', text: 'fix the build', toolUses: [] }];
    sizes.forEach((size, i) => {
      const n = i + 1;
      messages.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: `u${n}`, tool: 'Bash', input: { command: `step ${n}` } }] });
      messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `u${n}`, text: 'z'.repeat(size) }] });
    });
    messages.push({ role: 'assistant', text: 'done', toolUses: [] }, { role: 'user', text: 'thanks', toolUses: [] });
    const raw = await compact(messages, dropAll, { preserveRecentMessages: 2, truncateHeadChars: 100 });
    expect(reductionRatio(raw)).toBeGreaterThan(0.95);
    const capped = limitPruning(messages, raw, { maxPruneRatio: 0.8, preserveRecentMessages: 2, truncateHeadChars: 100 });
    // The 30k output alone covers what is left; putting the 60k one back would drop the
    // compaction to ~0.3 (below the 0.4 a threshold compaction needs).
    expect(reductionRatio(capped)).toBeLessThanOrEqual(0.8);
    expect(reductionRatio(capped)).toBeGreaterThan(0.55);
    const calls = collectToolCalls(messages, 2);
    const idOf = (useId: string): string => calls.find((c) => c.tool_use_id === useId)!.id;
    expect(capped.decisions.find((d) => d.id === idOf('u7'))!.action).not.toBe('keep');
    expect(capped.decisions.find((d) => d.id === idOf('u6'))!.reason).toBe('restored');
  });

  it('changes nothing within the cap or without one', async () => {
    const messages = chat(5);
    const raw = await compact(messages, dropAll, { preserveRecentMessages: 2 });
    expect(limitPruning(messages, raw, { maxPruneRatio: 1 })).toBe(raw);
    expect(limitPruning(messages, raw, { maxPruneRatio: 0.99 })).toBe(raw);
  });
});

describe('rerunKey', () => {
  it('matches the same command, file, search or URL', () => {
    expect(rerunKey('Bash', { command: 'npm  test\n' })).toBe(rerunKey('Bash', { command: 'npm test', description: 'x' }));
    expect(rerunKey('Read', { file_path: '/a.ts', offset: 10 })).toBe('Read:/a.ts');
    expect(rerunKey('Grep', { pattern: 'foo', path: 'src' })).not.toBe(rerunKey('Grep', { pattern: 'foo' }));
    expect(rerunKey('Edit', { file_path: '/a.ts' })).toBeUndefined();
  });
});
