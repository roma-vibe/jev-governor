// Project pages of the settings UI: which projects Claude Code knows, which
// commands they have (discovered from their own files, learned from the ledger,
// added by hand) and what the page may do with them.
//
// Projects are READ-ONLY for this module: it lists directories and reads small
// files (never symlinks that leave the project, never files over 256 KB), and
// runs `git` (read-only) there. Everything it writes lives in the data
// directory: projects/<id>.json and describe/<id>-<ts>.json (docs/DATA.md).
// "Run" executes only a command stored in the project's record, in
// Terminal.app, through osascript (no shell on our side).

import { execFile } from 'node:child_process';
import { promises as fs, type Dirent, type Stats } from 'node:fs';
import path from 'node:path';

import { tr } from './i18n.ts';

import {
  COMMAND_GROUPS,
  cargoCommands,
  commandId,
  composeCommands,
  dedupe,
  detectPackageManager,
  expandMembers,
  extractDocCommands,
  groupOf,
  looksSecret,
  parseJustfile,
  parseLaunchJson,
  parseMakefile,
  parsePackageJson,
  parsePyproject,
  readCargoToml,
  type CargoCrate,
  type CommandGroup,
  type CommandSource,
  type DiscoveredCommand,
} from '../../hooks/lib/commands.ts';
import type { DescribeRequest, GovernorConfig, LedgerEntry, ProjectCommandRecord, ProjectRecord } from '../../hooks/lib/types.ts';

const DAY_MS = 86_400_000;
const MAX_FILE_BYTES = 256 * 1024;
const TRANSCRIPT_SLICE = 64 * 1024;
const DISCOVERY_TTL_MS = 30_000;
const GIT_TIMEOUT_MS = 3000;
const MAX_COMMAND_CHARS = 300;
const MAX_DIR_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_DESCRIBE_ITEMS = 60;
const MAX_SUBDIRS = 300;
const STALE_WORKING_MS = 10 * 60_000;
const STALE_PENDING_MS = DAY_MS;
const LEDGER_DAYS = 30;
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.venv', 'vendor']);
const LOCK_FILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'];
const SOURCES: ReadonlySet<unknown> = new Set<CommandSource>([
  'package.json',
  'Makefile',
  'Cargo.toml',
  'justfile',
  'pyproject',
  'compose',
  'launch.json',
  'docs',
  'claude',
  'manual',
]);
const PROJECT_ID_RE = /^[a-z0-9-]{3,80}$/;
const COMMAND_ID_RE = /^[0-9a-f]{8}$/;
/** Control characters except TAB: a newline in a command would start a second one. */
const CONTROL_RE = /[\u0000-\u0008\u000a-\u001f\u007f]/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isArray = (v: unknown): v is unknown[] => Array.isArray(v);
const isGroup = (v: unknown): v is CommandGroup => (COMMAND_GROUPS as readonly unknown[]).includes(v);
const nowIso = () => new Date().toISOString();

/** A project Claude Code has transcripts for (~/.claude/projects/<encoded path>/). */
export type DiscoveredProject = {
  id: string;
  name: string;
  path: string;
  /** The folder is still there. */
  exists: boolean;
  isWorktree: boolean;
  sessions: number;
  lastActivity: string;
};

/** A command a scan found, with its id and, when Claude ran it, how that went. */
export type FoundCommand = DiscoveredCommand & { id: string; uses?: number; successes?: number; lastUsedAt?: string };

/** A command Claude ran in a project, from the ledger's `command` entries. */
export type LearnedCommand = {
  id: string;
  command: string;
  dir?: string;
  uses: number;
  successes: number;
  lastUsedAt: string | undefined;
};

/** The part of the server's ledger statistics a project page shows. */
export type LedgerStats = {
  turns: { count: number; shadow: number; byModel: { sonnet: number; opus: number; other: number } };
  subagents: { count: number; shadow: number };
  jev: { cost: number };
};

/** What the server hands the projects service. */
export type ProjectsDeps = {
  data: string;
  home: string;
  /** Claude Code's transcripts folder; ~/.claude/projects by default. */
  claudeProjectsDir?: string;
  loadConfig: () => Promise<GovernorConfig>;
  loadLedger: (days: number) => Promise<LedgerEntry[]>;
  computeStats: (entries: LedgerEntry[], days: number) => LedgerStats;
  readJson: (file: string) => Promise<unknown>;
  writeJson: (file: string, value: unknown) => Promise<void>;
  withLock: <T>(fn: () => T | Promise<T>) => Promise<T>;
  HttpError: new (status: number, message: string) => Error;
};

/** A describe/<id>.json file as read back: written by us, then updated by the mod. */
type StoredRequest = { file: string; request: Record<string, unknown> };

// ------------------------------------------------------- pure helpers --

/** Lowercase [a-z0-9-] part of a project id. */
export function slugOf(name: string): string {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'project';
}

export const projectIdOf = (name: string, projectPath: string): string => `${slugOf(name)}-${commandId(projectPath)}`;

/** Single-quoted POSIX shell word: `'` becomes `'\''`. */
export function shellQuote(text: string): string {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

/** The inside of an AppleScript string literal. */
export function appleScriptEscape(text: string): string {
  return String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** `cd <project>/<dir> && <command>`: what the terminal types. */
export function terminalLine(projectPath: string, dir: string | undefined, command: string): string {
  const target = dir ? path.posix.join(projectPath, dir) : projectPath;
  return `cd ${shellQuote(target)} && ${command}`;
}

/** The osascript `-e` arguments that open a Terminal.app window running `line`. */
export function terminalScript(line: string): string[] {
  return ['tell application "Terminal" to activate', `tell application "Terminal" to do script "${appleScriptEscape(line)}"`];
}

/** Claude Code names a project's folder after its path: every non-alphanumeric becomes `-`. */
export const encodeProjectDir = (p: string): string => p.replace(/[^a-zA-Z0-9]/g, '-');

export const isWorktreePath = (p: string): boolean => p.includes('/.claude/worktrees/') || p.includes('/worktrees/');

/** A relative subfolder without `..`, a leading `/` or `~`; undefined for the project root. Throws a message string. */
export function normalizeDir(dir: unknown): string | undefined {
  if (dir === undefined || dir === null) return undefined;
  if (typeof dir !== 'string') throw tr('The folder must be a string.', 'Папка должна быть строкой.');
  const text = dir.trim();
  if (!text) return undefined;
  if (text.length > MAX_DIR_CHARS) throw tr(`The folder is longer than ${MAX_DIR_CHARS} characters.`, `Папка длиннее ${MAX_DIR_CHARS} символов.`);
  if (CONTROL_RE.test(text)) throw tr('The folder contains invalid characters.', 'В папке недопустимые символы.');
  if (text.startsWith('/') || text.startsWith('~') || /^[a-zA-Z]:/.test(text)) throw tr('The folder is relative to the project: no leading “/” and no “~”.', 'Папка задаётся относительно проекта: без «/» в начале и без «~».');
  const parts = text.split('/').filter((s) => s !== '' && s !== '.');
  if (parts.includes('..')) throw tr('“..” is not allowed in the folder.', 'В папке нельзя использовать «..».');
  return parts.length > 0 ? parts.join('/') : undefined;
}

/** A command a person may store: one line, at most 300 characters, nothing that looks like a secret. Throws a message string. */
export function checkCommand(command: unknown): string {
  if (typeof command !== 'string') throw tr('The command must be a string.', 'Команда должна быть строкой.');
  const text = command.trim();
  if (!text) throw tr('The command cannot be empty.', 'Команда не может быть пустой.');
  if (text.length > MAX_COMMAND_CHARS) throw tr(`The command is longer than ${MAX_COMMAND_CHARS} characters.`, `Команда длиннее ${MAX_COMMAND_CHARS} символов.`);
  if (CONTROL_RE.test(text)) throw tr('The command must be a single line.', 'Команда должна быть в одну строку.');
  if (looksSecret(text)) throw tr('The command looks like a secret (token, password, key): such commands are not saved.', 'Команда похожа на секрет (токен, пароль, ключ): такие команды не сохраняются.');
  return text;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Stored commands + what the scan found now -> the new list. Manual commands
 * and user edits survive; auto commands follow the scan; those no longer found
 * are kept as `stale` only while pinned or manually described.
 */
export function mergeCommands(existing: readonly ProjectCommandRecord[], found: readonly FoundCommand[], now: string): ProjectCommandRecord[] {
  const known = new Map(existing.map((c) => [c.id, c]));
  const out: ProjectCommandRecord[] = [];
  const used = new Set<string>();
  const stats = (f: FoundCommand | undefined) => ({ uses: f?.uses, successes: f?.successes, lastUsedAt: f?.lastUsedAt });

  const settle = (old: ProjectCommandRecord, next: ProjectCommandRecord): ProjectCommandRecord => {
    const { updatedAt: _a, ...a } = old;
    const { updatedAt: _b, ...b } = next;
    return sameJson(a, b) ? old : { ...next, updatedAt: now };
  };

  for (const f of found) {
    const old = known.get(f.id);
    used.add(f.id);
    if (!old) {
      out.push({
        id: f.id,
        command: f.command,
        ...(f.dir ? { dir: f.dir } : {}),
        group: f.group,
        source: f.source,
        ...(f.sourceDetail ? { sourceDetail: f.sourceDetail } : {}),
        ...(f.hint ? { hint: f.hint } : {}),
        ...stats(f),
        createdAt: now,
        updatedAt: now,
      });
    } else if (old.source === 'manual') {
      out.push(settle(old, { ...old, ...stats(f) }));
    } else {
      out.push(
        settle(old, {
          ...old,
          group: old.groupEdited ? old.group : f.group,
          source: f.source,
          sourceDetail: f.sourceDetail,
          hint: f.hint,
          stale: undefined,
          ...stats(f),
        }),
      );
    }
  }
  for (const old of existing) {
    if (used.has(old.id)) continue;
    if (old.source === 'manual') out.push(settle(old, { ...old, ...stats(undefined) }));
    else if (old.pinned || old.favorite || old.descriptionSource === 'manual') out.push(settle(old, { ...old, stale: true, ...stats(undefined) }));
  }
  // JSON drops the undefined fields; keep the in-memory value identical to what is stored.
  return JSON.parse(JSON.stringify(out)) as ProjectCommandRecord[];
}

/** Commands that still need a description in `lang`, pinned first, as the describe request items. */
export function describeItems(commands: readonly ProjectCommandRecord[], lang: DescribeRequest['lang']): DescribeRequest['items'] {
  return commands
    .filter((c) => c.descriptionSource !== 'manual' && !c.hidden && !c.stale && (!c.description || c.descriptionLang !== lang))
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
    .slice(0, MAX_DESCRIBE_ITEMS)
    .map((c) => ({
      id: c.id,
      command: c.command,
      ...(c.dir ? { dir: c.dir } : {}),
      ...(c.hint ? { hint: c.hint.slice(0, 200) } : {}),
      source: c.source,
    }));
}

/** Puts the `results` of a finished describe request into the commands (never over a manual description). */
export function applyDescriptions(commands: ProjectCommandRecord[], request: Record<string, unknown>, now: string): boolean {
  let changed = false;
  const lang = request.lang === 'en' ? 'en' : 'ru';
  const results = isObject(request.results) ? request.results : {};
  for (const c of commands) {
    const text = results[c.id];
    if (typeof text !== 'string' || !text.trim() || c.descriptionSource === 'manual') continue;
    c.description = text.trim().slice(0, 140);
    c.descriptionLang = lang;
    c.descriptionSource = 'auto';
    c.updatedAt = now;
    changed = true;
  }
  return changed;
}

/** Ledger `command` entries of a project -> Map(commandId -> {command, dir, uses, successes, lastUsedAt}). */
export function learnCommands(entries: readonly LedgerEntry[], projectPath: string): Map<string, LearnedCommand> {
  const out = new Map<string, LearnedCommand>();
  const prefix = `${projectPath}/`;
  for (const e of entries) {
    if (e.kind !== 'command' || typeof e.command !== 'string' || typeof e.cwd !== 'string') continue;
    let sub: string;
    if (e.cwd === projectPath) sub = '';
    else if (e.cwd.startsWith(prefix)) {
      sub = e.cwd.slice(prefix.length);
      // A worktree inside the project is a project of its own.
      if (sub.startsWith('.claude/worktrees/') || sub.startsWith('worktrees/')) continue;
    } else continue;
    let command: string;
    let dir: string | undefined;
    try {
      command = checkCommand(e.command);
      dir = normalizeDir([sub, typeof e.dir === 'string' ? e.dir : ''].filter(Boolean).join('/'));
    } catch {
      continue;
    }
    const id = commandId(command, dir);
    const item: LearnedCommand = out.get(id) ?? { id, command, ...(dir ? { dir } : {}), uses: 0, successes: 0, lastUsedAt: undefined };
    item.uses++;
    if (e.success === true) item.successes++;
    if (typeof e.ts === 'string' && (!item.lastUsedAt || e.ts > item.lastUsedAt)) item.lastUsedAt = e.ts;
    out.set(id, item);
  }
  return out;
}

/** Session id -> working directory, from the ledger entries that carry a `cwd` (`command` entries). */
export function sessionCwds(entries: readonly LedgerEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) if (typeof e.cwd === 'string' && typeof e.session === 'string') out.set(e.session, e.cwd);
  return out;
}

/**
 * The ledger entries of one project: those whose session ran in the project's
 * folder, or (when the session's folder is not known) whose `project` is the
 * folder's name. `mapping` is where the session -> folder map is read from
 * (default `entries`; a wider slice finds sessions that started earlier).
 */
export function entriesOfProject(
  project: { name: string; path: string },
  entries: readonly LedgerEntry[],
  mapping: readonly LedgerEntry[] = entries,
): LedgerEntry[] {
  const sessionCwd = sessionCwds(mapping);
  return entries.filter((e) => {
    const cwd = typeof e.cwd === 'string' ? e.cwd : sessionCwd.get(e.session);
    return cwd !== undefined ? cwd === project.path : e.project === project.name;
  });
}

// ------------------------------------------------------ read-only project fs --

/** Reads inside one project; anything that resolves outside it (a symlink) is invisible. */
class ProjectFs {
  root: string;
  realRoot: string;

  constructor(root: string, realRoot: string) {
    this.root = root;
    this.realRoot = realRoot;
  }

  static async open(root: string): Promise<ProjectFs> {
    return new ProjectFs(root, await fs.realpath(root));
  }

  async resolve(rel: string): Promise<{ real: string; st: Stats } | undefined> {
    try {
      const real = await fs.realpath(path.join(this.root, rel));
      if (real !== this.realRoot && !real.startsWith(this.realRoot + path.sep)) return undefined;
      return { real, st: await fs.stat(real) };
    } catch {
      return undefined;
    }
  }

  async isFile(rel: string): Promise<boolean> {
    return (await this.resolve(rel))?.st.isFile() === true;
  }

  async isDir(rel: string): Promise<boolean> {
    return (await this.resolve(rel))?.st.isDirectory() === true;
  }

  async readText(rel: string): Promise<string | undefined> {
    const r = await this.resolve(rel);
    if (!r || !r.st.isFile() || r.st.size > MAX_FILE_BYTES) return undefined;
    try {
      return await fs.readFile(r.real, 'utf8');
    } catch {
      return undefined;
    }
  }

  async list(rel = ''): Promise<Dirent[]> {
    const r = await this.resolve(rel);
    if (!r || !r.st.isDirectory()) return [];
    try {
      return await fs.readdir(r.real, { withFileTypes: true });
    } catch {
      return [];
    }
  }
}

const join = (...parts: string[]) => parts.filter(Boolean).join('/');

/** One immediate subfolder: its package.json and Cargo.toml, and its file names when it has a package.json. */
type SubScan = { sub: string; pkg: string | undefined; cargo: string | undefined; subNames: string[] };

/** Commands the project's own files say it has: root and immediate subfolders only. */
export async function scanProjectFiles(projectPath: string): Promise<DiscoveredCommand[]> {
  const pf = await ProjectFs.open(projectPath);
  const entries = await pf.list('');
  const names = entries.map((e) => e.name);
  const found: DiscoveredCommand[] = [];
  const rootPm = detectPackageManager(names);

  if (names.includes('package.json')) {
    const text = await pf.readText('package.json');
    if (text) found.push(...parsePackageJson(text, rootPm));
  }

  const subdirs = entries
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
    .slice(0, MAX_SUBDIRS);

  const subScans = await Promise.all(
    subdirs.map(async (sub): Promise<SubScan> => {
      const [pkg, cargo] = await Promise.all([pf.readText(`${sub}/package.json`), pf.readText(`${sub}/Cargo.toml`)]);
      let subNames: string[] = [];
      if (pkg) subNames = (await pf.list(sub)).map((e) => e.name);
      return { sub, pkg, cargo, subNames };
    }),
  );
  for (const { sub, pkg, subNames } of subScans) {
    if (!pkg) continue;
    const pm = subNames.some((n) => LOCK_FILES.includes(n)) ? detectPackageManager(subNames) : rootPm;
    found.push(...parsePackageJson(pkg, pm, sub));
  }

  const makefile = ['Makefile', 'makefile', 'GNUmakefile'].find((n) => names.includes(n));
  if (makefile) {
    const text = await pf.readText(makefile);
    if (text) found.push(...parseMakefile(text));
  }

  found.push(...(await scanCargo(pf, names, subScans)));

  const justfile = ['justfile', 'Justfile'].find((n) => names.includes(n));
  if (justfile) {
    const text = await pf.readText(justfile);
    if (text) found.push(...parseJustfile(text));
  }

  if (names.includes('pyproject.toml')) {
    const text = await pf.readText('pyproject.toml');
    if (text) found.push(...parsePyproject(text, names));
  }

  for (const file of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    if (names.includes(file)) found.push(...composeCommands(file));
  }

  const launch = await pf.readText('.claude/launch.json');
  if (launch) found.push(...parseLaunchJson(launch));

  for (const doc of ['README.md', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md']) {
    const actual = names.find((n) => n.toLowerCase() === doc.toLowerCase());
    if (!actual) continue;
    const text = await pf.readText(actual);
    if (text) found.push(...extractDocCommands(text, actual));
  }
  const development = await pf.readText('docs/DEVELOPMENT.md');
  if (development) found.push(...extractDocCommands(development, 'docs/DEVELOPMENT.md'));

  return dedupe(found.map(cleanFound).filter((c) => c !== undefined));
}

async function crateAt(pf: ProjectFs, rel: string, text: string): Promise<CargoCrate | undefined> {
  const info = readCargoToml(text);
  if (!info.name) return undefined;
  const hasBin = info.hasBinSection || (await pf.isFile(join(rel, 'src/main.rs'))) || (await pf.isDir(join(rel, 'src/bin')));
  return { name: info.name, hasBin };
}

async function scanCargo(pf: ProjectFs, names: readonly string[], subScans: readonly SubScan[]): Promise<DiscoveredCommand[]> {
  if (names.includes('Cargo.toml')) {
    const text = await pf.readText('Cargo.toml');
    if (!text) return [];
    const root = readCargoToml(text);
    if (root.members.length === 0) {
      const crate = await crateAt(pf, '', text);
      return crate ? cargoCommands([crate]) : [];
    }
    const lists = new Map<string, string[]>();
    for (const member of root.members) {
      if (!member.endsWith('/*')) continue;
      const base = member.slice(0, -2);
      lists.set(
        base,
        (await pf.list(base))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort(),
      );
    }
    const dirs = expandMembers(root.members, (base) => lists.get(base) ?? []);
    const crates: CargoCrate[] = [];
    const rootCrate = await crateAt(pf, '', text);
    if (rootCrate) crates.push(rootCrate);
    for (const dir of dirs.slice(0, 100)) {
      const member = await pf.readText(`${dir}/Cargo.toml`);
      const crate = member ? await crateAt(pf, dir, member) : undefined;
      if (crate) crates.push(crate);
    }
    return cargoCommands(crates, { workspace: true });
  }
  // No root manifest (a Tauri app with src-tauri/Cargo.toml, say): single packages one level down.
  const out: DiscoveredCommand[] = [];
  for (const { sub, cargo } of subScans) {
    if (!cargo) continue;
    const crate = await crateAt(pf, sub, cargo);
    if (crate) out.push(...cargoCommands([crate]).map((c) => ({ ...c, dir: sub })));
  }
  return out;
}

/** One discovered command checked for the record: a safe single line, a safe dir, no secret in the hint. */
function cleanFound(c: DiscoveredCommand): DiscoveredCommand | undefined {
  let command: string;
  let dir: string | undefined;
  try {
    command = checkCommand(c.command);
    dir = normalizeDir(c.dir);
  } catch {
    return undefined;
  }
  const hint = typeof c.hint === 'string' ? c.hint.trim().replace(/\s+/g, ' ').slice(0, 300) : '';
  return {
    ...c,
    command,
    dir,
    group: COMMAND_GROUPS.includes(c.group) ? c.group : groupOf(command),
    hint: hint && !looksSecret(hint) ? hint : undefined,
  };
}

// ------------------------------------------------------------- discovery --

async function readSlice(file: string, start: number, length: number): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** `cwd` values in a slice of a transcript: parsed from whole JSON lines, else a regex over the raw text. */
function cwdsIn(text: string, dropFirst: boolean, dropLast: boolean): string[] {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const found: unknown[] = [];
  for (const line of lines) {
    if (!line.includes('"cwd"')) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isObject(value) && typeof value.cwd === 'string') found.push(value.cwd);
    } catch {
      // a cut or malformed line: the regex below may still read it
    }
  }
  if (found.length === 0) {
    for (const m of text.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) {
      try {
        found.push(JSON.parse(`"${m[1]}"`) as unknown);
      } catch {
        // not a string literal
      }
    }
  }
  return found.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p) && !CONTROL_RE.test(p));
}

/** The candidate (or one of its parents) whose encoded form is the transcript folder's name. */
function matchingCwd(dirName: string, candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    let p = candidate;
    while (p && p !== '/') {
      if (encodeProjectDir(p) === dirName) return p;
      p = path.dirname(p);
    }
  }
  return undefined;
}

async function projectPathOf(dirName: string, file: string, size: number): Promise<string | undefined> {
  const head = cwdsIn(await readSlice(file, 0, TRANSCRIPT_SLICE), false, size > TRANSCRIPT_SLICE);
  let match = matchingCwd(dirName, head);
  if (!match && size > TRANSCRIPT_SLICE) {
    const start = Math.max(0, size - TRANSCRIPT_SLICE);
    match = matchingCwd(dirName, cwdsIn(await readSlice(file, start, TRANSCRIPT_SLICE), start > 0, false));
  }
  return match ?? head[0];
}

// ---------------------------------------------------------------- service --

export function createProjects(deps: ProjectsDeps) {
  const { data, home, loadConfig, loadLedger, computeStats, readJson, writeJson, withLock, HttpError } = deps;
  const projectsRoot = deps.claudeProjectsDir ?? path.join(home, '.claude', 'projects');
  const recordDir = path.join(data, 'projects');
  const describeDir = path.join(data, 'describe');
  const recordFile = (id: string) => path.join(recordDir, `${id}.json`);

  let discovered: { at: number; list: DiscoveredProject[] } | undefined;

  async function discover(): Promise<DiscoveredProject[]> {
    if (discovered && Date.now() - discovered.at < DISCOVERY_TTL_MS) return discovered.list;
    let dirs: Dirent[];
    try {
      dirs = await fs.readdir(projectsRoot, { withFileTypes: true });
    } catch {
      dirs = [];
    }
    const byPath = new Map<string, { path: string; sessions: number; lastMs: number }>();
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(projectsRoot, d.name);
      let files: string[];
      try {
        files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      const stats = (
        await Promise.all(
          files.map(async (f) => {
            try {
              const st = await fs.stat(path.join(dir, f));
              return { file: path.join(dir, f), mtimeMs: st.mtimeMs, size: st.size };
            } catch {
              return undefined;
            }
          }),
        )
      )
        .filter((s) => s !== undefined)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      const newest = stats[0];
      if (newest === undefined) continue;
      let projectPath: string | undefined;
      for (const t of stats.slice(0, 3)) {
        try {
          projectPath = await projectPathOf(d.name, t.file, t.size);
        } catch {
          projectPath = undefined;
        }
        if (projectPath) break;
      }
      if (!projectPath || projectPath === home || projectPath === '/') continue;
      projectPath = path.normalize(projectPath).replace(/\/+$/, '') || '/';
      const known = byPath.get(projectPath);
      const lastMs = newest.mtimeMs;
      if (known) {
        known.sessions += stats.length;
        known.lastMs = Math.max(known.lastMs, lastMs);
      } else {
        byPath.set(projectPath, { path: projectPath, sessions: stats.length, lastMs });
      }
    }
    const list = await Promise.all(
      [...byPath.values()].map(async (p): Promise<DiscoveredProject> => {
        const name = path.basename(p.path) || p.path;
        let exists = false;
        try {
          exists = (await fs.stat(p.path)).isDirectory();
        } catch {
          exists = false;
        }
        return {
          id: projectIdOf(name, p.path),
          name,
          path: p.path,
          exists,
          isWorktree: isWorktreePath(p.path),
          sessions: p.sessions,
          lastActivity: new Date(p.lastMs).toISOString(),
        };
      }),
    );
    list.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : a.lastActivity > b.lastActivity ? -1 : 0));
    discovered = { at: Date.now(), list };
    return list;
  }

  async function findProject(id: string): Promise<DiscoveredProject> {
    if (!PROJECT_ID_RE.test(id)) throw new HttpError(400, tr('Invalid project id.', 'Недопустимый id проекта.'));
    const project = (await discover()).find((p) => p.id === id);
    if (!project) throw new HttpError(404, tr('Project not found.', 'Проект не найден.'));
    return project;
  }

  // ---- records

  /** A stored command with its id, text, group, source and timestamps checked; other fields as stored. */
  function sanitizeCommand(raw: unknown, now: string): ProjectCommandRecord | undefined {
    if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.command !== 'string') return undefined;
    const c: Record<string, unknown> = { ...raw };
    c.group = isGroup(raw.group) ? raw.group : 'other';
    if (!SOURCES.has(raw.source)) c.source = 'manual';
    c.createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : now;
    c.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : now;
    return c as ProjectCommandRecord;
  }

  async function loadRecord(project: DiscoveredProject): Promise<ProjectRecord | undefined> {
    const raw = await readJson(recordFile(project.id));
    if (!isObject(raw) || !isArray(raw.commands)) return undefined;
    const now = nowIso();
    return {
      ...raw,
      id: project.id,
      name: project.name,
      path: project.path,
      commands: raw.commands.map((c) => sanitizeCommand(c, now)).filter((c) => c !== undefined),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
    } as ProjectRecord;
  }

  const emptyRecord = (project: DiscoveredProject): ProjectRecord => ({
    id: project.id,
    name: project.name,
    path: project.path,
    commands: [],
    updatedAt: nowIso(),
  });

  async function saveRecord(record: ProjectRecord): Promise<void> {
    record.updatedAt = nowIso();
    await writeJson(recordFile(record.id), record);
  }

  // ---- describe requests

  async function projectRequests(projectId: string): Promise<StoredRequest[]> {
    let names: string[] = [];
    try {
      names = (await fs.readdir(describeDir)).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
    } catch {
      return [];
    }
    const out: StoredRequest[] = [];
    for (const name of names) {
      const file = path.join(describeDir, name);
      const request = await readJson(file);
      if (isObject(request) && isObject(request.project) && request.project.id === projectId) out.push({ file, request });
    }
    return out;
  }

  const ageMs = (request: Record<string, unknown>) => {
    const t = Date.parse(String(request.updatedAt ?? request.createdAt ?? ''));
    return Number.isFinite(t) ? Date.now() - t : 0;
  };

  async function enqueueDescribe(project: DiscoveredProject, record: ProjectRecord, lang: DescribeRequest['lang']): Promise<void> {
    const items = describeItems(record.commands, lang);
    if (items.length === 0) return;
    const now = nowIso();
    const id = `${project.id}-${Date.now()}`;
    const request: DescribeRequest = {
      id,
      status: 'pending',
      lang,
      project: { id: project.id, name: project.name, path: project.path },
      items,
      createdAt: now,
      updatedAt: now,
    };
    await writeJson(path.join(describeDir, `${id}.json`), request);
  }

  type DescribeState = {
    /** `projects.describeWithClaude` is on. */
    enabled: boolean;
    status: 'idle' | 'pending' | 'working' | 'error';
    error?: string;
    pendingCount: number;
  };

  function describeState(requests: readonly StoredRequest[], config: GovernorConfig): DescribeState {
    const live = requests.filter((r) => r.request.status === 'pending' || r.request.status === 'working');
    const failed = requests.find((r) => r.request.status === 'error');
    const pendingCount = live.reduce((n, r) => n + (isArray(r.request.items) ? r.request.items.length : 0), 0);
    const state: DescribeState = { enabled: config.projects.describeWithClaude, status: 'idle', pendingCount };
    if (live.some((r) => r.request.status === 'working')) state.status = 'working';
    else if (live.length > 0) state.status = 'pending';
    else if (failed) {
      const text = typeof failed.request.error === 'string' ? failed.request.error.slice(0, 300) : '';
      state.status = 'error';
      state.error = text && !looksSecret(text) ? text : tr('unknown error', 'неизвестная ошибка');
    }
    return state;
  }

  // ---- stats and git

  function projectStats(project: DiscoveredProject, entries: LedgerEntry[], learned: number) {
    const mine = entriesOfProject(project, entries);
    const s = computeStats(mine, LEDGER_DAYS);
    let lastActivity: string | null = null;
    for (const e of mine) if (!lastActivity || e.ts > lastActivity) lastActivity = e.ts;
    return {
      days: LEDGER_DAYS,
      entries: mine.length,
      sessions: new Set(mine.map((e) => e.session)).size,
      turns: { count: s.turns.count, shadow: s.turns.shadow, sonnet: s.turns.byModel.sonnet, opus: s.turns.byModel.opus, other: s.turns.byModel.other },
      subagents: { count: s.subagents.count, shadow: s.subagents.shadow },
      jevCost: s.jev.cost,
      learnedCommands: learned,
      lastActivity,
    };
  }

  function git(cwd: string, args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(
        'git',
        ['-c', 'core.fsmonitor=false', '--no-optional-locks', ...args],
        { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } },
        (error, stdout) => resolve(error ? null : String(stdout)),
      );
    });
  }

  async function gitInfo(project: DiscoveredProject) {
    if (!project.exists) return null;
    const [branch, status, log] = await Promise.all([
      git(project.path, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(project.path, ['status', '--porcelain']),
      git(project.path, ['log', '-1', '--format=%s%x09%cI%x09%cr']),
    ]);
    if (branch === null && status === null && log === null) return null;
    let lastCommit: { subject: string; at: string | null; ago: string | null } | null = null;
    if (log?.trim()) {
      const [subject, at, ago] = log.trim().split('\t');
      lastCommit = { subject: subject ?? '', at: at ?? null, ago: ago ?? null };
    }
    return {
      branch: branch?.trim() || null,
      changed: status === null ? null : status.split('\n').filter((l) => l.trim()).length,
      lastCommit,
    };
  }

  // ---- sync: merge finished descriptions, maybe rescan

  /** One locked pass over a project: finished describe requests merged, optionally rescanned. */
  function sync(project: DiscoveredProject, { scan }: { scan: boolean }) {
    return withLock(async () => {
      const config = await loadConfig();
      const lang = config.projects.descriptionLanguage;
      let record = await loadRecord(project);
      let dirty = false;
      if (!record) {
        record = emptyRecord(project);
        dirty = project.exists;
      }

      let requests = await projectRequests(project.id);
      // A worker that died mid-request, or a request nobody ever picked up: forget it so a retry can be queued.
      for (const r of requests) {
        const stale =
          (r.request.status === 'working' && ageMs(r.request) > STALE_WORKING_MS) || (r.request.status === 'pending' && ageMs(r.request) > STALE_PENDING_MS);
        if (stale) await fs.rm(r.file, { force: true });
      }
      requests = await projectRequests(project.id);

      const now = nowIso();
      for (const r of requests) {
        if (r.request.status !== 'done') continue;
        if (applyDescriptions(record.commands, r.request, now)) dirty = true;
        await fs.rm(r.file, { force: true });
      }
      if (scan) for (const r of requests) if (r.request.status === 'error') await fs.rm(r.file, { force: true });

      const firstScan = record.scannedAt === undefined && project.exists;
      if ((scan || firstScan) && project.exists) {
        const found = await scanProjectFiles(project.path);
        let ledger: LedgerEntry[] = [];
        let learned = new Map<string, LearnedCommand>();
        if (config.projects.learnFromClaude) {
          ledger = await loadLedger(LEDGER_DAYS);
          learned = learnCommands(ledger, project.path);
        }
        const items: FoundCommand[] = found.map((f) => ({ ...f, id: commandId(f.command, f.dir) }));
        const byId = new Map(items.map((i) => [i.id, i]));
        for (const l of learned.values()) {
          const known = byId.get(l.id);
          if (known) {
            known.uses = l.uses;
            known.successes = l.successes;
            known.lastUsedAt = l.lastUsedAt;
          } else if (l.successes >= config.projects.minSuccesses) {
            items.push({ ...l, group: groupOf(l.command), source: 'claude' });
          }
        }
        record.commands = mergeCommands(record.commands, items, now);
        record.scannedAt = now;
        dirty = true;
        requests = await projectRequests(project.id);
        const busy = requests.some((r) => r.request.status === 'pending' || r.request.status === 'working');
        if (config.projects.describeWithClaude && !busy) await enqueueDescribe(project, record, lang);
      }
      if (dirty) await saveRecord(record);
      return { record, describe: describeState(await projectRequests(project.id), config), config };
    });
  }

  async function view(project: DiscoveredProject, { scan }: { scan: boolean }) {
    const { record, describe, config } = await sync(project, { scan });
    const [git, ledger] = await Promise.all([gitInfo(project), loadLedger(LEDGER_DAYS)]);
    const learned = record.commands.filter((c) => c.source === 'claude').length;
    return {
      project: { ...record, exists: project.exists, isWorktree: project.isWorktree, sessions: project.sessions, lastActivity: project.lastActivity },
      git,
      stats: projectStats(project, ledger, learned),
      describe,
      terminal: config.ui.terminal,
    };
  }

  // ---- list

  async function listProjects({ all }: { all: boolean }) {
    const config = await loadConfig();
    const showAll = all || config.projects.showWorktrees;
    const out: (DiscoveredProject & { commandCount: number; scannedAt: string | null; favorite: boolean })[] = [];
    for (const p of await discover()) {
      if (p.isWorktree && !showAll) continue;
      const record = await readJson(recordFile(p.id));
      const commandCount = isObject(record) && isArray(record.commands) ? record.commands.filter((c) => isObject(c) && !c.hidden).length : 0;
      out.push({
        ...p,
        commandCount,
        scannedAt: isObject(record) && typeof record.scannedAt === 'string' ? record.scannedAt : null,
        favorite: isObject(record) && record.favorite === true,
      });
    }
    return out;
  }

  // ---- favorites

  function setProjectFavorite(project: DiscoveredProject, favorite: unknown) {
    if (typeof favorite !== 'boolean') throw new HttpError(400, tr('“favorite” must be true or false.', '«favorite» должно быть true или false.'));
    return mutateRecord(project, (record) => {
      if (favorite) record.favorite = true;
      else delete record.favorite;
      return { favorite };
    });
  }

  // ---- command mutations

  function mutateRecord<T>(project: DiscoveredProject, fn: (record: ProjectRecord, now: string) => T | Promise<T>): Promise<T> {
    return withLock(async () => {
      const record = (await loadRecord(project)) ?? emptyRecord(project);
      const result = await fn(record, nowIso());
      await saveRecord(record);
      return result;
    });
  }

  const requireCommand = (record: ProjectRecord, cid: string): number => {
    const index = COMMAND_ID_RE.test(cid) ? record.commands.findIndex((c) => c.id === cid) : -1;
    if (index < 0) throw new HttpError(404, tr('Command not found.', 'Команда не найдена.'));
    return index;
  };

  const asBadRequest = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      if (typeof error === 'string') throw new HttpError(400, error);
      throw error;
    }
  };

  function cleanDescription(value: unknown): string {
    if (typeof value !== 'string') throw new HttpError(400, tr('The description must be a string.', 'Описание должно быть строкой.'));
    const text = value.trim().replace(/\s+/g, ' ');
    if (text.length > MAX_DESCRIPTION_CHARS) throw new HttpError(400, tr(`The description is longer than ${MAX_DESCRIPTION_CHARS} characters.`, `Описание длиннее ${MAX_DESCRIPTION_CHARS} символов.`));
    return text;
  }

  function cleanGroup(value: unknown): CommandGroup {
    if (!isGroup(value)) throw new HttpError(400, tr('Unknown group.', 'Неизвестная группа.'));
    return value;
  }

  async function addCommand(project: DiscoveredProject, body: Record<string, unknown>) {
    const config = await loadConfig();
    const command = asBadRequest(() => checkCommand(body.command));
    const dir = asBadRequest(() => normalizeDir(body.dir));
    const group = body.group === undefined || body.group === '' ? groupOf(command) : cleanGroup(body.group);
    const description = body.description === undefined ? '' : cleanDescription(body.description);
    const id = commandId(command, dir);
    return mutateRecord(project, (record, now) => {
      const old = record.commands.find((c) => c.id === id);
      if (old) {
        throw new HttpError(
          409,
          old.hidden
            ? tr('That command is already among the hidden ones.', 'Такая команда уже есть среди скрытых.')
            : tr('That command is already in the list.', 'Такая команда уже есть в списке.'),
        );
      }
      const created: ProjectCommandRecord = {
        id,
        command,
        ...(dir ? { dir } : {}),
        group,
        source: 'manual',
        ...(description ? { description, descriptionLang: config.projects.descriptionLanguage, descriptionSource: 'manual' as const } : {}),
        createdAt: now,
        updatedAt: now,
      };
      record.commands.push(created);
      return created;
    });
  }

  async function updateCommand(project: DiscoveredProject, cid: string, body: Record<string, unknown>) {
    const config = await loadConfig();
    return mutateRecord(project, (record, now) => {
      const index = requireCommand(record, cid);
      const c = { ...record.commands[index]! };
      if (body.description !== undefined) {
        const text = cleanDescription(body.description);
        if (text) {
          c.description = text;
          c.descriptionLang = config.projects.descriptionLanguage;
          c.descriptionSource = 'manual';
        } else {
          delete c.description;
          delete c.descriptionLang;
          delete c.descriptionSource;
        }
      }
      if (body.group !== undefined) {
        c.group = cleanGroup(body.group);
        if (c.source !== 'manual') c.groupEdited = true;
      }
      for (const flag of ['pinned', 'hidden', 'favorite'] as const) {
        if (body[flag] === undefined) continue;
        if (typeof body[flag] !== 'boolean') throw new HttpError(400, tr(`“${flag}” must be true or false.`, `«${flag}» должно быть true или false.`));
        if (body[flag]) c[flag] = true;
        else delete c[flag];
      }
      if (body.command !== undefined || body.dir !== undefined) {
        const command = body.command === undefined ? c.command : asBadRequest(() => checkCommand(body.command));
        const dir = body.dir === undefined ? c.dir : asBadRequest(() => normalizeDir(body.dir));
        if (command !== c.command || dir !== c.dir) {
          if (c.source !== 'manual') throw new HttpError(400, tr('The command and folder can only be changed for commands added manually.', 'Команду и папку можно менять только у добавленных вручную.'));
          const id = commandId(command, dir);
          if (id !== c.id && record.commands.some((o) => o.id === id)) throw new HttpError(409, tr('That command is already in the list.', 'Такая команда уже есть в списке.'));
          c.id = id;
          c.command = command;
          if (dir) c.dir = dir;
          else delete c.dir;
        }
      }
      c.updatedAt = now;
      record.commands[index] = c;
      return c;
    });
  }

  function deleteCommand(project: DiscoveredProject, cid: string) {
    return mutateRecord(project, (record, now) => {
      const index = requireCommand(record, cid);
      const c = record.commands[index]!;
      if (c.source === 'manual') {
        record.commands.splice(index, 1);
        return { ok: true, removed: true };
      }
      record.commands[index] = { ...c, hidden: true, updatedAt: now };
      return { ok: true, removed: false, command: record.commands[index] };
    });
  }

  // ---- actions on the machine

  function exec(file: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(file, args, { timeout: 15_000 }, (error, _stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderrText: String(stderr ?? '').trim() }));
        else resolve();
      });
    });
  }

  /** What an `exec` failure says: the program's stderr, else the error message. */
  function failureText(error: unknown): string {
    if (!(error instanceof Error)) return String(error);
    const stderr = 'stderrText' in error && typeof error.stderrText === 'string' ? error.stderrText : '';
    return stderr || error.message;
  }

  async function openProject(project: DiscoveredProject, target: unknown) {
    if (process.platform !== 'darwin') throw new HttpError(400, tr('Opening a folder only works on macOS.', 'Открытие папки работает только на macOS.'));
    if (!project.exists) throw new HttpError(400, tr('The project folder was not found.', 'Папка проекта не найдена.'));
    if (target !== 'finder' && target !== 'terminal') throw new HttpError(400, tr('target: “finder” or “terminal”.', 'target: «finder» или «terminal».'));
    try {
      await exec('open', target === 'finder' ? [project.path] : ['-a', 'Terminal', project.path]);
    } catch (error) {
      throw new HttpError(500, tr(`Could not open: ${failureText(error).slice(0, 200)}`, `Не удалось открыть: ${failureText(error).slice(0, 200)}`));
    }
    return { ok: true };
  }

  async function runCommand(project: DiscoveredProject, cid: string) {
    if (process.platform !== 'darwin') throw new HttpError(400, tr('Running in Terminal.app only works on macOS.', 'Запуск в Terminal.app работает только на macOS.'));
    if (!project.exists) throw new HttpError(400, tr('The project folder was not found.', 'Папка проекта не найдена.'));
    const record = await loadRecord(project);
    const stored = record?.commands.find((c) => c.id === cid && COMMAND_ID_RE.test(cid));
    if (!stored) throw new HttpError(404, tr('Command not found.', 'Команда не найдена.'));
    // Only the stored command is run; the request body is never read.
    if (CONTROL_RE.test(stored.command) || stored.command.trim() === '') throw new HttpError(400, tr('The command is not a single line: launch refused.', 'Команда не в одну строку: запуск отклонён.'));
    if (looksSecret(stored.command)) throw new HttpError(400, tr('The command looks like a secret: launch refused.', 'Команда похожа на секрет: запуск отклонён.'));
    if (CONTROL_RE.test(project.path)) throw new HttpError(400, tr('The project path contains invalid characters.', 'В пути проекта недопустимые символы.'));
    let dir: string | undefined;
    try {
      dir = normalizeDir(stored.dir);
    } catch (message) {
      throw new HttpError(400, typeof message === 'string' ? message : tr('Invalid folder.', 'Недопустимая папка.'));
    }
    if (dir) {
      // The folder must exist and stay inside the project (no symlink out).
      try {
        const real = await fs.realpath(path.join(project.path, dir));
        const root = await fs.realpath(project.path);
        if (real !== root && !real.startsWith(root + path.sep)) throw new Error('outside');
      } catch {
        throw new HttpError(400, tr(`Folder “${dir}” was not found in the project.`, `Папка «${dir}» не найдена в проекте.`));
      }
    }
    const args = terminalScript(terminalLine(project.path, dir, stored.command)).flatMap((script) => ['-e', script]);
    try {
      await exec('osascript', args);
    } catch (error) {
      throw new HttpError(500, tr(`Could not launch in Terminal.app: ${failureText(error).slice(0, 200)}`, `Не удалось запустить в Terminal.app: ${failureText(error).slice(0, 200)}`));
    }
    return { ok: true };
  }

  // ---- routing

  /**
   * `segments` are the path parts after /api/projects. Returns {status, body}.
   * `readBody` parses the JSON body lazily; mutations have passed the CSRF guard already.
   */
  async function handle({
    method,
    segments,
    query,
    readBody,
  }: {
    method: string;
    segments: string[];
    query: URLSearchParams;
    readBody: () => Promise<Record<string, unknown>>;
  }): Promise<{ status: number; body: unknown }> {
    const [id, resource, cid, action] = segments;
    if (!id) {
      if (method !== 'GET') throw new HttpError(404, tr('Not found.', 'Не найдено.'));
      return { status: 200, body: await listProjects({ all: query.get('all') === '1' }) };
    }
    const project = await findProject(id);
    if (!resource) {
      if (method === 'PUT') {
        const body = await readBody();
        return { status: 200, body: await setProjectFavorite(project, body.favorite) };
      }
      if (method !== 'GET') throw new HttpError(404, tr('Not found.', 'Не найдено.'));
      return { status: 200, body: await view(project, { scan: false }) };
    }
    if (resource === 'scan' && !cid && method === 'POST') {
      if (!project.exists) throw new HttpError(400, tr('The project folder was not found.', 'Папка проекта не найдена.'));
      return { status: 200, body: await view(project, { scan: true }) };
    }
    if (resource === 'open' && !cid && method === 'POST') {
      const body = await readBody();
      return { status: 200, body: await openProject(project, body.target) };
    }
    if (resource === 'commands') {
      if (!cid && method === 'POST') {
        const body = await readBody();
        return { status: 201, body: { command: await addCommand(project, body) } };
      }
      if (cid && !action && method === 'PUT') {
        const body = await readBody();
        return { status: 200, body: { command: await updateCommand(project, cid, body) } };
      }
      if (cid && !action && method === 'DELETE') return { status: 200, body: await deleteCommand(project, cid) };
      if (cid && action === 'run' && method === 'POST') return { status: 200, body: await runCommand(project, cid) };
    }
    throw new HttpError(404, tr('Not found.', 'Не найдено.'));
  }

  return { handle, listProjects, discover, findProject, sync, view };
}
