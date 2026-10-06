import { ref } from 'vue';

import app from './ru/app.ts';
import common from './ru/common.ts';
import journal from './ru/journal.ts';
import overview from './ru/overview.ts';
import people from './ru/people.ts';
import projects from './ru/projects.ts';
import savings from './ru/savings.ts';
import settings from './ru/settings.ts';

export type Lang = 'en' | 'ru';

export const LANGS: { value: Lang; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'ru', label: 'Русский' },
];

/** English text is the key; this table holds the Russian text for it. */
const RU: Record<string, string> = { ...common, ...app, ...settings, ...overview, ...savings, ...projects, ...people, ...journal };

const STORAGE_KEY = 'jev-governor.lang';

function stored(): Lang {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'ru' ? 'ru' : 'en';
  } catch {
    return 'en';
  }
}

/** The language of the page; reactive, so everything that calls `t` re-renders on a change. */
export const lang = ref<Lang>(stored());

export function setLang(next: Lang): void {
  lang.value = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // private mode: the language is then taken from the config on every load
  }
  document.documentElement.lang = next;
}

/** Locale tag for number and date formatting. */
export const locale = (): string => (lang.value === 'ru' ? 'ru-RU' : 'en-US');

/** Index of the plural form: English has two (1 / other), Russian three (1, 21 / 2–4 / 0, 5–20). */
function pluralIndex(n: number): number {
  if (lang.value !== 'ru') return Math.abs(n) === 1 ? 0 : 1;
  const m100 = Math.abs(n) % 100;
  const m10 = m100 % 10;
  if (m100 > 10 && m100 < 20) return 2;
  if (m10 === 1) return 0;
  return m10 >= 2 && m10 <= 4 ? 1 : 2;
}

/**
 * Translates `text` (English) and fills it in: `{name}` takes `params.name`,
 * `{n#form one|form other}` picks the plural form for `params.n`
 * (Russian entries give three forms: `{n#сессия|сессии|сессий}`).
 */
export function t(text: string, params?: Record<string, string | number>): string {
  const template = lang.value === 'ru' ? (RU[text] ?? text) : text;
  if (!params) return template;
  return template.replace(/\{(\w+)(?:#([^}]*))?\}/g, (whole, name: string, forms: string | undefined) => {
    const value = params[name];
    if (value === undefined) return whole;
    if (forms === undefined) return String(value);
    const list = forms.split('|');
    return list[Math.min(pluralIndex(Number(value)), list.length - 1)] ?? '';
  });
}

/** The Russian table, for the completeness test. */
export const russianTable = RU;
