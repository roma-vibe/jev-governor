import { describe, expect, it } from 'vitest';
import { resolveConfig, withPathOverrides } from '../hooks/lib/config.ts';

const raw = {
  agents: { brief: 'on', scopeNote: true },
  pathOverrides: [
    { path: '~/ab/fastdev-A', set: { agents: { brief: 'off', scopeNote: false }, router: { roles: 'off' } } },
    { path: '/x/other', set: { mode: 'shadow' } },
  ],
};

describe('pathOverrides', () => {
  it('merges the matching override over the file, key by key', () => {
    const c = resolveConfig(withPathOverrides(raw, '/Users/me/ab/fastdev-A/src', '/Users/me'));
    expect(c.agents.brief).toBe('off');
    expect(c.agents.scopeNote).toBe(false);
    expect(c.router.roles).toBe('off');
    expect(c.agents.waitHint).toBe(true);
  });

  it('leaves other folders alone and keeps the list so the file round-trips', () => {
    const c = resolveConfig(withPathOverrides(raw, '/Users/me/ab/fastdev-B', '/Users/me'));
    expect(c.agents.brief).toBe('on');
    expect(c.router.roles).toBe('shadow');
    expect(c.mode).toBe('active');
    expect(c.pathOverrides).toHaveLength(2);
  });

  it('does not match a folder that only shares a prefix, and ignores nesting of its own key', () => {
    expect(resolveConfig(withPathOverrides(raw, '/Users/me/ab/fastdev-AB', '/Users/me')).agents.brief).toBe('on');
    const nested = { pathOverrides: [{ path: '/p', set: { pathOverrides: [{ path: '/', set: { mode: 'shadow' } }] } }] };
    expect(resolveConfig(withPathOverrides(nested, '/p', '/h')).mode).toBe('active');
  });

  it('survives junk', () => {
    expect(resolveConfig({ pathOverrides: [1, { path: 3 }, { path: '/p', set: 'x' }] }).pathOverrides).toEqual([]);
    expect(withPathOverrides(undefined, '/p', '/h')).toBeUndefined();
  });
});
