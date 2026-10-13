import type { SavingEvent, SavingSource } from './api.ts';
import { locale, t } from './i18n/index.ts';

/** The sources in the order the page lists them; labels are translated when this is called. */
export function getSources(): { key: SavingSource; label: string; spend?: boolean }[] {
  return [
    { key: 'compact', label: t('Context compaction') },
    { key: 'trim', label: t('Output trimming') },
    { key: 'tools', label: t('Tools behind ToolSearch') },
    { key: 'jev', label: t('Jev'), spend: true },
    { key: 'calls', label: t('The mod’s own model calls'), spend: true },
  ];
}

export const sourceLabel = (key: SavingSource): string => getSources().find((s) => s.key === key)?.label ?? key;

const FAMILIES: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', haiku4: 'Haiku 4', fable: 'Fable' };
export const familyLabel = (f: string | undefined): string => (f ? (FAMILIES[f] ?? f) : '?');

function reasonLabel(reason: string): string {
  switch (reason) {
    case 'threshold':
      return t('at the threshold');
    case 'return':
      return t('after a pause');
    case 'window':
      return t('mid-turn or in a subagent');
    case 'engine':
      return t("instead of Claude Code's summary");
    default:
      return reason;
  }
}

function purposeLabel(purpose: string | undefined): string {
  switch (purpose) {
    case 'draft':
      return t('drafting a specialist');
    case 'merge':
      return t('merging specialists');
    case 'autosave':
      return t('saving facts from the dialog');
    case 'autosave-check':
      return t('checking the facts to save');
    case 'describe':
      return t('describing project commands');
    case 'handoff':
      return t('handoff brief');
    default:
      return purpose ?? '?';
  }
}

const tokens = (n: number): string => t('{count} {n#token|tokens}', { count: n.toLocaleString(locale()), n });
const rereads = (n: number): string => t('would have been re-read {n} {n#time|times}', { n });

/** What happened, in words: `text` is the line, `detail` an optional quote shown under it. */
export function describeEvent(ev: SavingEvent): { text: string; detail?: string } {
  switch (ev.source) {
    case 'trim': {
      const parts = [t('trimmed {tokens}', { tokens: tokens(ev.tokens ?? 0) })];
      if (ev.laterRequests !== undefined) parts.push(rereads(ev.laterRequests));
      return { text: parts.join(', ') };
    }
    case 'compact': {
      const parts = [t('compacted {tokens}', { tokens: tokens(ev.tokens ?? 0) })];
      if (ev.reason) parts.push(reasonLabel(ev.reason));
      if (ev.laterRequests !== undefined) parts.push(rereads(ev.laterRequests));
      return { text: parts.join(' · ') };
    }
    case 'tools': {
      const parts = [
        t('{n} {n#tool|tools} behind ToolSearch, {tokens}', { n: ev.deferred ?? 0, tokens: tokens(ev.tokens ?? 0) }),
        t('out of {n} {n#request|requests}', { n: ev.laterRequests ?? 0 }),
      ];
      return { text: parts.join(' · ') };
    }
    case 'jev':
      return { text: t('request to Jev'), ...(ev.text ? { detail: ev.text } : {}) };
    case 'calls':
      return { text: `${purposeLabel(ev.purpose)} · ${familyLabel(ev.model)}` };
  }
}
