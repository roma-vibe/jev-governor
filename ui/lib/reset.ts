// The statistics reset: `ledger/RESET` holds the time the old statistics were
// archived. Entries before it are left out of the UI and the monitor's savings,
// except the learned project commands. A session that was running at the reset
// keeps that day's lines in memory and writes them back with its next entry;
// this cut is what keeps them out.

import fs from 'node:fs/promises';
import path from 'node:path';

import type { LedgerEntry } from '../../hooks/lib/types.ts';

/** ISO time of the last reset, or '' when there was none. */
export async function readReset(data: string): Promise<string> {
  try {
    const ts = (await fs.readFile(path.join(data, 'ledger', 'RESET'), 'utf8')).trim();
    return Number.isNaN(Date.parse(ts)) ? '' : ts;
  } catch {
    return '';
  }
}

/** Whether an entry outlived the reset: written after it, or a learned command. */
export const afterReset = (e: Pick<LedgerEntry, 'ts' | 'kind'>, reset: string): boolean => !reset || e.kind === 'command' || e.ts >= reset;
