import { describe, expect, it } from 'vitest';

import { afterReset } from '../ui/lib/reset.ts';

describe('afterReset', () => {
  const reset = '2026-10-13T16:00:00.000Z';
  it('drops what was written before the reset, but keeps learned commands', () => {
    expect(afterReset({ ts: '2026-10-13T15:59:59.000Z', kind: 'usage' }, reset)).toBe(false);
    expect(afterReset({ ts: '2026-10-13T16:00:01.000Z', kind: 'usage' }, reset)).toBe(true);
    expect(afterReset({ ts: '2026-10-05T10:00:00.000Z', kind: 'command' }, reset)).toBe(true);
  });
  it('keeps everything when there was no reset', () => {
    expect(afterReset({ ts: '2026-10-05T10:00:00.000Z', kind: 'usage' }, '')).toBe(true);
  });
});
