import type { SavingEvent, SavingSource } from './api.ts';
import { locale, t } from './i18n/index.ts';
import { fmtMoney } from './format.ts';

/** The sources in the order the page lists them; labels are translated when this is called. */
export function getSources(): { key: SavingSource; label: string; estimate?: boolean }[] {
  return [
    { key: 'model', label: t('Model choice') },
    { key: 'effort', label: t('Effort level (estimate)'), estimate: true },
    { key: 'trim', label: t('Output trimming') },
    { key: 'compact', label: t('Context compaction') },
    { key: 'jev', label: t('Jev') },
  ];
}

export const sourceLabel = (key: SavingSource): string =>
  (key === 'effort' ? t('Effort level') : getSources().find((s) => s.key === key)?.label) ?? key;

const FAMILIES: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', haiku4: 'Haiku 4', fable: 'Fable' };
const family = (f: string | undefined): string => (f ? (FAMILIES[f] ?? f) : '?');

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

const tokens = (n: number): string => t('{count} {n#token|tokens}', { count: n.toLocaleString(locale()), n });
const rereads = (n: number): string => t('would have been re-read {n} {n#time|times}', { n });
const turnCost = (text: string, cost: number | undefined): string =>
  cost === undefined ? text : `${text} · ${t('turn {cost}', { cost: fmtMoney(cost) })}`;

/** What happened, in words: `text` is the line, `detail` an optional quote shown under it. */
export function describeEvent(ev: SavingEvent): { text: string; detail?: string } {
  switch (ev.source) {
    case 'model': {
      const why = ev.rewrite
        ? ` (${t('the model change rewrote the cache: {tokens}', { tokens: tokens(ev.rewrite) })})`
        : ev.amount < 0
          ? ` (${t('quality surcharge')})`
          : '';
      const text = `${ev.rewrite && ev.fromModel !== ev.toModel ? `${family(ev.fromModel)} → ${family(ev.toModel)}` : t('{to} instead of {from}', { to: family(ev.toModel), from: family(ev.fromModel) })}${why}`;
      return { text: turnCost(text, ev.turnCost) };
    }
    case 'effort': {
      const text = t('effort {from} → {to}', { from: ev.fromEffort ?? '?', to: ev.toEffort ?? '?' });
      return { text: turnCost(text, ev.turnCost) };
    }
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
    case 'jev':
      return { text: t('request to Jev'), ...(ev.text ? { detail: ev.text } : {}) };
  }
}
