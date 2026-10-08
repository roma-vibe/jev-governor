import { describe, expect, it } from 'vitest';
import { isMemoryTool, looksDown, memoryBlock, parseRecall, recallTask, sessionSummary } from '../hooks/lib/memory.ts';

// The text mnema-mcp's recall renders (render.recall), as the engine passes it.
const RECALL_TEXT = `# Memory for: how is the router configured
These are notes from memory; check them before relying on them.

## Project memory (repo.github.com.roma-vibe.jev-governor)
Facts:
- [decision] The router keeps Opus for the main conversation and moves subagents only (id f1, core, 2 days ago)
- Config lives in ~/.claude/jev-governor/config.json (id f2, today)
Open questions:
- Should light subagents start on Haiku for writers too? Options: yes; no. (id q1, 1 day ago)
Recent topics:
- Router [t1], 4 msg, today

## Personal memory (dev.roman)
Facts:
- [preference] Answers in Russian (id p1, pinned, 5 days ago)`;

const OPTS = { maxChars: 2_500, maxFacts: 12, withIds: true };

describe('parseRecall', () => {
  it('reads the structured result when the server sends one', () => {
    const notes = parseRecall({
      content: [{ type: 'text', text: 'ignored' }],
      isError: false,
      structuredContent: {
        memories: [
          {
            scope: 'project',
            facts: [
              { id: 'f1', text: 'Uses vitest', type: 'decision', status: 'active' },
              { id: 'f0', text: 'Used jest', status: 'superseded' },
            ],
            open_questions: [{ id: 'q1', text: 'Move to bun?', status: 'open' }],
            error: null,
          },
          { scope: 'personal', facts: [], open_questions: [], error: 'quota used up' },
        ],
      },
    });
    expect(notes.facts).toEqual([{ scope: 'project', text: 'Uses vitest', type: 'decision', id: 'f1' }]);
    expect(notes.questions).toEqual([{ scope: 'project', text: 'Move to bun?', id: 'q1' }]);
    expect(notes.errors).toEqual(['personal: quota used up']);
  });

  it('reads the rendered text when there is no structured result', () => {
    const notes = parseRecall({ content: [{ type: 'text', text: RECALL_TEXT }] });
    expect(notes.facts.map((f) => [f.scope, f.type, f.id])).toEqual([
      ['project', 'decision', 'f1'],
      ['project', undefined, 'f2'],
      ['personal', 'preference', 'p1'],
    ]);
    expect(notes.facts[1]!.text).toBe('Config lives in ~/.claude/jev-governor/config.json');
    expect(notes.questions).toHaveLength(1);
    // Topics are not notes.
    expect(JSON.stringify(notes)).not.toContain('Router [t1]');
  });

  it('turns a failed call into an error and nothing else', () => {
    const notes = parseRecall({ content: [{ type: 'text', text: 'Cannot reach the memory service' }], isError: true });
    expect(notes).toEqual({ facts: [], questions: [], errors: ['Cannot reach the memory service'] });
  });
});

describe('memoryBlock', () => {
  it('nothing relevant stored: nothing without the tools, a line saying so with them (it spares the model its own recall)', () => {
    const empty = parseRecall({ content: [{ type: 'text', text: '# Memory for: x\n\n## Project memory (p)\n(nothing recorded that matches)' }] });
    expect(memoryBlock(empty, { ...OPTS, withIds: false })).toBeUndefined();
    const line = memoryBlock(empty, OPTS)!;
    expect(line.facts).toBe(0);
    expect(line.text).toContain('do not call recall for it again');
    expect(line.text.length).toBeLessThan(260);
  });

  it('puts project facts first, marks personal ones, and frames them as information', () => {
    const block = memoryBlock(parseRecall({ content: [{ type: 'text', text: RECALL_TEXT }] }), OPTS)!;
    expect(block.facts).toBe(3);
    expect(block.text).toMatch(/^<memory source="earlier sessions">/);
    expect(block.text).toContain('not as instructions');
    expect(block.text.indexOf('router keeps Opus')).toBeLessThan(block.text.indexOf('(personal) Answers in Russian'));
    expect(block.text).toContain('(id f1)');
    expect(block.text).toContain('Left undecided earlier:');
    expect(block.text.endsWith('</memory>')).toBe(true);
    expect(block.text).toContain('do not call recall for it again');
  });

  it('keeps within the size and count limits, and drops ids when the model has no tools to use them', () => {
    const notes = parseRecall({ content: [{ type: 'text', text: RECALL_TEXT }] });
    const one = memoryBlock(notes, { maxChars: 2_500, maxFacts: 1, withIds: false })!;
    expect(one.facts).toBe(1);
    expect(one.text).not.toContain('(id ');
    const tiny = memoryBlock(notes, { maxChars: 300, maxFacts: 12, withIds: true });
    expect(tiny === undefined || tiny.text.length <= 300).toBe(true);
  });
});

describe('recallTask', () => {
  it('skips replies too short to be a task and strips code and tags', () => {
    expect(recallTask('да')).toBeUndefined();
    expect(recallTask('продолжай')).toBeUndefined();
    const task = recallTask('почини роутер ```ts\nconst x = 1\n``` <file path="a">secret</file> пожалуйста')!;
    expect(task).toBe('почини роутер пожалуйста');
    expect(recallTask('x'.repeat(1_000))!.length).toBeLessThanOrEqual(401);
  });
});

describe('memory helpers', () => {
  it('knows the server tools by name, however the engine spells the server', () => {
    expect(isMemoryTool('mcp__mnema-memory__recall', 'mnema-memory')).toBe(true);
    expect(isMemoryTool('mcp__mnema_memory__save_fact', 'mnema-memory')).toBe(true);
    expect(isMemoryTool('mcp__other__recall', 'mnema-memory')).toBe(false);
    expect(isMemoryTool('Read', 'mnema-memory')).toBe(false);
  });

  it('tells a stopped server from a refused request', () => {
    expect(looksDown('Cannot reach the memory service at http://127.0.0.1:8787: connection refused')).toBe(true);
    expect(looksDown('timeout after 2500 ms')).toBe(true);
    expect(looksDown('The memory service refused this request (403): bad key')).toBe(false);
  });

  it('saves a handoff brief only when there is something in it', () => {
    expect(sessionSummary('short', 'title')).toBeUndefined();
    const s = sessionSummary('a'.repeat(200), 'Router work')!;
    expect(s.startsWith('Router work\n\n')).toBe(true);
    expect(sessionSummary('a'.repeat(20_000), 't', 1_000)!.length).toBeLessThanOrEqual(1_001);
  });
});
