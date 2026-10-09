#!/usr/bin/env node
// jev-governor settings UI: a dependency-free local server.
//
//   node ui/server.ts [--port 4777] [--data <dir>] [--detach]
//
// Serves the built Vue app from ui/dist and a small JSON API over the shared
// data directory (docs/DATA.md). Validation is the mod's own code (hooks/lib),
// imported directly: Node runs TypeScript natively (this file included).

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLang, systemLocales } from '../hooks/lib/lang.ts';
import { DEFAULT_CONFIG, expandHome, resolveConfig } from '../hooks/lib/config.ts';
import { parseLang, setFallbackLang, tr, withLang } from './lib/i18n.ts';
import { jevAsker, noul, type HttpLike } from '../hooks/lib/jev.ts';
import { LIMITS, NAME_RE, sanitizeAgent, sanitizeSkill, uniqueName } from '../hooks/lib/registry.ts';
import { computeSavings, familyOf, usageCost, type SavingEvent, type SavingSource, type SavingsOptions } from '../hooks/lib/savings.ts';
import type { AgentRecord, DraftRecord, GovernorConfig, LedgerEntry, MergeRequest, SkillRecord } from '../hooks/lib/types.ts';
import { pricable } from './lib/pricable.ts';
import { createProjects, entriesOfProject } from './lib/projects.ts';

const VERSION = '0.3.10';
const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(UI_DIR);
const DIST = path.join(UI_DIR, 'dist');
const HOME = os.homedir();
const BODY_LIMIT = 256 * 1024;
const DAY_MS = 86_400_000;
const DRAFT_ID_RE = /^[a-z0-9-]{6,40}$/;
const LEDGER_KINDS = new Set(['turn', 'subagent', 'usage', 'compact', 'agent-created', 'trim', 'output-read', 'command', 'handoff', 'hint', 'error']);

// ------------------------------------------------------------------- CLI --

type Args = { detach: boolean; port: string | undefined; data: string | undefined; help?: boolean };

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { detach: false, port: undefined, data: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined;
    const name = inline === undefined ? arg : arg.slice(0, arg.indexOf('='));
    if (name === '--detach') out.detach = true;
    else if (name === '--port') out.port = inline ?? argv[++i];
    else if (name === '--data') out.data = inline ?? argv[++i];
    else if (name === '--help' || name === '-h') out.help = true;
    else fail(tr(`Unknown argument: ${arg}`, `Неизвестный аргумент: ${arg}`));
  }
  return out;
}

function fail(message: string): never {
  process.stderr.write(`jev-governor UI: ${message}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write('node ui/server.ts [--port 4777] [--data <dir>] [--detach]\n');
  process.exit(0);
}

const DATA = path.resolve(expandHome(args.data ?? process.env.JEV_GOVERNOR_HOME ?? '~/.claude/jev-governor', HOME));
const CONFIG_FILE = path.join(DATA, 'config.json');

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function resolvePort(): Promise<number> {
  if (args.port !== undefined) {
    const port = Number(args.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) fail(tr(`Invalid port: ${args.port}`, `Недопустимый порт: ${args.port}`));
    return port;
  }
  return resolveConfig(await readJson(CONFIG_FILE)).ui.port;
}

const claudeLanguage = (await readJson(path.join(path.dirname(DATA), 'settings.json')) as { language?: unknown } | undefined)?.language;
setFallbackLang(resolveLang(resolveConfig(await readJson(CONFIG_FILE)).ui.language, claudeLanguage, systemLocales()));
const PORT = await resolvePort();
const URL_LINE = `jev-governor UI: http://127.0.0.1:${PORT}`;

// ----------------------------------------------------------------- utils --

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isArray = (v: unknown): v is unknown[] => Array.isArray(v);
const nowIso = () => new Date().toISOString();

/** Writes `text` next to `file` and renames it over: readers never see a half-written file. */
async function writeAtomic(file: string, text: string, mode = 0o644): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, text, { mode });
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

const writeJson = (file: string, value: unknown) => writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
  } catch {
    return [];
  }
}

// One mutation at a time: a rename touches several files.
let lockChain: Promise<void> = Promise.resolve();
function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = lockChain.then(fn, fn);
  lockChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Checks the name as RegExp#test sees it (a missing name reads as "undefined"). */
function assertName(name: unknown, what: string): void {
  if (!NAME_RE.test(String(name))) {
    throw new HttpError(
      400,
      tr(
        `Invalid ${what} name: allowed are a-z, 0-9 and hyphen, 2–40 characters, starting with a letter.`,
        `Недопустимое имя ${what}: допустимы a-z, 0-9 и дефис, 2–40 символов, начинается с буквы.`,
      ),
    );
  }
}

// ---------------------------------------------------------------- config --

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Deep-merges a patch onto the current config; known keys must keep their type. */
function mergePatch(base: Json, patch: unknown, where = ''): Json {
  if (!isObject(patch)) throw new HttpError(400, tr(`Expected an object${where ? ` in “${where}”` : ''}.`, `Ожидался объект${where ? ` в «${where}»` : ''}.`));
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(key) || !Object.hasOwn(base, key)) continue;
    const here = where ? `${where}.${key}` : key;
    const current = base[key];
    if (isObject(current)) {
      out[key] = mergePatch(current, value, here);
    } else if (Array.isArray(current)) {
      if (!isArray(value) || !value.every((s): s is string => typeof s === 'string' && s.length <= 500)) {
        throw new HttpError(400, tr(`“${here}” must be a list of strings.`, `«${here}» должно быть списком строк.`));
      }
      out[key] = [...new Set(value.map((s) => s.trim()).filter(Boolean))];
    } else if (typeof value !== typeof current) {
      throw new HttpError(400, tr(`“${here}”: expected type ${typeof current}.`, `«${here}»: ожидался тип ${typeof current}.`));
    } else if (here === 'mode' && value !== 'active' && value !== 'shadow') {
      throw new HttpError(400, tr('“mode” must be “active” or “shadow”.', '«mode» должен быть «active» или «shadow».'));
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function loadConfig(): Promise<GovernorConfig> {
  return resolveConfig(await readJson(CONFIG_FILE));
}

async function saveConfig(config: unknown): Promise<GovernorConfig> {
  const resolved = resolveConfig(config);
  await writeJson(CONFIG_FILE, resolved);
  return resolved;
}

// ------------------------------------------------------------------- key --

type KeySource = 'env' | 'keyFile' | 'pluginRoot';
type FoundKey = { key: string | undefined; source: KeySource | null; path: string | null };

/** Same order as the mod: env, the configured key file, then the repo root. */
async function findKey(config: GovernorConfig): Promise<FoundKey> {
  const env = (process.env.OPENROUTER_API_KEY ?? '').trim();
  if (env) return { key: env, source: 'env', path: null };
  const places: [KeySource, string][] = [
    ['keyFile', expandHome(config.jev.keyFile, HOME)],
    ['pluginRoot', path.join(ROOT, '.openrouter_key')],
  ];
  for (const [source, file] of places) {
    try {
      const key = (await fs.readFile(file, 'utf8')).trim();
      if (key) return { key, source, path: file };
    } catch {
      // try the next place
    }
  }
  return { key: undefined, source: null, path: null };
}

async function keyStatus() {
  const config = await loadConfig();
  const found = await findKey(config);
  return {
    found: found.key !== undefined,
    source: found.source,
    path: found.path,
    keyFile: expandHome(config.jev.keyFile, HOME),
  };
}

async function saveKey(raw: unknown) {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key.startsWith('sk-or-')) throw new HttpError(400, tr('The OpenRouter key must start with “sk-or-”.', 'Ключ OpenRouter должен начинаться с «sk-or-».'));
  if (key.length > 500 || /[\s\u0000-\u001f]/.test(key)) throw new HttpError(400, tr('The key contains invalid characters.', 'В ключе недопустимые символы.'));
  const config = await loadConfig();
  const file = expandHome(config.jev.keyFile, HOME);
  if (!path.isAbsolute(file)) {
    throw new HttpError(
      400,
      tr(
        'The key file (jev.keyFile) must be an absolute path or start with “~/”.',
        'Файл ключа (jev.keyFile) должен быть абсолютным путём или начинаться с «~/».',
      ),
    );
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeAtomic(file, `${key}\n`, 0o600);
  const active = await findKey(config);
  return { found: true, source: 'keyFile', path: file, activeSource: active.source };
}

async function testJev() {
  const config = await loadConfig();
  const { key } = await findKey(config);
  if (!key) return { ok: false, error: tr('OpenRouter key not found: set it in the settings.', 'Ключ OpenRouter не найден: задайте его в настройках.') };
  const http: HttpLike = async (url, init) => {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    return { status: response.status, ok: response.ok, text: await response.text() };
  };
  const asker = jevAsker({ http, endpoint: config.jev.endpoint, apiKey: key, model: config.jev.model });
  const started = Date.now();
  try {
    const response = await asker.ask('The sky is blue.', {
      q: { type: 'noul', instructions: 'The state says the sky is blue' },
    });
    const value = noul(response.answers, 'q');
    if (value === undefined) return { ok: false, error: tr('Jev replied, but without the expected noul field.', 'Jev ответил, но без ожидаемого поля noul.') };
    return { ok: true, ms: Date.now() - started, noul: value, cost: response.usage?.cost ?? null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = error instanceof Error && error.name === 'TimeoutError' ? tr('timeout 8 s', 'таймаут 8 с') : message;
    return { ok: false, error: reason.split(key).join('***').slice(0, 300) };
  }
}

// ---------------------------------------------------------------- ledger --

const ledgerCache = new Map<string, { mtimeMs: number; size: number; entries: LedgerEntry[] }>();

/**
 * The entries of one ledger file. Only `ts` is checked here: the mod wrote
 * these lines, and every reader below checks the fields it uses.
 */
async function readLedgerFile(file: string): Promise<LedgerEntry[]> {
  const st = await fs.stat(file);
  const cached = ledgerCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.entries;
  const entries: LedgerEntry[] = [];
  for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isObject(value) && typeof value.ts === 'string' && Number.isFinite(Date.parse(value.ts))) entries.push(value as LedgerEntry);
    } catch {
      // skip malformed lines
    }
  }
  if (ledgerCache.size > 500) ledgerCache.clear();
  ledgerCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, entries });
  return entries;
}

/** Ledger entries of the last `days` days, newest first. */
async function loadLedger(days: number): Promise<LedgerEntry[]> {
  const now = Date.now();
  const cutoff = now - days * DAY_MS;
  const firstDay = new Date(cutoff).toISOString().slice(0, 10);
  const root = path.join(DATA, 'ledger');
  let dayDirs: string[] = [];
  try {
    dayDirs = (await fs.readdir(root)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= firstDay);
  } catch {
    return [];
  }
  const all: LedgerEntry[] = [];
  for (const day of dayDirs) {
    let files: string[] = [];
    try {
      files = (await fs.readdir(path.join(root, day))).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of files) {
      try {
        for (const entry of await readLedgerFile(path.join(root, day, name))) {
          if (Date.parse(entry.ts) >= cutoff) all.push(entry);
        }
      } catch {
        // file vanished or unreadable
      }
    }
  }
  return all.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

type ModelClass = 'sonnet' | 'opus' | 'other';

const modelClass = (model: unknown): ModelClass => {
  const m = typeof model === 'string' ? model.toLowerCase() : '';
  return m.includes('opus') ? 'opus' : m.includes('sonnet') ? 'sonnet' : 'other';
};

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

type TrimOutcome = 'passed' | 'failed' | 'build-error' | 'error' | 'unknown';

/** Outcome class of a trim entry, from the start of its `outcome` text (see hooks/lib/trim.ts). */
function trimOutcome(text: unknown): TrimOutcome {
  const t = typeof text === 'string' ? text.trimStart() : '';
  if (t.startsWith('tests passed')) return 'passed';
  if (t.startsWith('tests FAILED')) return 'failed';
  if (t.startsWith('build failed')) return 'build-error';
  if (t.startsWith('command exited')) return 'error';
  return 'unknown';
}

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };
type ByModel<T> = Record<ModelClass, T>;

/** GET /api/stats without `savings` (the UI's `Stats` type). */
type LedgerStats = {
  days: number;
  entries: number;
  turns: { count: number; shadow: number; byModel: ByModel<number>; byEffort: Record<string, number>; switches: number };
  subagents: { count: number; shadow: number; byModel: ByModel<number>; byAgent: { agent: string; count: number }[]; created: number };
  rate: { fiveHour: number | null; sevenDay: number | null; ts: string | null };
  usage: { main: ByModel<Tokens>; subagent: ByModel<Tokens> };
  jev: { requests: number; cost: number; avgMs: number };
  compactions: {
    ok: number;
    fallback: number;
    avgRatio: number;
    byReason: { engine: number; threshold: number; return: number; window: number };
    /** Of them, inside subagents. */
    subagent: number;
    /** Average context per model request (input + cache read + cache write) / steps, from `usage` entries. */
    contextPerRequest: { main: number; subagent: number };
  };
  trims: {
    count: number;
    applied: number;
    shadow: number;
    skipped: number;
    /** Outputs Jev judged data, not a log: kept whole. */
    logsData: number;
    charsBefore: number;
    charsAfter: number;
    saved: number;
    savedPct: number;
    jevChunks: number;
    byOutcome: Record<TrimOutcome, number>;
  };
  errors: number;
  agentsCreated: number;
};

function computeStats(entries: readonly LedgerEntry[], days: number): LedgerStats {
  const byModel = () => ({ sonnet: 0, opus: 0, other: 0 });
  const tokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const stats: LedgerStats = {
    days,
    entries: entries.length,
    // `count` and the breakdowns cover applied decisions only; shadow-mode
    // decisions (applied === false) are counted apart.
    turns: { count: 0, shadow: 0, byModel: byModel(), byEffort: {}, switches: 0 },
    subagents: { count: 0, shadow: 0, byModel: byModel(), byAgent: [], created: 0 },
    rate: { fiveHour: null, sevenDay: null, ts: null },
    usage: {
      main: { sonnet: tokens(), opus: tokens(), other: tokens() },
      subagent: { sonnet: tokens(), opus: tokens(), other: tokens() },
    },
    jev: { requests: 0, cost: 0, avgMs: 0 },
    // `ok`/`fallback`/`avgRatio` as before; `byReason` counts every compaction
    // (fallbacks included) by what triggered it. Entries without a reason are Claude Code's own.
    compactions: { ok: 0, fallback: 0, avgRatio: 0, byReason: { engine: 0, threshold: 0, return: 0, window: 0 }, subagent: 0, contextPerRequest: { main: 0, subagent: 0 } },
    // Trimmed tool outputs. Totals cover applied trims only; shadow-mode trims
    // (applied === false) are counted apart and add nothing to the savings.
    trims: {
      count: 0,
      applied: 0,
      shadow: 0,
      skipped: 0,
      logsData: 0,
      charsBefore: 0,
      charsAfter: 0,
      saved: 0,
      savedPct: 0,
      jevChunks: 0,
      byOutcome: { passed: 0, failed: 0, 'build-error': 0, error: 0, unknown: 0 },
    },
    errors: 0,
    agentsCreated: 0,
  };
  const agents = new Map<string, number>();
  let jevMsSum = 0;
  let jevMsCount = 0;
  let ratioSum = 0;
  const ctxSums = { main: { tokens: 0, steps: 0 }, subagent: { tokens: 0, steps: 0 } };
  for (const e of entries) {
    if (e.kind === 'turn' || e.kind === 'subagent') {
      const jevCost = num(e.jevCost);
      if (jevCost !== undefined) {
        stats.jev.requests++;
        stats.jev.cost += jevCost;
      }
      const jevMs = num(e.jevMs);
      if (jevMs !== undefined) {
        jevMsSum += jevMs;
        jevMsCount++;
      }
    }
    if (isObject(e.rate)) {
      // Entries are newest first: the first value seen is the latest.
      const fiveHour = num(e.rate.fiveHour);
      const sevenDay = num(e.rate.sevenDay);
      if (stats.rate.fiveHour === null && fiveHour !== undefined) stats.rate.fiveHour = fiveHour;
      if (stats.rate.sevenDay === null && sevenDay !== undefined) stats.rate.sevenDay = sevenDay;
      if (stats.rate.ts === null && (fiveHour !== undefined || sevenDay !== undefined)) {
        stats.rate.ts = e.ts;
      }
    }
    if ((e.kind === 'turn' || e.kind === 'subagent') && e.applied === false) {
      stats[e.kind === 'turn' ? 'turns' : 'subagents'].shadow++;
    } else if (e.kind === 'turn') {
      stats.turns.count++;
      stats.turns.byModel[modelClass(e.model)]++;
      const effort = typeof e.effort === 'string' ? e.effort : 'unknown';
      stats.turns.byEffort[effort] = (stats.turns.byEffort[effort] ?? 0) + 1;
      if (e.switched === true) stats.turns.switches++;
    } else if (e.kind === 'subagent') {
      stats.subagents.count++;
      stats.subagents.byModel[modelClass(e.model)]++;
      if (e.created === true) stats.subagents.created++;
      if (typeof e.agent === 'string' && e.agent) agents.set(e.agent, (agents.get(e.agent) ?? 0) + 1);
    } else if (e.kind === 'usage' && isObject(e.usage)) {
      const bucket = stats.usage[e.scope === 'subagent' ? 'subagent' : 'main'][modelClass(e.usage.model)];
      bucket.input += num(e.usage.input) ?? 0;
      bucket.output += num(e.usage.output) ?? 0;
      bucket.cacheRead += num(e.usage.cacheRead) ?? 0;
      bucket.cacheWrite += num(e.usage.cacheWrite) ?? 0;
      const ctx = ctxSums[e.scope === 'subagent' ? 'subagent' : 'main'];
      ctx.tokens += (num(e.usage.input) ?? 0) + (num(e.usage.cacheRead) ?? 0) + (num(e.usage.cacheWrite) ?? 0);
      ctx.steps += Math.max(1, num(e.steps) ?? 1);
    } else if (e.kind === 'compact' && isObject(e.compaction)) {
      const r = e.compaction.reason;
      const reason = r === 'threshold' || r === 'return' || r === 'window' ? r : 'engine';
      stats.compactions.byReason[reason]++;
      if (e.agentId !== undefined || e.scope === 'subagent') stats.compactions.subagent++;
      if (e.compaction.fallback) {
        stats.compactions.fallback++;
      } else {
        stats.compactions.ok++;
        ratioSum += num(e.compaction.ratio) ?? 0;
      }
    } else if (e.kind === 'trim' && isObject(e.trim)) {
      const t = stats.trims;
      t.count++;
      if (e.applied === false && e.trim.kind === 'log' && typeof e.trim.skipped === 'string' && e.trim.skipped.startsWith('Jev')) {
        t.logsData++;
      } else if (e.applied === false && e.trim.skipped) {
        t.skipped++;
      } else if (e.applied === false) {
        t.shadow++;
      } else {
        t.applied++;
        const before = num(e.trim.charsBefore) ?? 0;
        const after = num(e.trim.charsAfter) ?? 0;
        t.charsBefore += before;
        t.charsAfter += after;
        t.saved += Math.max(0, before - after);
        t.jevChunks += num(e.trim.jevChunks) ?? 0;
        t.byOutcome[trimOutcome(e.trim.outcome)]++;
      }
    } else if (e.kind === 'error') {
      stats.errors++;
    } else if (e.kind === 'agent-created' && e.change === undefined) {
      // A merge or a retirement is logged under the same kind: only new specialists count.
      stats.agentsCreated++;
    }
  }
  stats.subagents.byAgent = [...agents]
    .map(([agent, count]) => ({ agent, count }))
    .sort((a, b) => b.count - a.count || a.agent.localeCompare(b.agent))
    .slice(0, 10);
  stats.jev.avgMs = jevMsCount ? Math.round(jevMsSum / jevMsCount) : 0;
  stats.compactions.avgRatio = stats.compactions.ok ? ratioSum / stats.compactions.ok : 0;
  for (const k of ['main', 'subagent'] as const) {
    stats.compactions.contextPerRequest[k] = ctxSums[k].steps ? Math.round(ctxSums[k].tokens / ctxSums[k].steps) : 0;
  }
  stats.trims.savedPct = stats.trims.charsBefore ? stats.trims.saved / stats.trims.charsBefore : 0;
  return stats;
}

// --------------------------------------------------------------- savings --

const SAVINGS_EVENT_CAP = 500;
/** Window of the ledger the session -> project map is read from when a report is limited to one project. */
const SESSION_MAP_DAYS = 30;
const SAVING_SOURCES: readonly SavingSource[] = ['model', 'effort', 'trim', 'compact', 'jev'];

const savingsOptions = (config: GovernorConfig): SavingsOptions => ({
  effortFactor: config.savings.effortFactor,
  defaultBase: { model: config.savings.defaultBaseModel, effort: config.savings.defaultBaseEffort },
});

type SavingsRow = { exact: number; estimated: number; jev: number; actual: number };

/** Per project folder name ('' = unknown): what the mod saved and what the managed turns cost. */
function savingsByProject(entries: readonly LedgerEntry[], events: readonly SavingEvent[]): Record<string, SavingsRow> {
  const out = Object.create(null) as Record<string, SavingsRow>;
  const row = (name: string) => (out[name] ??= { exact: 0, estimated: 0, jev: 0, actual: 0 });
  for (const ev of events) {
    const r = row(ev.project ?? '');
    if (ev.source === 'jev') r.jev -= ev.amount;
    else if (ev.estimate) r.estimated += ev.amount;
    else r.exact += ev.amount;
  }
  for (const e of entries) {
    // `entries` are pricable: every `usage` entry has its usage.
    if (e.applied === false || e.kind !== 'usage' || !e.usage) continue;
    const ran = familyOf(e.usage.model);
    if (ran) row(e.project ?? '').actual += usageCost(e.usage, ran, e.scope !== 'subagent');
  }
  return out;
}

/** GET /api/savings: the report for the last `days` days, optionally for one project. */
async function savingsReport(days: number, projectId: string | undefined) {
  const config = await loadConfig();
  // One project needs discovery: with the panel off it answers as /api/projects does, and scans nothing.
  if (projectId && !config.projects.enabled) throw new HttpError(404, projectsOff());
  const project = projectId ? await projects.findProject(projectId) : undefined;
  const entries = await loadLedger(days);
  let scope = entries;
  if (project) {
    const mapping = days >= SESSION_MAP_DAYS ? entries : await loadLedger(SESSION_MAP_DAYS);
    scope = entriesOfProject(project, entries, mapping);
  }
  const clean = scope.filter(pricable);
  const report = computeSavings(clean, savingsOptions(config));
  const estimatedBySource = Object.fromEntries(SAVING_SOURCES.map((s) => [s, 0])) as Record<SavingSource, number>;
  for (const ev of report.events) if (ev.estimate) estimatedBySource[ev.source] += ev.amount;
  return {
    days,
    project: project ? project.id : null,
    totals: report.totals,
    // The part of each source's total that is an estimate (compaction mixes both).
    estimatedBySource,
    byDay: report.byDay,
    eventCount: report.events.length,
    events: report.events.slice(0, SAVINGS_EVENT_CAP),
    ...(project ? {} : { byProject: savingsByProject(clean, report.events) }),
  };
}

// ----------------------------------------------------- agents and skills --

const agentFile = (name: string) => path.join(DATA, 'agents', `${name}.json`);
const skillFile = (name: string) => path.join(DATA, 'skills', `${name}.json`);

type Sanitize<T> = (raw: unknown, now: string) => T | undefined;

async function readRecords<T extends { name: string }>(dir: string, sanitize: Sanitize<T>): Promise<T[]> {
  const now = nowIso();
  const out: T[] = [];
  for (const file of await listJsonFiles(path.join(DATA, dir))) {
    const record = sanitize(await readJson(path.join(DATA, dir, file)), now);
    if (record) out.push(record);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const readAgents = () => readRecords('agents', sanitizeAgent);
const readSkills = () => readRecords('skills', sanitizeSkill);

async function readOne<T>(file: string, sanitize: Sanitize<T>): Promise<T | undefined> {
  return sanitize(await readJson(file), nowIso());
}

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

function requireText(body: Json, field: string, label: string, max: number): void {
  const raw = body[field];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw new HttpError(400, tr(`The “${label}” field is required.`, `Поле «${label}» обязательно.`));
  if (value.length > max) throw new HttpError(400, tr(`The “${label}” field is longer than ${max} characters.`, `Поле «${label}» длиннее ${max} символов.`));
}

function checkAgentBody(body: Json, skillNames: ReadonlySet<string>): void {
  assertName(body.name, tr('agent', 'агента'));
  requireText(body, 'description', tr('Description', 'Описание'), LIMITS.description);
  requireText(body, 'prompt', tr('Prompt', 'Промпт'), LIMITS.prompt);
  const skills = body.skills ?? [];
  if (!isArray(skills) || !skills.every((s): s is string => typeof s === 'string')) {
    throw new HttpError(400, tr('Skills must be a list of names.', 'Навыки должны быть списком имён.'));
  }
  if (skills.length > LIMITS.skillsPerAgent) {
    throw new HttpError(400, tr(`No more than ${LIMITS.skillsPerAgent} skills per agent.`, `Не больше ${LIMITS.skillsPerAgent} навыков у одного агента.`));
  }
  const unknown = skills.find((s) => !skillNames.has(s));
  if (unknown) throw new HttpError(400, tr(`Skill “${unknown}” not found.`, `Навык «${unknown}» не найден.`));
}

function checkSkillBody(body: Json): void {
  assertName(body.name, tr('skill', 'навыка'));
  requireText(body, 'description', tr('Description', 'Описание'), LIMITS.description);
  requireText(body, 'body', tr('Skill text', 'Текст навыка'), LIMITS.skillBody);
}

/** Runs of each agent in the last 30 days: shadow-mode runs count too (`applied` is about the routing, not the run). */
async function agentStats() {
  const entries = await loadLedger(30);
  const stats = new Map<string, { uses: number; lastUsedAt: string | null }>();
  for (const e of entries) {
    if (e.kind !== 'subagent' || typeof e.agent !== 'string') continue;
    const s = stats.get(e.agent) ?? { uses: 0, lastUsedAt: null };
    s.uses++;
    if (!s.lastUsedAt || e.ts > s.lastUsedAt) s.lastUsedAt = e.ts;
    stats.set(e.agent, s);
  }
  return stats;
}

/** Agents with their runs: a merged agent's runs count for the one it was merged into too. Merged ones last. */
async function listAgents() {
  const [agents, stats] = await Promise.all([readAgents(), agentStats()]);
  const byName = new Map(agents.map((a) => [a.name, a]));
  const target = (name: string): string => {
    let agent = byName.get(name);
    for (let hops = 0; agent?.mergedInto !== undefined && hops < 8; hops++) agent = byName.get(agent.mergedInto) ?? agent;
    return agent?.name ?? name;
  };
  const folded = new Map<string, { uses: number; lastUsedAt: string | null }>();
  for (const [name, s] of stats) {
    for (const key of new Set([name, target(name)])) {
      const f = folded.get(key) ?? { uses: 0, lastUsedAt: null };
      f.uses += s.uses;
      if (s.lastUsedAt && (!f.lastUsedAt || s.lastUsedAt > f.lastUsedAt)) f.lastUsedAt = s.lastUsedAt;
      folded.set(key, f);
    }
  }
  return agents
    .map((agent) => ({ ...agent, stats: folded.get(agent.name) ?? { uses: 0, lastUsedAt: null } }))
    .sort((a, b) => Number(a.mergedInto !== undefined) - Number(b.mergedInto !== undefined));
}

async function listSkills() {
  const [skills, agents] = await Promise.all([readSkills(), readAgents()]);
  return skills.map((skill) => ({
    ...skill,
    usedBy: agents.filter((a) => a.skills.includes(skill.name)).map((a) => a.name),
  }));
}

// `checkAgentBody` / `checkSkillBody` passed `body.name` through NAME_RE as a
// string; String() below is the same conversion RegExp#test made.

async function createAgent(body: Json): Promise<AgentRecord> {
  const skills = new Set((await readSkills()).map((s) => s.name));
  checkAgentBody(body, skills);
  if (await exists(agentFile(String(body.name)))) throw new HttpError(409, tr(`Agent “${body.name}” already exists.`, `Агент «${body.name}» уже существует.`));
  const now = nowIso();
  const agent = sanitizeAgent(
    { ...body, origin: body.origin === 'auto' ? 'auto' : 'manual', createdAt: now, updatedAt: now },
    now,
  );
  if (!agent) throw new HttpError(400, tr('The agent failed validation.', 'Агент не прошёл проверку.'));
  await writeJson(agentFile(agent.name), agent);
  return agent;
}

async function updateAgent(name: string, body: Json): Promise<AgentRecord> {
  const existing = await readOne(agentFile(name), sanitizeAgent);
  if (!existing) throw new HttpError(404, tr(`Agent “${name}” not found.`, `Агент «${name}» не найден.`));
  const merged: Json = { ...existing, ...body };
  if (typeof body.name !== 'string') merged.name = name;
  // Turned back on by hand: no longer merged into another or retired by the mod.
  if (body.enabled === true) {
    delete merged.mergedInto;
    delete merged.retiredAt;
  }
  const skills = new Set((await readSkills()).map((s) => s.name));
  checkAgentBody(merged, skills);
  const now = nowIso();
  const agent = sanitizeAgent({ ...merged, createdAt: existing.createdAt, updatedAt: now }, now);
  if (!agent) throw new HttpError(400, tr('The agent failed validation.', 'Агент не прошёл проверку.'));
  if (agent.name !== name) {
    if (await exists(agentFile(agent.name))) throw new HttpError(409, tr(`Agent “${agent.name}” already exists.`, `Агент «${agent.name}» уже существует.`));
    await writeJson(agentFile(agent.name), agent);
    await fs.rm(agentFile(name), { force: true });
  } else {
    await writeJson(agentFile(name), agent);
  }
  return agent;
}

async function createSkill(body: Json): Promise<SkillRecord> {
  checkSkillBody(body);
  if (await exists(skillFile(String(body.name)))) throw new HttpError(409, tr(`Skill “${body.name}” already exists.`, `Навык «${body.name}» уже существует.`));
  const now = nowIso();
  const skill = sanitizeSkill(
    { ...body, origin: body.origin === 'auto' ? 'auto' : 'manual', createdAt: now, updatedAt: now },
    now,
  );
  if (!skill) throw new HttpError(400, tr('The skill failed validation.', 'Навык не прошёл проверку.'));
  await writeJson(skillFile(skill.name), skill);
  return skill;
}

/** Rewrites the `skills` lists of agents: `rename(name)` returns the new name or undefined to drop it. */
async function rewriteAgentSkills(rename: (name: string) => string | undefined): Promise<void> {
  const now = nowIso();
  for (const agent of await readAgents()) {
    const next = agent.skills.map(rename).filter((s) => s !== undefined);
    if (next.length !== agent.skills.length || next.some((s, i) => s !== agent.skills[i])) {
      await writeJson(agentFile(agent.name), { ...agent, skills: next, updatedAt: now });
    }
  }
}

async function updateSkill(name: string, body: Json): Promise<SkillRecord> {
  const existing = await readOne(skillFile(name), sanitizeSkill);
  if (!existing) throw new HttpError(404, tr(`Skill “${name}” not found.`, `Навык «${name}» не найден.`));
  const merged: Json = { ...existing, ...body };
  if (typeof body.name !== 'string') merged.name = name;
  checkSkillBody(merged);
  const now = nowIso();
  const skill = sanitizeSkill({ ...merged, createdAt: existing.createdAt, updatedAt: now }, now);
  if (!skill) throw new HttpError(400, tr('The skill failed validation.', 'Навык не прошёл проверку.'));
  if (skill.name !== name) {
    if (await exists(skillFile(skill.name))) throw new HttpError(409, tr(`Skill “${skill.name}” already exists.`, `Навык «${skill.name}» уже существует.`));
    await writeJson(skillFile(skill.name), skill);
    await rewriteAgentSkills((s) => (s === name ? skill.name : s));
    await fs.rm(skillFile(name), { force: true });
  } else {
    await writeJson(skillFile(name), skill);
  }
  return skill;
}

async function deleteSkill(name: string): Promise<void> {
  if (!(await exists(skillFile(name)))) throw new HttpError(404, tr(`Skill “${name}” not found.`, `Навык «${name}» не найден.`));
  await rewriteAgentSkills((s) => (s === name ? undefined : s));
  await fs.rm(skillFile(name), { force: true });
}

// ---------------------------------------------------------------- drafts --

const draftFile = (id: string) => path.join(DATA, 'drafts', `${id}.json`);

function assertDraftId(id: string): void {
  if (!DRAFT_ID_RE.test(id)) throw new HttpError(400, tr('Invalid draft id.', 'Недопустимый id черновика.'));
}

async function createDraft(body: Json): Promise<DraftRecord> {
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (description.length < 10 || description.length > 2000) {
    throw new HttpError(400, tr('The description must be 10 to 2000 characters long.', 'Описание должно быть длиной от 10 до 2000 символов.'));
  }
  const now = nowIso();
  const draft: DraftRecord = {
    id: `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    status: 'pending',
    request: { description },
    createdAt: now,
    updatedAt: now,
  };
  await writeJson(draftFile(draft.id), draft);
  return draft;
}

/** A draft file as stored (the mod fills `result`), without the mod's `worker` field. */
async function readDraft(id: string): Promise<Json> {
  assertDraftId(id);
  const draft = await readJson(draftFile(id));
  if (!isObject(draft)) throw new HttpError(404, tr('Draft not found.', 'Черновик не найден.'));
  const { worker: _worker, ...rest } = draft;
  return rest;
}

async function acceptDraft(id: string, body: Json): Promise<{ agent: AgentRecord; skills: SkillRecord[] }> {
  const draft = await readDraft(id);
  const result = draft.result;
  if (draft.status !== 'done' || !isObject(result)) {
    throw new HttpError(409, tr('The draft is not ready yet (status is not “done”).', 'Черновик ещё не готов (статус не «done»).'));
  }
  const rawAgent = body.agent ?? result.agent;
  const rawSkills = body.skills ?? result.skills ?? [];
  if (!isObject(rawAgent) || !isArray(rawSkills)) throw new HttpError(400, tr('Invalid format of the agent or skills.', 'Неверный формат агента или навыков.'));

  const now = nowIso();
  const existingSkills = new Set((await readSkills()).map((s) => s.name));
  const takenSkills = new Set(existingSkills);
  const renamed = new Map<unknown, string>();
  const skills: SkillRecord[] = [];
  for (const raw of rawSkills) {
    if (!isObject(raw)) throw new HttpError(400, tr('Invalid skill format.', 'Неверный формат навыка.'));
    const name = uniqueName(typeof raw.name === 'string' ? raw.name : '', takenSkills);
    const skill = sanitizeSkill({ ...raw, name, origin: 'manual', createdAt: now, updatedAt: now }, now);
    if (!skill) throw new HttpError(400, tr(`Skill “${raw.name}” failed validation (description and text are required).`, `Навык «${raw.name}» не прошёл проверку (описание и текст обязательны).`));
    takenSkills.add(name);
    if (name !== raw.name) renamed.set(raw.name, name);
    skills.push(skill);
  }

  const agentSkills = (isArray(rawAgent.skills) ? rawAgent.skills : [])
    .map((s) => renamed.get(s) ?? s)
    .filter((s): s is string => typeof s === 'string' && takenSkills.has(s));
  const takenAgents = new Set((await readAgents()).map((a) => a.name));
  const name = uniqueName(typeof rawAgent.name === 'string' ? rawAgent.name : '', takenAgents);
  const agent = sanitizeAgent(
    { ...rawAgent, name, skills: [...new Set(agentSkills)], origin: 'manual', createdAt: now, updatedAt: now },
    now,
  );
  if (!agent) throw new HttpError(400, tr('The agent failed validation (description and prompt are required).', 'Агент не прошёл проверку (описание и промпт обязательны).'));

  for (const skill of skills) await writeJson(skillFile(skill.name), skill);
  await writeJson(agentFile(agent.name), agent);
  await fs.rm(draftFile(id), { force: true });
  return { agent, skills };
}

// ----------------------------------------------------------------- merge --

const mergeFile = () => path.join(DATA, 'merge.json');

/** The last merge request as stored (the mod fills `result`), without the mod's `worker` field. */
async function readMerge(): Promise<Json | null> {
  const request = await readJson(mergeFile());
  if (!isObject(request)) return null;
  const { worker: _worker, ...rest } = request;
  return rest;
}

/** Asks the mod (in any running session) to fold near-copy agents together; one request at a time. */
async function requestMerge(): Promise<Json> {
  const current = await readMerge();
  if (current && (current.status === 'pending' || current.status === 'working')) return current;
  const now = nowIso();
  const request: MergeRequest = { status: 'pending', createdAt: now, updatedAt: now };
  await writeJson(mergeFile(), request);
  return request;
}

// -------------------------------------------------------------- projects --

// Project pages: discovery, scans, command records, describe requests (ui/lib/projects.ts).
const projectsOff = (): string => tr('The projects dashboard is turned off (projects.enabled).', 'Пульт проектов выключен (projects.enabled).');
const projects = createProjects({
  data: DATA,
  home: HOME,
  loadConfig,
  loadLedger,
  computeStats,
  readJson,
  writeJson,
  withLock,
  HttpError,
});

// ------------------------------------------------------------------- API --

async function readBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HttpError(413, tr('The request body is larger than 256 KB.', 'Тело запроса больше 256 КБ.'));
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isObject(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new HttpError(400, tr('The request body must be a JSON object.', 'Тело запроса должно быть JSON-объектом.'));
  }
}

function send(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function guard(req: IncomingMessage): void {
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) throw new HttpError(403, tr('Invalid Host header.', 'Недопустимый заголовок Host.'));
  if (req.method === 'GET' || req.method === 'HEAD') return;
  if (req.headers['x-jev-governor'] !== '1') throw new HttpError(403, tr('The X-Jev-Governor: 1 header is required.', 'Нужен заголовок X-Jev-Governor: 1.'));
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) {
    throw new HttpError(403, tr('Invalid Origin.', 'Недопустимый Origin.'));
  }
}

async function api(req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams): Promise<void> {
  const method = req.method ?? 'GET';
  const [, resource, id, action] = segments;
  const notFound = (): never => {
    throw new HttpError(404, tr('Not found.', 'Не найдено.'));
  };
  const mutate = <T>(fn: () => T | Promise<T>) => withLock(fn);

  if (resource === 'health' && method === 'GET' && !id) {
    return send(res, 200, { ok: true, data: DATA, version: VERSION });
  }

  if (resource === 'config') {
    if (!id && method === 'GET') return send(res, 200, await loadConfig());
    if (!id && method === 'PUT') {
      const patch = await readBody(req);
      return send(
        res,
        200,
        await mutate(async () => saveConfig(mergePatch(await loadConfig(), patch))),
      );
    }
    if (id === 'reset' && !action && method === 'POST') {
      return send(res, 200, await mutate(() => saveConfig(DEFAULT_CONFIG)));
    }
    return notFound();
  }

  if (resource === 'key' && !id) {
    if (method === 'GET') return send(res, 200, await keyStatus());
    if (method === 'PUT') {
      const body = await readBody(req);
      return send(res, 200, await mutate(() => saveKey(body.key)));
    }
    return notFound();
  }

  if (resource === 'jev' && id === 'test' && !action && method === 'POST') {
    await readBody(req);
    return send(res, 200, await testJev());
  }

  if (resource === 'agents') {
    if (!id) {
      if (method === 'GET') return send(res, 200, await listAgents());
      if (method === 'POST') {
        const body = await readBody(req);
        return send(res, 201, await mutate(() => createAgent(body)));
      }
      return notFound();
    }
    assertName(id, tr('agent', 'агента'));
    if (action) return notFound();
    if (method === 'PUT') {
      const body = await readBody(req);
      return send(res, 200, await mutate(() => updateAgent(id, body)));
    }
    if (method === 'DELETE') {
      await mutate(async () => {
        if (!(await exists(agentFile(id)))) throw new HttpError(404, tr(`Agent “${id}” not found.`, `Агент «${id}» не найден.`));
        await fs.rm(agentFile(id), { force: true });
      });
      return send(res, 200, { ok: true });
    }
    return notFound();
  }

  if (resource === 'skills') {
    if (!id) {
      if (method === 'GET') return send(res, 200, await listSkills());
      if (method === 'POST') {
        const body = await readBody(req);
        return send(res, 201, await mutate(() => createSkill(body)));
      }
      return notFound();
    }
    assertName(id, tr('skill', 'навыка'));
    if (action) return notFound();
    if (method === 'PUT') {
      const body = await readBody(req);
      return send(res, 200, await mutate(() => updateSkill(id, body)));
    }
    if (method === 'DELETE') {
      await mutate(() => deleteSkill(id));
      return send(res, 200, { ok: true });
    }
    return notFound();
  }

  if (resource === 'merge' && !id) {
    if (method === 'GET') return send(res, 200, (await readMerge()) ?? { status: 'none' });
    if (method === 'POST') return send(res, 202, await mutate(() => requestMerge()));
    return notFound();
  }

  if (resource === 'drafts') {
    if (!id && method === 'POST') {
      const body = await readBody(req);
      return send(res, 201, await mutate(() => createDraft(body)));
    }
    if (id && !action && method === 'GET') return send(res, 200, await readDraft(id));
    if (id && !action && method === 'DELETE') {
      assertDraftId(id);
      await mutate(() => fs.rm(draftFile(id), { force: true }));
      return send(res, 200, { ok: true });
    }
    if (id && action === 'accept' && method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, await mutate(() => acceptDraft(id, body)));
    }
    return notFound();
  }

  if (resource === 'projects') {
    // Off, the server leaves projects alone too: no scans, no ledger reads, no descriptions.
    if (!(await loadConfig()).projects.enabled) throw new HttpError(404, projectsOff());
    const { status, body } = await projects.handle({
      method,
      segments: segments.slice(2),
      query,
      readBody: () => readBody(req),
    });
    return send(res, status, body);
  }

  if (resource === 'ledger' && !id && method === 'GET') {
    const days = clampInt(query.get('days'), 7, 1, 90);
    const limit = clampInt(query.get('limit'), 300, 1, 2000);
    const kind = query.get('kind');
    if (kind && !LEDGER_KINDS.has(kind)) throw new HttpError(400, tr('Unknown kind.', 'Неизвестный kind.'));
    const all = (await loadLedger(days)).filter((e) => !kind || e.kind === kind);
    return send(res, 200, all.slice(0, limit), { 'x-total-count': String(all.length) });
  }

  if (resource === 'stats' && !id && method === 'GET') {
    const days = clampInt(query.get('days'), 7, 1, 90);
    const [entries, config] = await Promise.all([loadLedger(days), loadConfig()]);
    const stats = computeStats(entries, days);
    const { exact, estimated, jev, net, actual, withoutMod } = computeSavings(entries.filter(pricable), savingsOptions(config)).totals;
    return send(res, 200, { ...stats, savings: { exact, estimated, jev, net, actual, withoutMod } });
  }

  if (resource === 'savings' && !id && method === 'GET') {
    const days = clampInt(query.get('days'), 7, 1, 90);
    return send(res, 200, await savingsReport(days, query.get('project') || undefined));
  }

  return notFound();
}

// ---------------------------------------------------------------- static --

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const PAGE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const missingDist = (): string => `<!doctype html><html lang="${tr('en', 'ru')}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>jev-governor</title>
<style>body{font:16px system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1rem;line-height:1.5;color:#18181b}
code{background:#f4f4f5;padding:.15em .4em;border-radius:4px}@media(prefers-color-scheme:dark){body{background:#09090b;color:#f4f4f5}code{background:#27272a}}</style>
<h1>jev-governor</h1>
<p>${tr('The interface has not been built yet. Run in the project root:', 'Интерфейс ещё не собран. Выполните в корне проекта:')}</p>
<p><code>npm run ui:install &amp;&amp; npm run ui:build</code></p>
<p>${tr('Then reload the page. The API is already running:', 'Затем обновите страницу. API уже работает:')} <code>/api/health</code>.</p></html>`;

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, tr('Method not supported.', 'Метод не поддерживается.'));
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, tr('Invalid path.', 'Неверный путь.'));
  }
  const wanted = path.normalize(path.join(DIST, decoded));
  let file = wanted.startsWith(DIST + path.sep) ? wanted : path.join(DIST, 'index.html');
  let content: Buffer;
  try {
    const st = await fs.stat(file);
    if (st.isDirectory()) file = path.join(file, 'index.html');
    content = await fs.readFile(file);
  } catch {
    // SPA fallback (only for paths that are not files)
    if (path.extname(decoded)) throw new HttpError(404, tr('Not found.', 'Не найдено.'));
    file = path.join(DIST, 'index.html');
    try {
      content = await fs.readFile(file);
    } catch {
      res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store', ...PAGE_HEADERS });
      return res.end(req.method === 'HEAD' ? undefined : missingDist());
    }
  }
  const ext = path.extname(file).toLowerCase();
  const immutable = file.startsWith(path.join(DIST, 'assets') + path.sep);
  res.writeHead(200, {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...PAGE_HEADERS,
  });
  res.end(req.method === 'HEAD' ? undefined : content);
}

// ---------------------------------------------------------------- server --

async function handle(req: IncomingMessage, res: ServerResponse) {
  await withLang(parseLang(req.headers['x-jev-lang']), () => handleRequest(req, res));
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  try {
    guard(req);
    const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
    const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
    if (rawPath === '/api' || rawPath.startsWith('/api/')) {
      // Split the raw path: `..` must reach the name check, not be normalized away.
      const segments = rawPath.split('/').filter(Boolean).map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          throw new HttpError(400, tr('Invalid path.', 'Неверный путь.'));
        }
      });
      await api(req, res, segments, query);
    } else {
      await serveStatic(req, res, new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    }
  } catch (error) {
    if (res.headersSent) return res.end();
    if (error instanceof HttpError) return send(res, error.status, { error: error.message });
    process.stderr.write(`jev-governor UI: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    send(res, 500, { error: tr('Internal server error.', 'Внутренняя ошибка сервера.') });
  }
}

async function healthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return isObject(body) && body.ok === true;
  } catch {
    return false;
  }
}

async function detach(): Promise<void> {
  if (await healthy(PORT)) {
    process.stdout.write(`${URL_LINE}\n`);
    return;
  }
  await fs.mkdir(DATA, { recursive: true });
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--port', String(PORT), '--data', DATA], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  child.on('error', () => {
    exited = true;
  });
  child.unref();
  if (child.pid === undefined) fail(tr('could not start the server.', 'не удалось запустить сервер.'));
  await writeAtomic(path.join(DATA, 'ui.pid'), `${child.pid}\n`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !exited) {
    if (await healthy(PORT)) {
      process.stdout.write(`${URL_LINE}\n`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (exited) await fs.rm(path.join(DATA, 'ui.pid'), { force: true });
  fail(
    tr(
      `the server did not respond on port ${PORT} (busy with another process?). Start it manually: node ${fileURLToPath(import.meta.url)} --port ${PORT}`,
      `сервер не ответил на порту ${PORT} (занят другим процессом?). Запустите вручную: node ${fileURLToPath(import.meta.url)} --port ${PORT}`,
    ),
  );
}

function serve(): void {
  const server = http.createServer((req, res) => void handle(req, res));
  server.on('error', (error: NodeJS.ErrnoException) => {
    fail(error.code === 'EADDRINUSE' ? tr(`port ${PORT} is in use.`, `порт ${PORT} занят.`) : error.message);
  });
  server.listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`${URL_LINE}\ndata: ${DATA}\n`);
  });
  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (args.detach) await detach();
else serve();
