import { AsyncLocalStorage } from 'node:async_hooks';

export type Lang = 'en' | 'ru';

const requestLang = new AsyncLocalStorage<Lang>();

/** Language of messages outside a request (command line, startup): the configured one. */
let fallback: Lang = 'en';

export const setFallbackLang = (lang: Lang): void => {
  fallback = lang;
};

export const parseLang = (value: unknown): Lang | undefined => (value === 'ru' || value === 'en' ? value : undefined);

/** Runs `fn` with the language the page asked for (header `X-Jev-Lang`). */
export const withLang = <T>(lang: Lang | undefined, fn: () => T): T => (lang ? requestLang.run(lang, fn) : fn());

/** The text in the language of the current request: `tr('Not found.', 'Не найдено.')`. */
export const tr = (en: string, ru: string): string => ((requestLang.getStore() ?? fallback) === 'ru' ? ru : en);
