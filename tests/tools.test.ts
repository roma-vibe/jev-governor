import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../hooks/lib/config.ts';
import { matches, shouldDefer } from '../hooks/lib/tools.ts';

const cfg = resolveConfig(undefined).tools;
const DAY = 86_400_000;
const now = 100 * DAY;

describe('shouldDefer', () => {
  it('defers a long, known-rare tool from the first day, and a long unused one once a full window is counted', () => {
    const fresh = { since: now - DAY, last: {} };
    expect(shouldDefer('Artifact', 20_000, fresh, cfg, now)).toBe(true);
    expect(shouldDefer('mcp__visualize__show_widget', 2_000, fresh, cfg, now)).toBe(true);
    expect(shouldDefer('mcp__Claude_Browser__navigate', 2_000, fresh, cfg, now)).toBe(false);
    const counted = { since: now - 15 * DAY, last: {} };
    expect(shouldDefer('mcp__Claude_Browser__navigate', 2_000, counted, cfg, now)).toBe(true);
  });

  it('keeps a tool used within idleDays, a short one, the engine core and the kept ones', () => {
    const use = { since: now - 30 * DAY, last: { Artifact: now - 3 * DAY } };
    expect(shouldDefer('Artifact', 20_000, use, cfg, now)).toBe(false);
    expect(shouldDefer('ReportFindings', 300, use, cfg, now)).toBe(false);
    expect(shouldDefer('Agent', 20_000, use, cfg, now)).toBe(false);
    expect(shouldDefer('Workflow', 20_000, use, { ...cfg, keep: ['Work*'] }, now)).toBe(false);
    expect(shouldDefer('Workflow', 20_000, use, { ...cfg, deferIdle: false }, now)).toBe(false);
  });

  it('matches exact names and prefix patterns', () => {
    expect(matches('mcp__a__b', ['mcp__a__*'])).toBe(true);
    expect(matches('mcp__ab', ['mcp__a'])).toBe(false);
  });
});
