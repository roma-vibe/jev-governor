// The language of the mod's own messages (chat notices, toasts, command replies):
// the setting `ui.language` is 'en', 'ru' or 'auto'; 'auto' follows Claude Code's
// `language` setting, then the system locale.

export type Lang = 'en' | 'ru';

const isRussian = (s: unknown): boolean => typeof s === 'string' && /^(ru|rus|russian|рус)/i.test(s.trim());

/**
 * `claudeLanguage` is `language` from Claude Code's settings.json (a name or code),
 * `locales` the environment's (LC_ALL, LANG, the system locale), most specific first.
 */
export function resolveLang(setting: string | undefined, claudeLanguage?: unknown, locales: readonly (string | undefined)[] = []): Lang {
  if (setting === 'ru') return 'ru';
  if (setting === 'en') return 'en';
  if (typeof claudeLanguage === 'string' && claudeLanguage.trim()) return isRussian(claudeLanguage) ? 'ru' : 'en';
  const locale = locales.find((l) => l && l !== 'C' && l !== 'POSIX');
  return isRussian(locale) ? 'ru' : 'en';
}

/** The locales of this process: LC_ALL, LANG, and Intl's (the system's on macOS and Windows). */
export function systemLocales(): (string | undefined)[] {
  let intl: string | undefined;
  try {
    intl = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    // none
  }
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return [env?.LC_ALL, env?.LANG, intl];
}
