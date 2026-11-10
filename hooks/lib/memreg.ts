// The projects the memory knows, kept by the mod beside its other data (memory/projects.json) and
// read by the UI. Pure. A memory id alone says little: this file ties it to the folders it was seen
// in, to the older ids the same project had (a project that got its git remote later changed its
// id; those are its `aliases`, still read on recall), and to the projects it is related to (their
// memory is looked into when a task needs it).

import { isLocal, isPersonal, memoryName } from './mnema.ts';

export type MemProject = {
  /** The memory id the project's facts go to. */
  id: string;
  /** Its name for people and for spotting a mention: the repository or folder name. */
  name: string;
  /** Other names it goes by (the folder's, when the repository is named differently). */
  names: string[];
  /** Folders the project was opened in. */
  roots: string[];
  /** Older memory ids of the same project; read on recall, never written to. */
  aliases: string[];
  /** Memory ids of related projects. */
  related: string[];
  seenAt?: string;
  /** Set apart by hand (the UI's "not the same project"): never folded into a project of the same name. */
  apart?: true;
};

export type MemRegistry = { version: 1; projects: MemProject[] };

const strings = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()))] : []);

/** The file as stored, with anything malformed dropped. */
export function readRegistry(raw: unknown): MemRegistry {
  const list = typeof raw === 'object' && raw !== null && Array.isArray((raw as { projects?: unknown }).projects) ? (raw as { projects: unknown[] }).projects : [];
  const projects: MemProject[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id.startsWith('repo.') || projects.some((p) => p.id === r.id)) continue;
    projects.push({
      id: r.id,
      name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : memoryName(r.id),
      names: strings(r.names),
      roots: strings(r.roots),
      aliases: strings(r.aliases).filter((a) => a !== r.id),
      related: strings(r.related).filter((a) => a !== r.id),
      ...(typeof r.seenAt === 'string' ? { seenAt: r.seenAt } : {}),
      ...(r.apart === true ? { apart: true as const } : {}),
    });
  }
  return { version: 1, projects };
}

const folderOf = (root: string): string => root.split('/').filter(Boolean).pop() ?? '';

function blank(id: string): MemProject {
  return { id, name: memoryName(id), names: [], roots: [], aliases: [], related: [] };
}

/** The entry a memory id belongs to: its own, or the one it is an alias of. */
export function findProject(reg: MemRegistry, id: string): MemProject | undefined {
  return reg.projects.find((p) => p.id === id) ?? reg.projects.find((p) => p.aliases.includes(id));
}

/** Folds `from` into `into`: its names, folders, aliases and relations move over and its id becomes an alias. */
function absorb(reg: MemRegistry, into: MemProject, from: MemProject): void {
  const add = (list: string[], more: readonly string[]): void => {
    for (const v of more) if (!list.includes(v) && v !== into.id) list.push(v);
  };
  add(into.aliases, [from.id, ...from.aliases]);
  add(into.roots, from.roots);
  add(into.names, [from.name, ...from.names].filter((n) => n !== into.name));
  add(into.related, from.related);
  reg.projects = reg.projects.filter((p) => p !== from);
  // Whoever was related to the old id is now related to the new one.
  for (const p of reg.projects) {
    if (p.related.includes(from.id)) p.related = [...new Set(p.related.map((r) => (r === from.id ? into.id : r)))].filter((r) => r !== p.id);
  }
}

/**
 * A session opened `root` and its memory id is `id`. A folder that had another id before (the
 * project got a git remote, or a `.mnema-mcp.toml`) keeps its old memory as an alias of the new one.
 * Returns whether the registry changed.
 */
export function noteProject(reg: MemRegistry, seen: { id: string; root: string; at: string }): boolean {
  const before = JSON.stringify(reg);
  let entry = reg.projects.find((p) => p.id === seen.id);
  if (!entry) {
    const asAlias = reg.projects.find((p) => p.aliases.includes(seen.id));
    if (asAlias && !asAlias.roots.includes(seen.root)) {
      // An id that was merged into another project is being used again from a new folder: it is its own project.
      asAlias.aliases = asAlias.aliases.filter((a) => a !== seen.id);
    } else if (asAlias) {
      // The folder still resolves to the old id (the remote went away): the facts keep going to the merged project.
      asAlias.seenAt = seen.at;
      return JSON.stringify(reg) !== before;
    }
    entry = blank(seen.id);
    reg.projects.push(entry);
  }
  if (!entry.roots.includes(seen.root)) entry.roots.push(seen.root);
  const folder = folderOf(seen.root);
  if (folder && folder.toLowerCase() !== entry.name.toLowerCase() && !entry.names.includes(folder)) entry.names.push(folder);
  entry.seenAt = seen.at;
  for (const other of [...reg.projects]) {
    if (other !== entry && other.roots.includes(seen.root)) absorb(reg, entry, other);
  }
  return JSON.stringify(reg) !== before;
}

/**
 * The memories the service holds, made known to the registry. A local memory (`repo.local.<name>-…`)
 * whose folder is unknown and whose name is that of exactly one project with a remote is the same
 * project from before it had the remote: it becomes that project's alias.
 */
export function syncMemories(reg: MemRegistry, ids: readonly string[]): boolean {
  const before = JSON.stringify(reg);
  const projects = ids.filter((id) => id.startsWith('repo.') && !isPersonal(id));
  for (const id of projects) if (!findProject(reg, id)) reg.projects.push(blank(id));
  for (const local of [...reg.projects]) {
    if (!isLocal(local.id) || local.roots.length > 0 || local.apart) continue;
    const same = reg.projects.filter((p) => p !== local && !isLocal(p.id) && p.name.toLowerCase() === local.name.toLowerCase());
    if (same.length === 1) absorb(reg, same[0]!, local);
  }
  return JSON.stringify(reg) !== before;
}

/** The ids a project's facts are read from: its own first, then its older ones. */
export function memoryIds(reg: MemRegistry, id: string): string[] {
  const entry = findProject(reg, id);
  return entry ? [entry.id, ...entry.aliases] : [id];
}

/** Names too common to mean a project when they turn up in a sentence. */
const COMMON = new Set(['app', 'apps', 'web', 'api', 'test', 'tests', 'demo', 'main', 'core', 'docs', 'data', 'code', 'claude', 'project', 'server', 'client', 'backend', 'frontend', 'scratch', 'local', 'unnamed']);

function mentionPattern(name: string): RegExp | undefined {
  const parts = name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const joined = parts.join('');
  if (joined.length < 4 || COMMON.has(joined)) return undefined;
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // "my-dev-shell" also matches "my dev shell" and "MyDevShell".
  return new RegExp(`(?<![\\p{L}\\p{N}])${parts.map(esc).join('[\\s._/-]*')}(?![\\p{L}\\p{N}])`, 'iu');
}

/** The other projects a text names (by repository or folder name). */
export function mentioned(reg: MemRegistry, text: string, selfId: string): MemProject[] {
  const self = findProject(reg, selfId);
  return reg.projects.filter((p) => {
    if (p === self) return false;
    return [p.name, ...p.names].some((name) => mentionPattern(name)?.test(text) === true);
  });
}

/** Relates two projects (both ways). Returns whether anything changed. */
export function link(reg: MemRegistry, a: string, b: string): boolean {
  const x = findProject(reg, a);
  const y = findProject(reg, b);
  if (!x || !y || x === y) return false;
  let changed = false;
  if (!x.related.includes(y.id)) {
    x.related.push(y.id);
    changed = true;
  }
  if (!y.related.includes(x.id)) {
    y.related.push(x.id);
    changed = true;
  }
  return changed;
}

/** Ends the relation (both ways). */
export function unlink(reg: MemRegistry, a: string, b: string): boolean {
  const x = findProject(reg, a);
  const y = findProject(reg, b);
  if (!x || !y) return false;
  const had = x.related.includes(y.id) || y.related.includes(x.id);
  x.related = x.related.filter((r) => r !== y.id);
  y.related = y.related.filter((r) => r !== x.id);
  return had;
}

/** Makes `from` an alias of `into` (the UI's "this is the same project"). */
export function mergeProjects(reg: MemRegistry, from: string, into: string): boolean {
  const x = reg.projects.find((p) => p.id === from);
  const y = reg.projects.find((p) => p.id === into);
  if (!x || !y || x === y) return false;
  absorb(reg, y, x);
  return true;
}

/** The projects related to one, as entries. */
export function relatedOf(reg: MemRegistry, id: string): MemProject[] {
  const entry = findProject(reg, id);
  if (!entry) return [];
  return entry.related.map((r) => findProject(reg, r)).filter((p): p is MemProject => p !== undefined && p !== entry);
}
