import { describe, expect, it } from 'vitest';

import { archiveText, callLabel, indexLine, pointerText, prunedCalls, withPointers } from '../hooks/lib/archive.ts';
import { applyDecisions } from '../hooks/lib/compaction/compact.ts';
import { collectToolCalls } from '../hooks/lib/compaction/state.ts';
import type { CallDecision, Message } from '../hooks/lib/compaction/types.ts';

const LONG = `${'line of build output\n'.repeat(200)}error: the real cause\n`;

function session(): Message[] {
  return [
    { role: 'user', text: 'fix the build', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Bash', input: { command: 'npm run build' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u1', text: LONG, isError: true }] },
    { role: 'assistant', text: 'Looking at the config.', toolUses: [{ tool_use_id: 'u2', tool: 'Read', input: { file_path: '/p/vite.config.ts' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u2', text: 'export default {}\n'.repeat(50) }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u3', tool: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u3', text: 'a\nb' }] },
    { role: 'assistant', text: 'Fixed.', toolUses: [] },
  ];
}

function decide(messages: Message[], actions: Record<string, CallDecision['action']>): { calls: ReturnType<typeof collectToolCalls>; decisions: CallDecision[] } {
  const calls = collectToolCalls(messages, 1);
  const decisions = calls.map((call) => {
    const action = actions[call.tool_use_id] ?? 'keep';
    const reason: CallDecision['reason'] = action === 'keep' ? 'kept' : action === 'drop_result' ? 'result_dropped' : 'call_dropped';
    return { id: call.id, tool: call.tool, keepCall: 0, keepResult: 0, action, reason };
  });
  return { calls, decisions };
}

describe('prunedCalls', () => {
  it('lists dropped and truncated calls with their whole output', () => {
    const messages = session();
    const { calls, decisions } = decide(messages, { u1: 'drop_result', u2: 'drop_call' });
    const pruned = prunedCalls(messages, decisions, calls);
    expect(pruned.map((p) => [p.toolUseId, p.action])).toEqual([
      ['u1', 'drop_result'],
      ['u2', 'drop_call'],
    ]);
    expect(pruned[0]!.result).toBe(LONG);
    expect(pruned[0]!.isError).toBe(true);
  });
});

describe('archive text', () => {
  it('holds the call and its output verbatim', () => {
    const text = archiveText({ toolUseId: 'u1', tool: 'Bash', input: { command: 'npm run build' }, result: LONG, isError: true, action: 'drop_result' });
    expect(text).toContain('# Bash(npm run build)');
    expect(text).toContain('(error)');
    expect(text).toContain('error: the real cause');
  });

  it('labels a call by its main argument', () => {
    expect(callLabel('Read', { file_path: '/a/b.ts' })).toBe('Read(/a/b.ts)');
    expect(callLabel('TodoWrite', { todos: [] })).toBe('TodoWrite');
  });

  it('keeps short outputs whole and points long ones at the file', () => {
    expect(pointerText('short', false, 300, '/x.txt')).toBe('short');
    const pointed = pointerText(LONG, true, 50, '/x.txt');
    expect(pointed.startsWith(LONG.slice(0, 50))).toBe(true);
    expect(pointed).toContain('full output: /x.txt');
    expect(pointed).toContain('(error)');
    expect(pointed.length).toBeLessThan(400);
  });

  it('writes one index line per call', () => {
    const line = indexLine({ toolUseId: 'u2', tool: 'Read', input: { file_path: '/p/v.ts' }, result: 'abc', isError: false, action: 'drop_call' }, '/d/u2.txt');
    expect(line).toBe('- Read(/p/v.ts) · call removed · 3 chars → u2.txt');
  });
});

describe('withPointers', () => {
  it('names the archive file in truncated results and notes removed calls once', () => {
    const messages = session();
    const { calls, decisions } = decide(messages, { u1: 'drop_result', u2: 'drop_call' });
    const compacted = applyDecisions(messages, decisions, calls, 100);
    const pruned = prunedCalls(messages, decisions, calls);
    const paths = new Map([
      ['u1', '/arch/u1.txt'],
      ['u2', '/arch/u2.txt'],
    ]);
    const out = withPointers(messages, compacted, pruned, paths, 100, { path: '/arch/index.md', removed: 1 });

    const result = out.flatMap((m) => m.toolResults ?? []).find((r) => r.tool_use_id === 'u1')!;
    expect(result.text).toContain('full output: /arch/u1.txt');
    expect(result.text).not.toContain('re-run the tool if needed');
    expect(out.flatMap((m) => m.toolUses).some((t) => t.tool_use_id === 'u2')).toBe(false);
    expect(out.filter((m) => m.text.includes('/arch/index.md'))).toHaveLength(1);
    // Untouched messages stay the engine's own objects.
    expect(out[0]).toBe(messages[0]);
    expect(out.at(-1)).toBe(messages.at(-1));
  });

  it('leaves a truncation without a saved file as the library cut it', () => {
    const messages = session();
    const { calls, decisions } = decide(messages, { u1: 'drop_result' });
    const compacted = applyDecisions(messages, decisions, calls, 100);
    const out = withPointers(messages, compacted, prunedCalls(messages, decisions, calls), new Map(), 100);
    const result = out.flatMap((m) => m.toolResults ?? []).find((r) => r.tool_use_id === 'u1')!;
    expect(result.text).toContain('re-run the tool if needed');
  });

  it('does not repeat the index note when the history already names the index', () => {
    const messages = session();
    messages[0] = { ...messages[0]!, text: 'fix the build\n\n[… listed in /arch/index.md …]' };
    const { calls, decisions } = decide(messages, { u2: 'drop_call' });
    const compacted = applyDecisions(messages, decisions, calls, 100);
    const out = withPointers(messages, compacted, prunedCalls(messages, decisions, calls), new Map([['u2', '/arch/u2.txt']]), 100, {
      path: '/arch/index.md',
      removed: 1,
    });
    expect(out.filter((m) => m.text.includes('/arch/index.md'))).toHaveLength(1);
  });
});
