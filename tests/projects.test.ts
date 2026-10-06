import { describe, expect, it } from 'vitest';

import type { ProjectCommandRecord } from '../hooks/lib/types.ts';
import { mergeCommands } from '../ui/lib/projects.ts';

const NOW = '2026-10-05T20:00:00.000Z';

function command(id: string, extra: Partial<ProjectCommandRecord> = {}): ProjectCommandRecord {
  return { id, command: `npm run ${id}`, group: 'run', source: 'package.json', createdAt: NOW, updatedAt: NOW, ...extra };
}

describe('mergeCommands and favourites', () => {
  it('keeps the favourite flag of a command the scan finds again', () => {
    const out = mergeCommands([command('dev', { favorite: true })], [command('dev')], NOW);
    expect(out[0]!.favorite).toBe(true);
  });

  it('keeps a favourite command the scan no longer finds, marked stale; drops a plain one', () => {
    const out = mergeCommands([command('gone', { favorite: true }), command('plain')], [], NOW);
    expect(out.map((c) => [c.id, c.stale])).toEqual([['gone', true]]);
  });
});
