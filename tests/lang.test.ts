import { describe, expect, it } from 'vitest';

import { resolveLang } from '../hooks/lib/lang.ts';

describe('resolveLang', () => {
  it('an explicit setting wins', () => {
    expect(resolveLang('ru', 'english', ['en_US'])).toBe('ru');
    expect(resolveLang('en', 'Русский', ['ru_RU'])).toBe('en');
  });

  it('automatic follows the language set in Claude Code', () => {
    expect(resolveLang('auto', 'russian')).toBe('ru');
    expect(resolveLang('auto', 'Русский', ['en_US'])).toBe('ru');
    expect(resolveLang('auto', 'japanese', ['ru_RU'])).toBe('en');
  });

  it('then the system locale, skipping C and empty ones', () => {
    expect(resolveLang('auto', undefined, [undefined, 'C', 'ru-RU'])).toBe('ru');
    expect(resolveLang('auto', undefined, ['en_US.UTF-8', 'ru-RU'])).toBe('en');
    expect(resolveLang('auto', undefined, [])).toBe('en');
  });
});
