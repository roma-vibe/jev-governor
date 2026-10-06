import type { LedgerEntry } from './api.ts';
import { locale, t } from './i18n/index.ts';

export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return t('{n} B', { n: (n / 1e9).toFixed(2) });
  if (abs >= 1e6) return t('{n} M', { n: (n / 1e6).toFixed(2) });
  if (abs >= 1e4) return t('{n} k', { n: (n / 1e3).toFixed(1) });
  return n.toLocaleString(locale());
}

export const fmtPct = (n: number, digits = 0): string => `${(n * 100).toFixed(digits)}%`;

/** Dollars of a cost: four decimals under $0.01, else two; a negative reads «−$0.60», not «$-0.6000». */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  const abs = Math.abs(n);
  return `${n < 0 ? '−' : ''}$${abs.toFixed(abs < 0.01 ? 4 : 2)}`;
}

/** Dollars with a «−» for a loss: four decimals under $0.01 (five under $0.0001), three under $1, else two. */
export function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 1e-9) return '$0';
  const digits = abs < 0.0001 ? 5 : abs < 0.01 ? 4 : abs < 1 ? 3 : 2;
  return `${n < 0 ? '−' : ''}$${abs.toFixed(digits)}`;
}

/** `fmtMoney` with an explicit «+» for a gain. */
export function fmtSigned(n: number): string {
  const text = fmtMoney(n);
  return n > 0 && text !== '$0' ? `+${text}` : text;
}

/** Text colour of an amount: green for a gain, red for a loss. */
export function moneyTone(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) < 1e-9) return '';
  return n > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400';
}

export function fmtTime(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(locale())
    : d.toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtAgo(ts: string | null | undefined): string {
  if (!ts) return t('never used');
  const diff = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(diff)) return '—';
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t('just now');
  if (min < 60) return t('{n} min ago', { n: min });
  const hours = Math.floor(min / 60);
  if (hours < 48) return t('{n} h ago', { n: hours });
  return t('{n} d ago', { n: Math.floor(hours / 24) });
}

/** `claude-opus-5-5` -> `Opus 5.5`; unknown ids as they are. */
export function modelName(model: string | undefined): string {
  if (!model) return '—';
  const m = /(opus|sonnet|haiku)-(\d+)-(\d+)/i.exec(model);
  if (!m) return model;
  const family = `${m[1]!.charAt(0).toUpperCase()}${m[1]!.slice(1).toLowerCase()}`;
  return `${family} ${m[2]}.${m[3]}`;
}

export function modelTone(model: string | undefined): 'opus' | 'sonnet' | 'other' {
  const m = (model ?? '').toLowerCase();
  return m.includes('opus') ? 'opus' : m.includes('sonnet') ? 'sonnet' : 'other';
}

export function projectName(project: string | undefined): string {
  if (!project) return '—';
  const parts = project.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? project;
}

export function modelEffort(e: LedgerEntry): string {
  const model = modelName(e.model);
  return e.effort ? `${model} · ${e.effort}` : model;
}

export const fmtP = (n: number | undefined): string => (typeof n === 'number' ? n.toFixed(2) : '—');

/** Stable keys for expandable rows (entries have no id). */
export function entryKeys(entries: LedgerEntry[]): string[] {
  const seen = new Map<string, number>();
  return entries.map((e) => {
    const base = `${e.ts}|${e.session}|${e.kind}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}|${n}`;
  });
}

export const effortOrder = ['low', 'medium', 'high', 'xhigh', 'max', 'unknown'];

/** `/Users/me/very/long/…/project` kept to about `max` characters, both ends visible. */
export function midTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(2, max - 1);
  const head = Math.ceil(keep * 0.45);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

/** A path as a shell word: left bare when plain, single-quoted otherwise. */
export function shellWord(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Copies text to the clipboard; false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      document.body.removeChild(area);
    }
  }
}
