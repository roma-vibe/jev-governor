// Budget pressure from the subscription's rate-limit windows, as
// `$.session.usage().rateLimits` reports them. The idea is pace, not level: a
// window 60% used with 10% of its time left is fine, 60% used with 80% of its
// time left means the account is burning faster than it can sustain.

export type RateWindow = { kind: string; percentUsed: number; resetsAt?: string };

/** 0 relaxed, 1 watch, 2 tight, 3 critical. */
export type Pressure = 0 | 1 | 2 | 3;

const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * 3600_000,
  seven_day: 7 * 24 * 3600_000,
};

export type WindowPace = {
  kind: string;
  used: number;
  /** Fraction of the window's time already gone, when known. */
  elapsed?: number;
  /** used − elapsed: positive when ahead of a linear pace. */
  ahead?: number;
  pressure: Pressure;
};

export function windowPace(window: RateWindow, now: number): WindowPace {
  const used = Math.max(0, window.percentUsed) / 100;
  const duration = WINDOW_MS[window.kind];
  let elapsed: number | undefined;
  if (duration && window.resetsAt) {
    const resetsAt = Date.parse(window.resetsAt);
    if (Number.isFinite(resetsAt)) {
      elapsed = Math.min(1, Math.max(0, 1 - (resetsAt - now) / duration));
    }
  }
  const ahead = elapsed === undefined ? undefined : used - elapsed;
  let pressure: Pressure = 0;
  if (used >= 0.95) pressure = 3;
  else if (used >= 0.85 || (ahead !== undefined && ahead > 0.25)) pressure = 2;
  else if (used >= 0.7 || (ahead !== undefined && ahead > 0.1)) pressure = 1;
  // Early in a window a small absolute use is not alarming even when "ahead".
  if (pressure > 0 && used < 0.3) pressure = 0;
  return { kind: window.kind, used, elapsed, ahead, pressure };
}

export function budgetPressure(
  windows: readonly RateWindow[],
  now: number,
): { pressure: Pressure; windows: WindowPace[] } {
  const paces = windows.map((window) => windowPace(window, now));
  const pressure = paces.reduce<Pressure>((max, pace) => (pace.pressure > max ? pace.pressure : max), 0);
  return { pressure, windows: paces };
}

export function describePressure(windows: readonly WindowPace[]): string {
  return windows
    .filter((w) => w.kind in WINDOW_MS)
    .map((w) => `${w.kind === 'five_hour' ? '5h' : '7d'} ${Math.round(w.used * 100)}%`)
    .join(' · ');
}
