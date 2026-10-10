/**
 * Tools kept out of the prompt's tool list (behind ToolSearch) while nobody uses them. Every main
 * request and subagent request carries the listed tools' full descriptions; a tool used once in a
 * hundred chats (the Artifact tool's text alone is ~5k tokens) is read from the cache on every
 * step for nothing. Deferred, it costs one ToolSearch call on the day it is wanted, and from then
 * on its use keeps it listed (`idleDays`).
 */

/** When each tool was last called, and since when calls are counted. */
export type ToolUse = { since: number; last: Record<string, number> };

export type ToolsConfig = {
  /** Put long, unused tools behind ToolSearch. */
  deferIdle: boolean;
  /** Known rarely used tools, deferred from the first day (exact names, or `prefix*`). */
  deferAlso: string[];
  /** Never deferred (exact names, or `prefix*`). */
  keep: string[];
  /** A tool called within this many days stays listed; one unused this long is deferred. */
  idleDays: number;
  /** Shorter descriptions are not worth a ToolSearch round trip. */
  minChars: number;
};

/** Tools the engine itself needs in front (ToolSearch loads the rest; Agent spawns work). */
const ALWAYS_LISTED = new Set(['ToolSearch', 'Agent', 'Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Skill', 'AskUserQuestion']);

export function matches(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
}

/**
 * Whether to put a listed tool behind ToolSearch: long, not needed by the engine, not kept, and
 * either known rare (`deferAlso`) or unused for `idleDays` with at least that long counted. A tool
 * called within `idleDays` always stays listed.
 */
export function shouldDefer(tool: string, descriptionChars: number, use: ToolUse, config: ToolsConfig, now: number): boolean {
  if (!config.deferIdle || ALWAYS_LISTED.has(tool) || matches(tool, config.keep)) return false;
  if (descriptionChars < config.minChars) return false;
  const window = config.idleDays * 86_400_000;
  const last = use.last[tool];
  if (last !== undefined && now - last < window) return false;
  return matches(tool, config.deferAlso) || now - use.since >= window;
}
