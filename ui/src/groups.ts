import type { CommandGroup, ProjectCommandRecord } from './api.ts';
import { shellWord } from './format.ts';
import { t } from './i18n/index.ts';

/** Group order and titles of a project page; a function, so the titles follow the language. */
export function getGroups(): { id: CommandGroup; title: string }[] {
  return [
    { id: 'run', title: t('Run') },
    { id: 'build', title: t('Build and install') },
    { id: 'test', title: t('Tests') },
    { id: 'check', title: t('Checks') },
    { id: 'db', title: t('Database') },
    { id: 'deploy', title: t('Deploy and publish') },
    { id: 'other', title: t('Other') },
  ];
}

/** What «Копировать» puts on the clipboard: with the folder when the command has one. */
export const commandLine = (c: ProjectCommandRecord): string => (c.dir ? `cd ${shellWord(c.dir)} && ${c.command}` : c.command);

const RISKY = /\brm\b|drop|reset|--force|truncate|delete/i;

/** Commands that may change or delete data ask before running. */
export function confirmRun(c: ProjectCommandRecord): boolean {
  if (c.group !== 'db' && c.group !== 'deploy' && !RISKY.test(c.command)) return true;
  const where = c.dir ? `\n${t('Folder')}: ${c.dir}` : '';
  return window.confirm(`${t('Run in Terminal.app?')}\n\n${c.command}${where}\n\n${t('The command may change or delete data.')}`);
}

/** What the command editor hands back (empty strings = not set). */
export type EditorResult = { command: string; dir: string; group: CommandGroup; description: string };
