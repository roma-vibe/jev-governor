import { describe, expect, it } from 'vitest';
import { extractPrompt, parseCandidates, realTurn, similar, turnKey } from '../hooks/lib/autosave.ts';
import { redact } from '../hooks/lib/redact.ts';

const clean = (t: string): string => redact(t).text;
const turn = (n: number, user: string, answer = 'Ответ достаточной длины, чтобы считаться настоящим ходом диалога.') => ({ n, user, answer, calls: 0, errors: 0, edited: [] });
const GOOD = 'The router keeps its state per chat in route.json because a resumed chat must not lose its cache plan.';

describe('autosave: reading the model answer', () => {
  const known = [{ id: 'f1', text: 'Mod tests run with npm test (vitest).', scope: 'project' }];

  it('keeps a valid durable fact with its type and scope', () => {
    const out = parseCandidates(`{"facts":[{"text":"${GOOD}","type":"gotcha","scope":"personal","importance":"high"}]}`, known, 3, clean);
    expect(out).toEqual([{ text: GOOD, type: 'gotcha', scope: 'personal', importance: 'high' }]);
  });

  it('takes the JSON out of a reply wrapped in prose or a code fence', () => {
    expect(parseCandidates(`Here you go:\n\`\`\`json\n{"facts":[{"text":"${GOOD}"}]}\n\`\`\``, known, 3, clean)).toHaveLength(1);
    expect(parseCandidates('no json at all', known, 3, clean)).toEqual([]);
    expect(parseCandidates('{"facts":"nope"}', known, 3, clean)).toEqual([]);
  });

  it('drops session progress, repeats, secrets, too short and too long texts', () => {
    const facts = [
      { text: 'Currently the work is in progress on the agents-dedupe branch of this repository.' },
      { text: 'Mod tests run with npm test (vitest).' },
      { text: 'The release job uses the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 to publish.' },
      { text: 'too short' },
      { text: 'x'.repeat(301) },
      { text: GOOD },
    ];
    expect(parseCandidates(JSON.stringify({ facts }), known, 5, clean).map((c) => c.text)).toEqual([GOOD]);
  });

  it('a repeat is allowed only as a replacement of a stored fact that was shown', () => {
    const better = 'Mod tests run with npm test (vitest) and the types are checked with npx tsc --noEmit before a release.';
    expect(parseCandidates(JSON.stringify({ facts: [{ text: better, replaces: 'f1' }] }), known, 3, clean)[0]?.replaces).toBe('f1');
    expect(parseCandidates(JSON.stringify({ facts: [{ text: GOOD, replaces: 'invented' }] }), known, 3, clean)[0]?.replaces).toBeUndefined();
  });

  it('caps the count, drops duplicates among the offered, and defaults the unknown type', () => {
    const facts = [{ text: GOOD, type: 'weird' }, { text: GOOD }, { text: 'The UI server listens on port 4777 and is restarted after every UI build by the assistant.' }, { text: 'Releases bump the version in five files, see the release checklist for the list.' }];
    const out = parseCandidates(JSON.stringify({ facts }), [], 2, clean);
    expect(out).toHaveLength(2);
    expect(out[0]!.type).toBe('context');
    expect(out[0]!.scope).toBe('project');
  });

  it('similar() compares by shared words', () => {
    expect(similar('Mod tests run with npm test (vitest).', 'Mod tests run with npm test (vitest) always')).toBe(true);
    expect(similar('Mod tests run with npm test (vitest).', 'The UI server listens on port 4777')).toBe(false);
  });
});

describe('autosave: which turns are read', () => {
  it('skips noise the harness puts in the user place and trivial turns', () => {
    expect(realTurn(turn(1, 'Tool loaded.'))).toBe(false);
    expect(realTurn(turn(1, '[Usage limit reached; a short grace allowance remains, then this turn is cut off]'))).toBe(false);
    expect(realTurn(turn(1, 'да'))).toBe(false);
    expect(realTurn(turn(1, 'почему мы храним состояние на чат, а не глобально?', 'ok'))).toBe(false);
    expect(realTurn(turn(1, 'почему мы храним состояние на чат, а не глобально?'))).toBe(true);
  });

  it('a turn has the same key wherever it sits, and different text another', () => {
    expect(turnKey({ user: 'Fix the  payment   test' })).toBe(turnKey({ user: 'Fix the payment test' }));
    expect(turnKey({ user: 'Fix the payment test' })).not.toBe(turnKey({ user: 'Fix the order test' }));
  });
});

describe('autosave: the prompt', () => {
  const base = { project: 'app', known: [], maxFacts: 3, clean };

  it('shows stored facts with their ids, cleans secrets, and reads a replayed turn once', () => {
    const a = turn(1, 'Ключ деплоя sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 храним в CI, не в репозитории');
    const built = extractPrompt({ ...base, known: [{ id: 'f9', text: 'Stored fact about releases and versions.', scope: 'project' }], turns: [a, { ...a, n: 5 }] });
    expect(built.prompt).toContain('(id f9) Stored fact about releases');
    expect(built.prompt).not.toContain('sk-ant-api03');
    expect(built.prompt.match(/--- turn/g)).toHaveLength(1);
    expect(built.used).toHaveLength(2);
  });

  it('fits turns into the budget, oldest first, and always takes at least one', () => {
    const turns = [1, 2, 3, 4].map((n) => turn(n, `вопрос номер ${n} `.repeat(120)));
    const built = extractPrompt({ ...base, turns, maxChars: 4000 });
    expect(built.used.length).toBeGreaterThanOrEqual(1);
    expect(built.used.length).toBeLessThan(4);
    expect(built.used[0]!.n).toBe(1);
  });

  it('carries Claude Code summary of the earlier part once', () => {
    const built = extractPrompt({ ...base, turns: [turn(1, 'продолжаем работу над роутером')], summary: 'Earlier we decided to keep state per chat.' });
    expect(built.summaryUsed).toBe(true);
    expect(built.prompt).toContain('Earlier we decided to keep state per chat.');
  });
});
