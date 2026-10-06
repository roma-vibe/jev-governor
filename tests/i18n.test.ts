import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'ui', 'src');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'i18n' ? [] : files(path);
    return /\.(ts|vue)$/.test(entry.name) ? [path] : [];
  });
}

/** English keys passed to `t('…')` as string literals. */
function keysOf(source: string): string[] {
  const keys: string[] = [];
  const call = /(?<![\w.$])t\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const match of source.matchAll(call)) {
    const literal = match[0].slice(match[0].indexOf(match[1]!));
    if (match[1] === '`' && match[2]!.includes('${')) throw new Error(`t() key with interpolation: ${match[0]}`);
    keys.push(new Function(`return ${literal}`)() as string);
  }
  return keys;
}

describe('ui translations', () => {
  it('has a Russian text for every English key, and no stale entries', async () => {
    const { russianTable } = await import('../ui/src/i18n/index.ts');
    const used = new Set(files(SRC).flatMap((file) => keysOf(readFileSync(file, 'utf8'))));
    const missing = [...used].filter((key) => !(key in russianTable));
    const stale = Object.keys(russianTable).filter((key) => !used.has(key));
    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });

  it('keeps placeholders and plural forms the same in both languages', async () => {
    const { russianTable } = await import('../ui/src/i18n/index.ts');
    const names = (text: string): string[] => [...text.matchAll(/\{(\w+)(?:#[^}]*)?\}/g)].map((m) => m[1]!).sort();
    const bad = Object.entries(russianTable).filter(([en, ru]) => names(en).join() !== names(ru).join());
    expect(bad).toEqual([]);
  });

  it('has no Cyrillic in English keys', async () => {
    const { russianTable } = await import('../ui/src/i18n/index.ts');
    expect(Object.keys(russianTable).filter((key) => /[А-Яа-яЁё]/.test(key))).toEqual([]);
  });
});
