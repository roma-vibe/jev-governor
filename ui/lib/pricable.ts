// Which ledger entries the savings report can price. The UI server and
// scripts/monitor.mjs both filter with it, so a malformed line drops out of
// both the same way.

import type { LedgerEntry } from '../../hooks/lib/types.ts';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A ledger entry computeSavings can price: one malformed line must not break the whole report. */
export function pricable(e: LedgerEntry): boolean {
  if (e.jevCost !== undefined && !finite(e.jevCost)) return false;
  if (e.kind === 'usage') {
    const u = e.usage;
    return isObject(u) && typeof u.model === 'string' && (['input', 'output', 'cacheRead', 'cacheWrite'] as const).every((k) => finite(u[k]));
  }
  if (e.kind === 'trim') return isObject(e.trim) && finite(e.trim.charsBefore) && finite(e.trim.charsAfter);
  if (e.kind === 'compact' && isObject(e.compaction) && !e.compaction.fallback) {
    return finite(e.compaction.charsBefore) && finite(e.compaction.charsAfter);
  }
  return true;
}
