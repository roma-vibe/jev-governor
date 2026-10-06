#!/usr/bin/env node
// Monitoring report of jev-governor (docs/MONITORING.md): reads the mod's
// ledger and Claude Code's own transcripts for a window of days and prints a
// Markdown report with the numbers worth checking after a change and what
// they suggest.
//
//   node scripts/monitor.mjs [--days 1] [--since 2026-10-05[T09:13] | --since v0.2.2] [--data DIR] [--projects DIR] [--help]
//
// Read only. Node runs the TypeScript savings module directly.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { computeSavings, familyOf, PRICES } from '../hooks/lib/savings.ts';
import { resolveConfig } from '../hooks/lib/config.ts';
import { pricable } from '../ui/lib/pricable.ts';

// ------------------------------------------------------------------- args --

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const USAGE = `node scripts/monitor.mjs [--days 1] [--since 2026-10-05[T09:13] | --since v0.2.2] [--data DIR] [--projects DIR]

Отчёт мониторинга jev-governor (docs/MONITORING.md) в Markdown. Только читает.
  --days N         окно: последние N дней (по умолчанию 1)
  --since ДАТА     всё с этой даты, ГГГГ-ММ-ДД или ГГГГ-ММ-ДДTЧЧ:ММ по местному времени (вместо --days)
  --since ВЕРСИЯ   всё с того, как версия попала в main (v0.2.2 или 0.2.2; по git этой папки)
  --data DIR       папка мода (по умолчанию $JEV_GOVERNOR_HOME или ~/.claude/jev-governor)
  --projects DIR   транскрипты Claude Code (по умолчанию ~/.claude/projects)
`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(USAGE);
  process.exit(0);
}

/**
 * `YYYY-MM-DD` as local midnight, or `YYYY-MM-DDTHH:MM` local time; NaN for anything else,
 * 2026-02-30 included (Date.parse rolls it over).
 */
function parseDay(text) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(text ?? '');
  if (!m) return Number.NaN;
  const t = Date.parse(`${m[1]}T${m[2] ?? '00'}:${m[3] ?? '00'}:00`);
  const d = new Date(t);
  const back = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (back !== m[1]) return Number.NaN;
  return m[2] !== undefined && (d.getHours() !== Number(m[2]) || d.getMinutes() !== Number(m[3])) ? Number.NaN : t;
}

/**
 * When a version went live: the merge into main whose subject ends with `(X.Y.Z)` (the live mod
 * loads from main), else the `vX.Y.Z` tag, else the "Version X.Y.Z" commit. NaN when git knows none.
 */
function versionTime(text) {
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(text ?? '');
  if (!m) return Number.NaN;
  const repo = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const git = (...args) => {
    try {
      return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  const escaped = m[1].replace(/\./g, '\\.');
  const when =
    git('log', 'main', '--merges', '-1', '--format=%cI', `--grep=(${escaped})$`) ||
    git('log', '-1', '--format=%cI', `v${m[1]}`) ||
    git('log', 'main', '-1', '--format=%cI', `--grep=^Version ${escaped}$`);
  return when ? Date.parse(when) : Number.NaN;
}

const HOME = os.homedir();
const DATA = path.resolve(arg('data', process.env.JEV_GOVERNOR_HOME || path.join(HOME, '.claude', 'jev-governor')));
const PROJECTS = path.resolve(arg('projects', path.join(HOME, '.claude', 'projects')));
const DAYS = Math.max(1, Number(arg('days', '1')) || 1);
const SINCE = arg('since', undefined);
const SINCE_AT = SINCE === undefined ? Number.NaN : /^v?\d+\.\d+\.\d+$/.test(SINCE) ? versionTime(SINCE) : parseDay(SINCE);
if (process.argv.includes('--since') && !Number.isFinite(SINCE_AT)) {
  process.stderr.write(
    `monitor: --since ждёт дату ГГГГ-ММ-ДД[TЧЧ:ММ] или версию из git (v0.2.2), получено: ${SINCE === undefined ? 'ничего' : `«${SINCE}»`} (см. --help)\n`,
  );
  process.exit(2);
}
/** Median context per step before the mod (transcripts 2026-09-17…10-05). */
const BASELINE_MEDIAN = 430_000;
/** hooks/register.ts LEDGER_MAX_LINES: a file at it has lost its oldest lines. */
const LEDGER_MAX_LINES = 5000;

const now = Date.now();
const from = SINCE ? SINCE_AT : now - DAYS * 86_400_000;
const inWindow = (ts) => {
  const t = Date.parse(ts);
  return Number.isFinite(t) && t >= from && t <= now;
};

// ---------------------------------------------------------------- helpers --

const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');
const k = (n) => (n === undefined || !Number.isFinite(n) ? '—' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
const usd = (n) => {
  const v = n ?? 0;
  if (!Number.isFinite(v)) return '—';
  return `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(Math.abs(v) < 1 ? 3 : 2)}`;
};
const median = (xs) => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs, q) => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const count = (xs, f) => xs.filter(f).length;
const group = (xs, key) => {
  const m = new Map();
  for (const x of xs) {
    const g = key(x);
    m.set(g, [...(m.get(g) ?? []), x]);
  }
  return m;
};

async function readLines(file) {
  try {
    return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

// ----------------------------------------------------------------- ledger --

/** Every ledger entry in the window (one without a session is skipped), and every session that has a ledger file on any day. */
async function loadLedger() {
  const root = path.join(DATA, 'ledger');
  let days = [];
  try {
    days = (await fs.readdir(root)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  } catch {
    // no ledger yet
  }
  const entries = [];
  const sessions = new Set();
  const files = [];
  const firstDay = new Date(from).toISOString().slice(0, 10);
  for (const day of days) {
    let names = [];
    try {
      names = await fs.readdir(path.join(root, day));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      sessions.add(name.slice(0, -6));
      if (day < firstDay) continue;
      const lines = await readLines(path.join(root, day, name));
      files.push({ day, session: name.slice(0, -6), lines: lines.length });
      for (const line of lines) {
        const e = parse(line);
        if (e && typeof e.ts === 'string' && typeof e.session === 'string' && inWindow(e.ts)) entries.push(e);
      }
    }
  }
  entries.sort((a, b) => a.ts.localeCompare(b.ts));
  return { entries, sessions, files };
}

// ------------------------------------------------------------ transcripts --

/** A subagent request that wrote this much to the cache after a pause past its 5-minute TTL rebuilt it. */
const REBUILD_TOKENS = 40_000;
const SUBAGENT_TTL_MS = 5 * 60_000;

/**
 * The model requests of one transcript in the window, one per message id.
 * Claude Code writes a message in chunks and only the first carries the
 * input-side usage (later ones repeat it as zeros), so the largest figures
 * per id are kept; taking the last chunk read most steps as 0 tokens.
 */
function stepsOf(lines, { sidechain }) {
  const steps = new Map();
  let cwd;
  const prompts = [];
  for (const line of lines) {
    const e = parse(line);
    if (!e || (!sidechain && e.isSidechain)) continue;
    cwd ??= e.cwd;
    if (!inWindow(e.timestamp ?? '')) continue;
    if (e.type === 'assistant' && e.message?.usage && e.message.id) {
      const u = e.message.usage;
      const input = u.input_tokens ?? 0;
      const cacheRead = u.cache_read_input_tokens ?? 0;
      const cacheWrite = u.cache_creation_input_tokens ?? 0;
      const write1h = u.cache_creation?.ephemeral_1h_input_tokens;
      const context = input + cacheRead + cacheWrite;
      const had = steps.get(e.message.id);
      if (!had) {
        steps.set(e.message.id, { ts: e.timestamp, context, input, cacheRead, cacheWrite, write1h, output: u.output_tokens ?? 0, model: e.message.model });
      } else {
        if (context > had.context) Object.assign(had, { context, input, cacheRead, cacheWrite, write1h });
        had.output = Math.max(had.output, u.output_tokens ?? 0);
      }
    } else if (!sidechain && e.type === 'user' && e.promptId && typeof e.message?.content === 'string') {
      prompts.push({ ts: e.timestamp, text: e.message.content.slice(0, 80) });
    }
  }
  return { steps: [...steps.values()].sort((a, b) => a.ts.localeCompare(b.ts)), cwd, prompts };
}

/** API-equivalent dollars of one request at list prices (`subagent`: cache writes at the 5-minute price unless the transcript says 1h). */
function stepCost(step, subagent) {
  const p = PRICES[familyOf(step.model ?? '') ?? 'opus'];
  const w1h = step.write1h ?? (subagent ? 0 : step.cacheWrite);
  const w5m = Math.max(0, step.cacheWrite - w1h);
  return (step.input * p.input + step.output * p.output + step.cacheRead * p.cacheRead + w1h * p.write1h + w5m * p.write5m) / 1e6;
}

/** Requests of a subagent that rewrote its cache after a pause past the TTL, and what those writes cost. */
function rebuildsOf(steps) {
  const out = [];
  for (let i = 1; i < steps.length; i++) {
    const gap = Date.parse(steps[i].ts) - Date.parse(steps[i - 1].ts);
    if (gap > SUBAGENT_TTL_MS && steps[i].cacheWrite >= REBUILD_TOKENS) {
      const p = PRICES[familyOf(steps[i].model ?? '') ?? 'opus'];
      out.push({ gap, tokens: steps[i].cacheWrite, cost: (steps[i].cacheWrite * p.write5m) / 1e6 });
    }
  }
  return out;
}

/**
 * Main-conversation sessions active in the window: their steps' context
 * sizes (deduplicated by message id), their human prompts, and their
 * subagents' steps (from <session>/subagents/).
 */
async function loadTranscripts() {
  const sessions = [];
  let dirs = [];
  try {
    dirs = await fs.readdir(PROJECTS);
  } catch {
    return sessions;
  }
  for (const dir of dirs) {
    let names = [];
    try {
      names = await fs.readdir(path.join(PROJECTS, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.jsonl$/.test(name)) continue;
      const file = path.join(PROJECTS, dir, name);
      const stat = await fs.stat(file).catch(() => undefined);
      if (!stat || stat.mtimeMs < from) continue;
      const { steps, cwd, prompts } = stepsOf(await readLines(file), { sidechain: false });
      const subagents = [];
      const subDir = path.join(PROJECTS, dir, name.slice(0, -6), 'subagents');
      let subNames = [];
      try {
        subNames = (await fs.readdir(subDir)).filter((n) => n.endsWith('.jsonl'));
      } catch {
        // no subagents
      }
      for (const subName of subNames) {
        const subFile = path.join(subDir, subName);
        const subStat = await fs.stat(subFile).catch(() => undefined);
        if (!subStat || subStat.mtimeMs < from) continue;
        const sub = stepsOf(await readLines(subFile), { sidechain: true });
        if (sub.steps.length > 0) subagents.push({ id: subName.slice(0, -6), steps: sub.steps });
      }
      if (prompts.length === 0 && steps.length === 0 && subagents.length === 0) continue;
      sessions.push({ id: name.slice(0, -6), project: path.basename(cwd ?? dir), cwd, steps, prompts, subagents });
    }
  }
  return sessions;
}

// ----------------------------------------------------------------- report --

/**
 * The auto-compaction window (`window` entries, one per session start): whether Claude Code took
 * the one the mod set (`source` env and `tokens` equal to it), and how the compactions in
 * subagents went, applied or fallen back to the summary.
 */
function windowLine(windows, compacts) {
  if (windows.length === 0) return 'Окно автосжатия: записей нет (мод до 0.2.6 или окно выключено).';
  const mod = windows.filter((e) => e.autoWindow?.by === 'mod');
  const took = mod.filter((e) => e.autoWindow?.source === 'env' && e.autoWindow?.tokens === e.autoWindow?.wanted).length;
  const user = windows.filter((e) => e.autoWindow?.by === 'user').length;
  const subs = compacts.filter((e) => (e.agentId !== undefined || e.scope === 'subagent') && e.compaction?.trigger !== 'precompute');
  const subOk = subs.filter((e) => !e.compaction?.fallback).length;
  return [
    `Окно автосжатия: сессий ${windows.length}, окно мода ${mod.length} (${mod[0]?.autoWindow?.wanted ? k(mod[0].autoWindow.wanted) : '—'}), Claude Code его принял ${took}/${mod.length}`,
    user ? `, задано вами в окружении ${user}` : '',
    `; сжатий в субагентах ${subs.length} (через Jev ${subOk}, пересказом ${subs.length - subOk}).`,
  ].join('');
}

function section(title, lines) {
  return [`## ${title}`, '', ...lines.filter((l) => l !== undefined && l !== null), ''].join('\n');
}

function familyName(model) {
  return familyOf(model) ?? (model ? String(model) : '?');
}

async function main() {
  const [{ entries, sessions: ledgerSessions, files }, transcripts] = await Promise.all([loadLedger(), loadTranscripts()]);
  let config;
  try {
    config = resolveConfig(JSON.parse(await fs.readFile(path.join(DATA, 'config.json'), 'utf8')));
  } catch {
    config = resolveConfig(undefined);
  }
  const by = (kind) => entries.filter((e) => e.kind === kind);
  const out = [];
  const advice = [];
  /** A version resolved through git is shown with the time it went live. */
  const byVersion = SINCE !== undefined && /^v?\d+\.\d+\.\d+$/.test(SINCE);
  const live = new Date(from);
  const two = (n) => String(n).padStart(2, '0');
  const liveText = `${live.getFullYear()}-${two(live.getMonth() + 1)}-${two(live.getDate())} ${two(live.getHours())}:${two(live.getMinutes())}`;
  const windowText = SINCE ? `с ${SINCE}${byVersion ? ` (${liveText})` : ''}` : `за ${DAYS} ${DAYS === 1 ? 'день' : 'дн.'}`;
  out.push(`# Мониторинг jev-governor ${windowText}`, '', `Журнал: ${DATA}/ledger · транскрипты: ${PROJECTS} · записей журнала: ${entries.length}`, '');

  // 1. Was the mod loaded in every session?
  const humanSessions = transcripts.filter((s) => s.prompts.length > 0);
  const missing = humanSessions.filter((s) => !ledgerSessions.has(s.id));
  out.push(
    section('1. Мод загружен в каждой сессии', [
      `Сессий с вашими запросами: ${humanSessions.length}; без журнала мода: **${missing.length}**.`,
      ...missing.slice(0, 15).map((s) => `- ${s.project} · ${s.id} · с ${s.prompts[0]?.ts.slice(0, 16)} · «${s.prompts[0]?.text ?? ''}»`),
      missing.length > 15 ? `- … и ещё ${missing.length - 15}` : undefined,
    ]),
  );
  if (missing.length > 0) {
    advice.push(
      `В ${missing.length} сессиях мод не загрузился (или они начались до его подключения). Проверьте \`npm run validate\` и строку \`jev ▸\` в новом чате.`,
    );
  }

  // 2. Context per step.
  const steps = transcripts.flatMap((s) => s.steps.map((st) => st.context)).filter((n) => n > 0);
  const med = median(steps);
  const subRuns = transcripts.flatMap((s) => s.subagents);
  const subSteps = subRuns.flatMap((r) => r.steps.map((st) => st.context)).filter((n) => n > 0);
  out.push(
    section('2. Контекст на шаг (по транскриптам)', [
      `Основной диалог: шагов ${steps.length}; медиана **${k(med)}** (до мода ${k(BASELINE_MEDIAN)}); p90 ${k(quantile(steps, 0.9))}; больше 200k: ${pct(count(steps, (n) => n > 200_000), steps.length)}.`,
      subSteps.length
        ? `Субагенты: ${subRuns.length}, шагов ${subSteps.length}; медиана ${k(median(subSteps))}; p90 ${k(quantile(subSteps, 0.9))}; больше 200k: ${pct(count(subSteps, (n) => n > 200_000), subSteps.length)}.`
        : 'Субагентов не было.',
    ]),
  );

  // 3. Compaction.
  // Main chat, installed: subagent compactions (agentId/scope, logged since the review) and
  // precomputes (they install nothing; the compaction that comes is logged on its own) are apart.
  const allCompacts = by('compact');
  const precomputes = allCompacts.filter((e) => e.compaction?.trigger === 'precompute').length;
  const subCompacts = allCompacts.filter((e) => e.agentId !== undefined || e.scope === 'subagent').length;
  const compacts = allCompacts.filter((e) => e.agentId === undefined && e.scope !== 'subagent' && e.compaction?.trigger !== 'precompute');
  const applied = compacts.filter((e) => e.compaction && !e.compaction.fallback && !String(e.text ?? '').startsWith('skipped'));
  const skipped = compacts.filter((e) => String(e.text ?? '').startsWith('skipped'));
  const fallback = compacts.filter((e) => e.compaction?.fallback && !String(e.text ?? '').startsWith('skipped'));
  const reads = by('output-read');
  const pruneReads = reads.filter((e) => String(e.text ?? '').includes('/pruned/'));
  // Claude Code's own saved outputs: read back by the model, not removed by the mod, so not in the ratio.
  const toolResultReads = reads.filter((e) => String(e.text ?? '').includes('/tool-results/'));
  const reruns = by('rerun-after-prune');
  const back = pruneReads.length + reruns.length;
  const ratios = applied.map((e) => e.compaction.ratio).filter(Number.isFinite);
  const noArchive = applied.filter((e) => e.compaction.archived === undefined);
  const idleErrors = by('error').filter((e) => /idle compaction|compact on return|auto-compact/.test(e.error ?? ''));
  const viaCommand = applied.filter((e) => e.compaction.via === 'command').length;
  const overCap = applied.filter((e) => e.compaction.ratio > config.compaction.maxPruneRatio + 1e-9).length;
  out.push(
    section('3. Сжатие', [
      `Применено ${applied.length} (по порогу ${count(applied, (e) => e.compaction.reason === 'threshold')}, после паузы ${count(applied, (e) => e.compaction.reason === 'return')}, окном посреди хода ${count(applied, (e) => e.compaction.reason === 'window')}, по запросу Claude Code ${count(applied, (e) => (e.compaction.reason ?? 'engine') === 'engine')}); пропущено ${skipped.length}; откат на пересказ ${fallback.length}.`,
      windowLine(by('window'), allCompacts),
      `Средняя доля убранного ${ratios.length ? pct(ratios.reduce((a, b) => a + b, 0), ratios.length) : '—'}, максимум ${ratios.length ? pct(Math.max(...ratios), 1) : '—'}; выше предела ${pct(config.compaction.maxPruneRatio, 1)}: ${overCap}; возвращено пределом вызовов: ${applied.reduce((a, e) => a + (e.compaction.restored ?? 0), 0)}.`,
      `Без записи \`archived\`: ${noArchive.length}${noArchive.length ? ` (сессии: ${[...new Set(noArchive.map((e) => e.session.slice(0, 8)))].join(', ')})` : ''}.`,
      `Обращений к убранному: чтений архива ${pruneReads.length}, повторных запусков ${reruns.length} → **${applied.length ? (back / applied.length).toFixed(2) : '—'} на сжатие**${toolResultReads.length ? `; чтений сохранённых выводов Claude Code (\`tool-results/\`, не в счёте): ${toolResultReads.length}` : ''}.`,
      `Запуск нашего сжатия через \`/compact\` (приложение): ${viaCommand}; ошибок запуска по таймеру или порогу: ${idleErrors.length}.`,
      `Не в счёте выше: сжатий в субагентах ${subCompacts}, заранее посчитанных (precompute) ${precomputes}.`,
      ...reruns.slice(-5).map((e) => `- повтор: ${e.text}`),
    ]),
  );
  if (applied.length > 0) {
    const perCompaction = back / applied.length;
    if (perCompaction > 1) {
      advice.push(
        `Модели нужно убранное ${perCompaction.toFixed(1)} раза на сжатие: Jev убирает нужное. Поднимите compaction.keepThreshold (сейчас ${config.compaction.keepThreshold}) на 0.05–0.1.`,
      );
    } else if (perCompaction < 0.1 && applied.length >= 5) {
      advice.push(`К убранному почти не обращаются (${perCompaction.toFixed(2)} на сжатие): можно ослабить compaction.maxPruneRatio или сжимать раньше.`);
    }
  }
  if (noArchive.length > 0) advice.push(`У ${noArchive.length} сжатий нет записи archived: проверьте, на каком коде мода работали эти чаты.`);
  if (idleErrors.length > 0 && viaCommand === 0) advice.push('Сжатие по таймеру падало, а запасной путь через /compact ни разу не сработал: проверить в приложении.');

  // 4. Routing.
  const turns = by('turn').filter((e) => e.applied !== false);
  const models = group(turns, (e) => familyName(e.model));
  const efforts = group(turns.filter((e) => e.effort), (e) => e.effort);
  const switches = turns.filter((e) => e.switched);
  const warm = switches.filter((e) => (e.reasons ?? []).some((r) => /warm cache|budget critical/.test(r)));
  const overrides = by('override');
  const usage = by('usage').filter((e) => e.applied !== false);
  const escalated = usage.filter((e) => (e.escalated ?? 0) > 0);
  const subagents = by('subagent').filter((e) => e.applied !== false);
  const jevDown = (e) => (e.reasons ?? []).some((r) => r.startsWith('Jev unavailable'));
  const fallbacks = [...turns, ...subagents].filter((e) => (e.reasons ?? []).some((r) => r.includes('(fallback)')));
  const retries = by('error').filter((e) => String(e.error ?? '').endsWith('(retrying)'));
  out.push(
    section('4. Роутинг', [
      `Jev недоступен: ходов ${count(turns, jevDown)}, субагентов ${count(subagents, jevDown)}; из них на запасном effort ${fallbacks.length}; повторных запросов к Jev ${retries.length}.`,
      `Ходов: ${turns.length} (без Jev: ${count(turns, (e) => e.local)}); модели: ${[...models].map(([m, xs]) => `${m} ${pct(xs.length, turns.length)}`).join(', ') || '—'}.`,
      `Effort: ${[...efforts].sort().map(([e, xs]) => `${e} ${xs.length}`).join(', ') || '—'}.`,
      `Смен модели: ${switches.length}, из них на тёплом кэше: ${warm.length}; ваших /model и смен effort (override): ${overrides.length}; эскалаций после ошибок инструментов: ${escalated.length}.`,
      `Субагентов: ${subagents.length} в журнале из ${subRuns.length} в транскриптах (${[...group(subagents, (e) => familyName(e.model))].map(([m, xs]) => `${m} ${xs.length}`).join(', ') || '—'}).`,
      ...overrides.slice(-5).map((e) => `- override: ${(e.reasons ?? []).join('; ')} · «${e.text ?? ''}»`),
    ]),
  );

  // 5. Router errors: what a correction followed.
  const bySession = group(turns, (e) => e.session);
  const after = { sonnet: [0, 0], opus: [0, 0], low: [0, 0], high: [0, 0] };
  for (const list of bySession.values()) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const corrected = (list[i].correction ?? 0) >= 0.5 ? 1 : 0;
      const fam = familyOf(prev.model);
      if (fam === 'sonnet' || fam === 'opus') {
        after[fam][0] += corrected;
        after[fam][1]++;
      }
      if (prev.effort) {
        const bucket = ['low', 'medium'].includes(prev.effort) ? 'low' : 'high';
        after[bucket][0] += corrected;
        after[bucket][1]++;
      }
    }
  }
  const rate = ([n, d]) => `${pct(n, d)} (${n}/${d})`;
  out.push(
    section('5. Ошибки роутера', [
      `Поправки пользователя (correction ≥ 0.5) после хода на Sonnet: ${rate(after.sonnet)}; на Opus: ${rate(after.opus)}.`,
      `После effort low/medium: ${rate(after.low)}; после high и выше: ${rate(after.high)}.`,
      `Эскалаций effort после ошибок инструментов: ${escalated.length}; обращений к убранному сжатием: ${back}.`,
    ]),
  );
  if (after.sonnet[1] >= 10 && after.opus[1] >= 10 && after.sonnet[0] / after.sonnet[1] > (after.opus[0] / after.opus[1]) * 1.5 + 0.03) {
    advice.push(`После Sonnet поправляют заметно чаще, чем после Opus: поднимите router.downgradeAt (сейчас ${config.router.downgradeAt}) или снизьте upgradeAt.`);
  }
  if (after.low[1] >= 10 && after.high[1] >= 10 && after.low[0] / after.low[1] > (after.high[0] / after.high[1]) * 1.5 + 0.03) {
    advice.push(`После low/medium поправляют заметно чаще: поднимите router.effortConfidenceAt или minEffort.`);
  }

  // 6. Handoff and hints.
  const handoffs = by('handoff');
  const created = handoffs.filter((e) => e.handoff?.action === 'create');
  const hints = by('hint');
  const followed = hints.filter((h) => created.some((c) => c.session === h.session && c.ts > h.ts && Date.parse(c.ts) - Date.parse(h.ts) < 30 * 60_000));
  out.push(
    section('6. Перенос в новый чат и подсказки', [
      `Капсул: ${created.length} (с брифом ${count(created, (e) => e.handoff.brief)}, через /jevg fresh ${count(created, (e) => e.handoff.fresh)}); подключений: ${count(handoffs, (e) => e.handoff?.action === 'attach')}; очисток чата: ${count(handoffs, (e) => e.handoff?.action === 'clear')}; /jevg fresh отменён: ${count(handoffs, (e) => e.handoff?.action === 'cancel')}.`,
      ...created.slice(-5).map((e) => `- ${e.handoff.id}: ${k(e.handoff.tokens)} вместо ${k(e.handoff.sourceTokens)}${(e.reasons ?? []).length ? ` · ${e.reasons.join('; ')}` : ''}`),
      `Подсказок: ${hints.length} (при остывшем кэше ${count(hints, (e) => (e.reasons ?? []).includes('cache cold'))}); за подсказкой в течение 30 минут последовала капсула: ${followed.length}.`,
    ]),
  );

  // 7. Spend.
  const report = computeSavings(entries.filter(pricable), {
    effortFactor: config.savings.effortFactor,
    defaultBase: { model: config.savings.defaultBaseModel, effort: config.savings.defaultBaseEffort },
  });
  const t = report.totals;
  const costSum = t.cost.input + t.cost.output + t.cost.cacheRead + t.cost.cacheWrite;
  const lastRate = [...entries].reverse().find((e) => e.rate && (e.rate.fiveHour !== undefined || e.rate.sevenDay !== undefined))?.rate;
  // Everything the transcripts show, routed or not: the ledger's sum misses turns Jev could not
  // decide and subagents whose spawn went unrouted.
  const mainCost = transcripts.reduce((a, s) => a + s.steps.reduce((b, st) => b + stepCost(st, false), 0), 0);
  const subCost = subRuns.reduce((a, r) => a + r.steps.reduce((b, st) => b + stepCost(st, true), 0), 0);
  const rebuilds = subRuns.flatMap((r) => rebuildsOf(r.steps));
  const rebuildCost = rebuilds.reduce((a, r) => a + r.cost, 0);
  out.push(
    section('7. Расход (эквивалент API)', [
      `Все шаги по транскриптам: ${usd(mainCost + subCost)} — основной диалог ${usd(mainCost)}, субагенты ${usd(subCost)}.`,
      `Пересборок кэша субагентов после паузы больше 5 минут: ${rebuilds.length}${rebuilds.length ? `, ${k(rebuilds.reduce((a, r) => a + r.tokens, 0))} токенов, ≈ ${usd(rebuildCost)}` : ''}.`,
      `Ходы под управлением мода: ${usd(t.actual)} — чтение кэша ${pct(t.cost.cacheRead, costSum)}, запись ${pct(t.cost.cacheWrite, costSum)}, вывод ${pct(t.cost.output, costSum)}, вход ${pct(t.cost.input, costSum)}.`,
      `Сэкономлено: точно ${usd(t.exact)}, по оценке ≈ ${usd(t.estimated)}; Jev ${usd(t.jev)}; чистая выгода ${usd(t.net)}${t.assumedTurns ? `; из неё от допущения «без мода ${report.events.find((e) => e.assumed)?.assumed}» ${usd(t.assumed)} (${t.assumedTurns} ходов)` : ''}.`,
      `По источникам: ${Object.entries(t.bySource).map(([s, v]) => `${s} ${usd(v)}`).join(', ')}.`,
      lastRate ? `Лимиты на последнюю запись: 5h ${lastRate.fiveHour ?? '—'}%, 7d ${lastRate.sevenDay ?? '—'}%.` : undefined,
    ]),
  );

  if (rebuildCost > 0.05 * (mainCost + subCost)) {
    advice.push(`Пересборки кэша субагентов стоили ${usd(rebuildCost)} (${pct(rebuildCost, mainCost + subCost)} всего): субагенты ждут дольше 5 минут за вызов. Проверьте, что agents.waitHint включён и что в задачах субагентов есть <cache-note>.`);
  }
  if (fallbacks.length > 0 || retries.length > 0) {
    advice.push(`Jev отказывал: ${retries.length} повторов, ${fallbacks.length} решений на запасном effort. Если это часто, поднять jev.timeoutMs или проверить OpenRouter.`);
  }

  // 8. Baseline fields.
  const turnUsage = [...turns, ...usage.filter((e) => e.scope !== 'subagent')];
  const noBase = turnUsage.filter((e) => e.baseModel === undefined || e.baseEffort === undefined);
  out.push(
    section('8. База «без мода» в записях turn и usage', [
      `Записей: ${turnUsage.length}; без baseModel или baseEffort: **${noBase.length}**${noBase.length ? ` (сессии: ${[...new Set(noBase.map((e) => e.session.slice(0, 8)))].join(', ')})` : ''}.`,
    ]),
  );
  if (noBase.length > 0) {
    advice.push(`${noBase.length} записей без базы «без мода»: экономия для них считается от допущения. Если среди них есть сессии на новом коде — смотреть usageBase и turn.step в hooks/register.ts.`);
  }

  // 9. Trim, secrets, agents, ledger, errors.
  const trims = by('trim');
  const trimmed = trims.filter((e) => e.applied !== false && e.trim);
  const fromFile = trimmed.filter((e) => e.trim.persisted);
  const redacted = by('redacted');
  const agents = group(subagents.filter((e) => e.agent), (e) => e.agent);
  const atCap = files.filter((f) => f.lines >= LEDGER_MAX_LINES);
  const errors = group(by('error'), (e) => String(e.error ?? '').split(':')[0]);
  out.push(
    section('9. Прочее', [
      // From a file Claude Code saved, the trimmed output (up to 16k) replaces a 2KB preview: it adds
      // characters on purpose (the failures, not the head), so it is counted apart, not as removed.
      `Обрезка: ${trimmed.length - fromFile.length} выводов, убрано ${k(trimmed.filter((e) => !e.trim.persisted).reduce((a, e) => a + Math.max(0, e.trim.charsBefore - e.trim.charsAfter), 0))} символов, экономия ${usd(t.bySource.trim)}; из сохранённых Claude Code файлов: ${fromFile.length} (вместо превью 2KB добавлено ${k(fromFile.reduce((a, e) => a + Math.max(0, e.trim.charsAfter - e.trim.charsBefore), 0))} символов, из ${k(fromFile.reduce((a, e) => a + (e.trim.fullChars ?? 0), 0))} полного вывода).`,
      `Секреты: ${redacted.length} запросов к Jev с заменами, всего заменено ${redacted.reduce((a, e) => a + (e.count ?? 0), 0)}.`,
      `Специалисты: ${[...agents].sort((a, b) => b[1].length - a[1].length).map(([a, xs]) => `${a} ${xs.length}`).join(', ') || 'не вызывались'}.`,
      `Журнал: файлов ${files.length}, самый длинный ${Math.max(0, ...files.map((f) => f.lines))} строк; на пределе ${LEDGER_MAX_LINES}: ${atCap.length}.`,
      `Ошибки: ${[...errors].map(([kind, xs]) => `${kind} ${xs.length}`).join(', ') || 'нет'}.`,
    ]),
  );
  if (atCap.length > 0) advice.push(`${atCap.length} файлов журнала упёрлись в ${LEDGER_MAX_LINES} строк и потеряли начало дня: пора делить журнал по часам.`);

  out.push(section('Выводы', advice.length ? advice.map((a) => `- ${a}`) : ['- Тревожных сигналов нет.']));
  process.stdout.write(`${out.join('\n')}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
