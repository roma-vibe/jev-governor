// Important commands of a project, for the settings UI's project pages:
// discovered from the project's own files (package.json scripts, Makefile
// targets, Cargo crates, justfile recipes, compose, launch.json, commands in
// README / AGENTS / CLAUDE docs) and learned from the commands Claude runs
// there successfully. Pure: the UI server reads the files, the mod observes
// commands; both call these functions.

export type CommandGroup = 'run' | 'build' | 'test' | 'check' | 'db' | 'deploy' | 'other';
export const COMMAND_GROUPS: readonly CommandGroup[] = ['run', 'build', 'test', 'check', 'db', 'deploy', 'other'];

export type CommandSource =
  | 'package.json'
  | 'Makefile'
  | 'Cargo.toml'
  | 'justfile'
  | 'pyproject'
  | 'compose'
  | 'launch.json'
  | 'docs'
  | 'claude'
  | 'manual';

export type DiscoveredCommand = {
  command: string;
  /** Subdirectory (relative to the project root) to run it in; absent = root. */
  dir?: string;
  group: CommandGroup;
  /** What the source says about it (a comment, the script body), to seed a description. */
  hint?: string;
  source: CommandSource;
  /** Script name, target, file the command came from. */
  sourceDetail?: string;
};

/** Stable short id of a command in its directory (FNV-1a, hex). */
export function commandId(command: string, dir?: string): string {
  let hash = 0x811c9dc5;
  for (const ch of `${dir ?? ''}\u0000${command.trim().replace(/\s+/g, ' ')}`) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const GROUP_RULES: readonly [CommandGroup, RegExp][] = [
  ['deploy', /\b(deploy|publish|ship)\b/],
  ['db', /\b(db|database|migrat\w*|seed|prisma|drizzle|sqlx|alembic|psql)\b/],
  ['test', /\b(test|tests|vitest|jest|pytest|nextest|e2e|spec|playwright|cypress|coverage)\b/],
  ['check', /\b(lint|eslint|clippy|fmt|format|prettier|typecheck|tsc|vue-tsc|check|ruff|mypy|audit|i18n)\b/],
  ['build', /\b(build|compile|bundle|dist|package|sidecar|install|setup|bootstrap)\b/],
  ['run', /\b(dev|start|serve|server|run|preview|watch|up|open|tauri)\b/],
];

/** A group from the command text and, when there is one, its script / target name. */
export function groupOf(command: string, name?: string): CommandGroup {
  for (const text of [name, command]) {
    if (!text) continue;
    const t = text.toLowerCase().replace(/[:_-]/g, ' ');
    for (const [group, re] of GROUP_RULES) if (re.test(t)) return group;
  }
  return 'other';
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export function detectPackageManager(files: readonly string[]): PackageManager {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('yarn.lock')) return 'yarn';
  if (files.includes('bun.lockb') || files.includes('bun.lock')) return 'bun';
  return 'npm';
}

/** Lifecycle hooks npm runs by itself: not commands a person types. */
const NPM_LIFECYCLE = /^(pre|post)|^(prepare|prepublish\w*|install|uninstall|version)$/;

export function parsePackageJson(text: string, pm: PackageManager, dir?: string): DiscoveredCommand[] {
  let pkg: { scripts?: Record<string, unknown> };
  try {
    pkg = JSON.parse(text) as { scripts?: Record<string, unknown> };
  } catch {
    return [];
  }
  const out: DiscoveredCommand[] = [];
  const install = pm === 'npm' ? 'npm install' : `${pm} install`;
  out.push({ command: install, dir, group: 'build', hint: 'install dependencies', source: 'package.json', sourceDetail: 'dependencies' });
  for (const [name, body] of Object.entries(pkg.scripts ?? {})) {
    if (typeof body !== 'string' || NPM_LIFECYCLE.test(name)) continue;
    const command = pm === 'npm' ? (name === 'test' || name === 'start' ? `npm ${name}` : `npm run ${name}`) : `${pm} ${name}`;
    out.push({ command, dir, group: groupOf(body, name), hint: body, source: 'package.json', sourceDetail: name });
  }
  return out;
}

export function parseMakefile(text: string, dir?: string): DiscoveredCommand[] {
  const out: DiscoveredCommand[] = [];
  const lines = text.split('\n');
  const phony = new Set<string>();
  for (const line of lines) {
    const m = /^\.PHONY\s*:\s*(.+)$/.exec(line);
    if (m) for (const t of m[1]!.split(/\s+/)) if (t) phony.add(t);
  }
  let comment: string[] = [];
  for (const line of lines) {
    if (/^#/.test(line)) {
      comment.push(line.replace(/^#+\s?/, '').trim());
      continue;
    }
    const m = /^([A-Za-z0-9][\w.-]*)\s*:(?!=)\s*([^#]*?)(?:##\s*(.*))?$/.exec(line);
    if (m && !line.startsWith('\t') && !/[%$]/.test(m[1]!)) {
      const target = m[1]!;
      const hint = (m[3] ?? comment.filter(Boolean).join(' ')).trim() || undefined;
      if (phony.size === 0 || phony.has(target) || hint) {
        out.push({ command: `make ${target}`, dir, group: groupOf(target, target), hint, source: 'Makefile', sourceDetail: target });
      }
    }
    if (!/^\s*$/.test(line) || comment.length > 0) comment = [];
  }
  return out;
}

export type CargoCrate = { name: string; dir?: string; hasBin: boolean };

/**
 * Cargo commands per crate: in a workspace always with `-p` (a whole-workspace
 * build can fail for one member, e.g. a Tauri app that needs a sidecar).
 */
export function cargoCommands(
  crates: readonly CargoCrate[],
  options: { offline?: boolean; workspace?: boolean } = {},
): DiscoveredCommand[] {
  const offline = options.offline ? ' --offline' : '';
  const out: DiscoveredCommand[] = [];
  for (const crate of crates) {
    const p = options.workspace || crates.length > 1 ? ` -p ${crate.name}` : '';
    out.push({ command: `cargo test${offline}${p}`, group: 'test', source: 'Cargo.toml', sourceDetail: crate.name, hint: `tests of ${crate.name}` });
    out.push({ command: `cargo clippy${offline}${p} --all-targets -- -D warnings`, group: 'check', source: 'Cargo.toml', sourceDetail: crate.name, hint: `lints of ${crate.name}` });
    if (crate.hasBin) {
      out.push({ command: `cargo build${offline}${p}`, group: 'build', source: 'Cargo.toml', sourceDetail: crate.name, hint: `debug build of ${crate.name}` });
      out.push({ command: `cargo run${offline}${p}`, group: 'run', source: 'Cargo.toml', sourceDetail: crate.name, hint: `runs the ${crate.name} binary` });
    }
  }
  if (crates.length > 0) out.push({ command: 'cargo fmt --all', group: 'check', source: 'Cargo.toml', hint: 'formats every crate' });
  return out;
}

/**
 * Workspace members with `dir/*` globs expanded through `listDirs` (the
 * subdirectories of a path relative to the workspace root).
 */
export function expandMembers(members: readonly string[], listDirs: (dir: string) => readonly string[]): string[] {
  const out: string[] = [];
  for (const member of members) {
    if (member.endsWith('/*')) {
      const base = member.slice(0, -2);
      for (const sub of listDirs(base)) out.push(`${base}/${sub}`);
    } else if (!member.includes('*')) out.push(member);
  }
  return out;
}

/** Package name and workspace members of a Cargo.toml (enough TOML for that). */
export function readCargoToml(text: string): { name?: string; members: string[]; hasBinSection: boolean } {
  const name = /^\s*\[package\][^[]*?^\s*name\s*=\s*"([^"]+)"/ms.exec(text)?.[1];
  const membersBlock = /^\s*members\s*=\s*\[([^\]]*)\]/ms.exec(text)?.[1] ?? '';
  const members = [...membersBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  return { name, members, hasBinSection: /^\s*\[\[bin\]\]/m.test(text) };
}

export function parseJustfile(text: string, dir?: string): DiscoveredCommand[] {
  const out: DiscoveredCommand[] = [];
  let comment = '';
  for (const line of text.split('\n')) {
    if (/^#/.test(line)) {
      comment = line.replace(/^#+\s?/, '').trim();
      continue;
    }
    // `recipe param="default":` is a recipe; `name := value` and `set x := y` are not.
    const m = /^@?([A-Za-z0-9][\w-]*)(\s+[^:]*)?:(?!=)/.exec(line);
    if (m && !/^\s/.test(line)) {
      out.push({ command: `just ${m[1]}`, dir, group: groupOf(m[1]!, m[1]), hint: comment || undefined, source: 'justfile', sourceDetail: m[1] });
    }
    if (!/^#/.test(line)) comment = '';
  }
  return out;
}

export function parseLaunchJson(text: string): DiscoveredCommand[] {
  let parsed: { configurations?: unknown[] };
  try {
    parsed = JSON.parse(text) as { configurations?: unknown[] };
  } catch {
    return [];
  }
  const out: DiscoveredCommand[] = [];
  for (const raw of parsed.configurations ?? []) {
    const c = raw as { name?: string; runtimeExecutable?: string; runtimeArgs?: string[]; port?: number; cwd?: string };
    if (!c.runtimeExecutable) continue;
    const command = [c.runtimeExecutable, ...(c.runtimeArgs ?? [])].join(' ');
    out.push({
      command,
      dir: c.cwd && c.cwd !== '.' ? c.cwd.replace(/^\.\//, '') : undefined,
      group: 'run',
      hint: `${c.name ?? 'dev server'}${c.port ? ` on port ${c.port}` : ''}`,
      source: 'launch.json',
      sourceDetail: c.name,
    });
  }
  return out;
}

export function composeCommands(file: string, dir?: string): DiscoveredCommand[] {
  const f = file === 'docker-compose.yml' || file === 'compose.yaml' || file === 'compose.yml' ? '' : ` -f ${file}`;
  return [
    { command: `docker compose${f} up -d`, dir, group: 'run', hint: 'starts the services in the background', source: 'compose', sourceDetail: file },
    { command: `docker compose${f} logs -f`, dir, group: 'run', hint: 'follows the service logs', source: 'compose', sourceDetail: file },
    { command: `docker compose${f} down`, dir, group: 'run', hint: 'stops the services', source: 'compose', sourceDetail: file },
  ];
}

export function parsePyproject(text: string, files: readonly string[], dir?: string): DiscoveredCommand[] {
  const runner = files.includes('uv.lock') ? 'uv run' : files.includes('poetry.lock') ? 'poetry run' : 'python -m';
  const out: DiscoveredCommand[] = [];
  const scripts = /^\s*\[(?:project\.scripts|tool\.poetry\.scripts)\]([^[]*)/ms.exec(text)?.[1] ?? '';
  for (const m of scripts.matchAll(/^\s*([\w.-]+)\s*=/gm)) {
    out.push({ command: `${runner === 'python -m' ? '' : `${runner} `}${m[1]}`.trim(), dir, group: groupOf(m[1]!, m[1]), source: 'pyproject', sourceDetail: m[1] });
  }
  if (/\[tool\.pytest|pytest/.test(text)) {
    out.push({ command: runner === 'python -m' ? 'python -m pytest' : `${runner} pytest`, dir, group: 'test', hint: 'runs the test suite', source: 'pyproject' });
  }
  if (files.includes('uv.lock')) out.push({ command: 'uv sync', dir, group: 'build', hint: 'installs dependencies', source: 'pyproject' });
  return out;
}

const DOC_TOOLS =
  /^(npm|npx|pnpm|yarn|bun|bunx|cargo|rustup|make|just|docker|docker-compose|python3?|pip3?|uv|poetry|go|deno|node|tauri|gradle|\.\/gradlew|mvn|dotnet|swift|xcodebuild|flutter|dart|bundle|rails|rake|mix|php|composer|terraform|kubectl|helm|ansible|psql|sqlx|prisma|supabase|vercel|wrangler|fly|firebase)\b/;

/** Commands shown in fenced shell blocks of a Markdown file. */
export function extractDocCommands(markdown: string, file: string): DiscoveredCommand[] {
  const out: DiscoveredCommand[] = [];
  const block = /```([\w-]*)\n([\s\S]*?)```/g;
  for (const m of markdown.matchAll(block)) {
    const lang = m[1]!.toLowerCase();
    if (lang && !['sh', 'bash', 'shell', 'zsh', 'console', 'terminal', 'cmd'].includes(lang)) continue;
    // The prose line before the block often says what it does.
    const before = markdown.slice(0, m.index).trimEnd().split('\n').pop()?.replace(/^[#>*\s-]+/, '').trim();
    for (const raw of m[2]!.split('\n')) {
      let line = raw.replace(/^\s*[$%>]\s+/, '').trim();
      // `make dev   # what it does`: the comment is the best description there is.
      let comment: string | undefined;
      const hash = line.search(/\s#\s/);
      if (hash > 0) {
        comment = line.slice(hash).replace(/^\s*#\s*/, '').trim() || undefined;
        line = line.slice(0, hash).trim();
      }
      if (!line || line.startsWith('#') || !DOC_TOOLS.test(line) || line.length > 200) continue;
      if (looksSecret(line)) continue;
      // A lead-in sentence ("To start the app, run:") describes the block; a heading does not.
      const lead = before && before.endsWith(':') && before.length < 160 ? before.slice(0, -1) : undefined;
      const hint = comment ?? lead;
      out.push({ command: line, group: groupOf(line), hint, source: 'docs', sourceDetail: file });
    }
  }
  return out;
}

/** A human sentence rather than a script body (`vite`, `eslint . && tsc`). */
function isProse(hint: string | undefined): boolean {
  return hint !== undefined && hint.trim().split(/\s+/).length >= 3 && !/&&|\|\||[|;]|^\S+\s+--?\w/.test(hint);
}

/** Drops duplicates (same command in the same dir), keeping the first and the most readable hint. */
export function dedupe(commands: readonly DiscoveredCommand[]): DiscoveredCommand[] {
  const seen = new Map<string, DiscoveredCommand>();
  for (const c of commands) {
    const key = commandId(c.command, c.dir);
    const known = seen.get(key);
    if (!known) seen.set(key, { ...c });
    else if ((!known.hint && c.hint) || (!isProse(known.hint) && isProse(c.hint))) known.hint = c.hint;
  }
  return [...seen.values()];
}

const SECRET = /(token|secret|passw(or)?d|api[_-]?key|authorization|bearer|private[_-]?key|credential|sk-[a-z0-9]|ghp_|xox[bp]-)/i;

export function looksSecret(command: string): boolean {
  return SECRET.test(command);
}

/** Commands run to look around, not project commands worth a button. */
const EXPLORATORY =
  /^(ls|ll|cat|head|tail|less|more|bat|grep|rg|ag|find|fd|tree|pwd|echo|printf|which|type|wc|sort|uniq|cut|awk|sed|diff|file|stat|du|df|env|printenv|date|sleep|true|false|test|\[|cd|mkdir|touch|rm|cp|mv|ln|chmod|open|jq|xxd|od|history|clear|git\s+(status|log|diff|show|blame|branch|remote|rev-parse|ls-files|grep|stash\s+list|config)|gh\s+(pr|issue|repo)\s+view)\b/;

/**
 * A command Claude ran, reduced to what a person would type: output plumbing
 * (`2>&1`, `| tail -40`, `| grep …`) and a leading `cd <dir> &&` removed (the
 * dir kept). Undefined when it is exploratory, compound, or may hold a secret.
 */
export function normalizeObserved(command: string): { command: string; dir?: string } | undefined {
  let c = command.trim();
  if (!c || c.includes('\n') || looksSecret(c) || c.length > 300) return undefined;
  let dir: string | undefined;
  const cd = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*(.+)$/.exec(c);
  if (cd) {
    dir = cd[1]!.replace(/^["']|["']$/g, '');
    c = cd[2]!.trim();
  }
  c = c.replace(/\s+2>&1/g, '');
  c = c.replace(/(\s*\|\s*(tail|head|grep|rg|sed|less|wc|sort|uniq|cut|awk|tee)\b[^|]*)+$/, '').trim();
  c = c.replace(/\s*[;&]\s*$/, '').trim();
  if (/[;|`]|&&|\|\||\$\(/.test(c)) return undefined;
  if (EXPLORATORY.test(c)) return undefined;
  if (dir && (dir.startsWith('/') || dir.startsWith('~') || dir.includes('..'))) return undefined;
  return { command: c, ...(dir && dir !== '.' ? { dir: dir.replace(/^\.\//, '').replace(/\/$/, '') } : {}) };
}

/**
 * Where a command seen in `shell` ran, relative to the project `root`, with the
 * command's own `cd` (`dir`) appended: '' at the root itself, undefined when
 * the shell is outside the project (a scratch folder: not the project's command).
 */
export function commandDir(root: string, shell: string, dir?: string): string | undefined {
  const base = root.replace(/\/+$/, '');
  const at = shell.replace(/\/+$/, '');
  let sub: string;
  if (at === base) sub = '';
  else if (at.startsWith(`${base}/`)) sub = at.slice(base.length + 1);
  else return undefined;
  return [sub, dir ?? ''].filter(Boolean).join('/');
}

export type DescribeItem = { id: string; command: string; dir?: string; hint?: string; source: CommandSource };

export function describeSystem(language: 'ru' | 'en'): string {
  const lang = language === 'ru' ? 'Russian' : 'English';
  return `You describe developer commands for a project's command palette. Reply with ONE JSON object mapping each id to a description and nothing else.
Rules: ${lang}; one short line, at most 90 characters; say what the command does for the developer (not how); no trailing period; no quotes around the command; mention a notable side effect (deletes data, deploys, needs a running database) when there is one.`;
}

export function describePrompt(project: { name: string }, items: readonly DescribeItem[]): string {
  return JSON.stringify({
    project: project.name,
    commands: items.map((i) => ({ id: i.id, command: i.command, dir: i.dir, source: i.source, hint: i.hint?.slice(0, 200) })),
  });
}

/** The descriptions out of a reply, for the ids that were asked only. */
export function parseDescriptions(reply: string, ids: ReadonlySet<string>): Record<string, string> {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (ids.has(id) && typeof value === 'string' && value.trim()) out[id] = value.trim().slice(0, 140);
  }
  return out;
}
