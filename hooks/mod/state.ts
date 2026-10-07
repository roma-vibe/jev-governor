// The session state of the mod (`S`), its types, and the helpers that need
// no engine interface. They live apart from register.ts only so far as the
// engine allows: `$` may be passed only to functions declared in the same
// file as the hook, never across an import, so everything that does I/O
// through `$` stays in register.ts (see docs/ARCHITECTURE.md).

import { callLabel, prunedCalls, rerunKey, type PrunedCall } from '../lib/archive.ts';
import type { Pressure } from '../lib/budget.ts';
import type { CapsuleMeta } from '../lib/capsule.ts';
import { collectToolCalls } from '../lib/compaction/state.ts';
import type { CallDecision, Message } from '../lib/compaction/types.ts';
import { DEFAULT_CONFIG, isExcluded, isShadow } from '../lib/config.ts';
import type { Lang } from '../lib/lang.ts';
import { displayModel } from '../lib/providers.ts';
import { DEFAULT_TURN, type Decision, type Signals, type TurnProfile } from '../lib/router.ts';
import type { AgentRecord, Effort, GovernorConfig, LedgerEntry, SkillRecord, Tier } from '../lib/types.ts';

export type Route = {
  /** The model id the main loop last sent. */
  lastModel?: string;
  /** The session's own model as of the last step (detects /model changes). */
  lastSessionModel?: string;
  lastRequestAt?: number;
  /** No warm cache to lose on the next main request. */
  freeSwitch: boolean;
  previous?: { tier: Tier; effort: Effort };
  /** Context tokens right after our last compaction or skipped attempt (hysteresis). */
  compactedAt?: number;
  /** rerunKey → label of the calls compactions pruned, until the model runs one again. */
  pruned?: Record<string, string>;
  /** What a main turn of this session usually spends (running average), for the cost of a model switch. */
  turnProfile?: TurnProfile;
  /** The session's own effort at the last main turn (detects the person changing it). */
  lastBaseEffort?: string;
};

export type Rate = { fiveHour?: number; sevenDay?: number };

export type MainOutcome = {
  decision: Decision;
  signals?: Signals;
  pressure: Pressure;
  pressureText: string;
  rate: Rate;
  contextTokens?: number;
  jevMs?: number;
  jevCost?: number;
  /** Decided without Jev (a short follow-up). */
  local?: boolean;
  /** The prompt cache had expired (idle past the TTL): the next step re-writes the whole context. */
  cacheCold?: boolean;
  /** The person changed the model with /model since the last turn: kept, not overridden. */
  manual?: boolean;
};

export type TurnState = {
  id: string;
  text: string;
  decision: Promise<MainOutcome | undefined>;
  errors: number;
  logged: boolean;
  /** Model requests so far; the request's own model / effort before any rewrite. */
  steps: number;
  baseModel?: string;
  baseEffort?: Effort;
  /** What was sent, when the mod changed it. */
  sentEffort?: Effort;
  /** Effort levels added after failed tool calls. */
  escalated?: number;
  /** Its first request wrote the whole context to the cache (model switch, cold cache, after a compaction). */
  rewroteCache?: boolean;
};

export type SubState = {
  tier: Tier;
  /** Running on the light model: no effort is sent (it has none), and it moves up when the task grows. */
  light?: boolean;
  /** The model every step runs on after a light subagent moved up (the engine keeps asking for the spawn's). */
  model?: string;
  effort: Effort;
  agent?: string;
  errors: number;
  steps: number;
  escalated?: number;
  /** What the subagent would have run on without the mod. */
  baseModel?: string;
  baseEffort?: Effort;
  /** Its task (clipped): what Jev is told the subagent is doing when it judges one of its outputs. */
  task?: string;
};

/** A spawn whose subagent id is not known yet (its first steps can run before `next` resolves). */
export type PendingSpawn = { promptKey: string; sub: SubState; at: number };

export const S = {
  cfg: DEFAULT_CONFIG as GovernorConfig,
  cfgMtime: -1,
  /** Language of the mod's messages (`ui.language`, 'auto' resolved). */
  lang: 'en' as Lang,
  data: '',
  home: '',
  key: undefined as string | undefined,
  session: 'unknown',
  project: '',
  /** The session's project root (`$.session.root()`), not the shell's current folder. */
  cwd: '',
  route: { freeSwitch: true } as Route,
  /** Per chat, kept in the store: `off` — the mod does nothing here; `idle` — compact after a pause here. */
  chat: { off: false, idle: false },
  turn: undefined as TurnState | undefined,
  subs: new Map<string, SubState>(),
  agents: new Map<string, AgentRecord>(),
  skills: new Map<string, SkillRecord>(),
  registrySig: '',
  pending: [] as PendingSpawn[],
  ledgerLines: new Map<string, string[]>(),
  ledgerChain: Promise.resolve() as Promise<void>,
  compacting: false,
  draftsBusy: false,
  describeBusy: false,
  /** Drafting a specialist, one at a time: parallel spawns wait and may reuse what was just drafted. */
  draftLock: Promise.resolve() as Promise<void>,
  /** tool_use_id → the call, so a result row knows its tool and command. */
  /** Tool calls by id; `persisted` is where Claude Code saved a Bash output too big to inline. */
  calls: new Map<string, { tool: string; command?: string; agentId?: string; persisted?: string }>(),
  /** Fires when the prompt cache would expire while the session is idle. */
  idleTimer: undefined as { cancel: () => void } | undefined,
  /** Why the compaction in flight was started by us (`return`: after the cache expired). */
  compactReason: undefined as 'threshold' | 'return' | undefined,
  /** The auto-compaction window the mod set for this process (`compaction.autoWindowTokens`); undefined when it did not. */
  autoWindow: undefined as number | undefined,
  /** `<session>@<version>` whose window was logged (once per session and loaded version). */
  autoWindowLogged: undefined as string | undefined,
  /** How it was started: the API, or `/compact` where the API is unavailable (the desktop app). */
  compactVia: undefined as 'api' | 'command' | undefined,
  /** When the main loop last sent a request (prompt cache warmth for the handoff brief). */
  lastMainStepAt: undefined as number | undefined,
  /** `/jevg getctx` waiting for the brief turn it submitted. */
  handoff: undefined as Handoff | undefined,
  /** `/jevg ctx`: the capsule to attach to the next prompt. */
  attachNext: undefined as string | undefined,
  /** `/jevg fresh` between the capsule and the cleared chat (`from`: the chat being cleared). */
  clearing: undefined as { id: string; from: string } | undefined,
  /** Prompts the person typed while `/jevg fresh` was under way: they go in after it. */
  held: [] as string[],
  /** Main turns so far, and the one that last showed the new-topic hint. */
  mainTurns: 0,
  hintTurn: -Infinity,
  /** The binding to the session in flight (session.start, or the first hook after a hot reload). */
  initializing: undefined as Promise<void> | undefined,
  /** Jev requests that failed in a row (`jev ✕` in the status line from JEV_FAILS_SHOWN). */
  jevFailures: 0,
  /** The conversation ended (`/clear`, a resume) and the process goes on under another session id. */
  sessionEnded: false,
};

export type Handoff = {
  id: string;
  focus: string;
  turnId?: string;
  timer?: { cancel: () => void };
  /** `/jevg fresh`: clear this chat once the capsule is made and attach it to the next prompt. */
  fresh?: boolean;
};

/** What a capsule's sidecar file (handoffs/<id>.json) holds. */
export type CapsuleRecord = CapsuleMeta & {
  title: string;
  tokens: number;
  sourceTokens?: number;
  turns: number;
  brief: boolean;
  jev: boolean;
  path: string;
  /** Sessions it was attached to. */
  attached: string[];
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Whether the mod works in this chat: enabled in the config and not switched off for the chat (`/jevg chat off`). */
export function active(): boolean {
  return S.cfg.enabled && !S.chat.off;
}

/** Compaction after a pause: the setting, or switched on for this chat (`/jevg idle on`). */
export function idleCompaction(): boolean {
  return S.cfg.compaction.onReturn || S.chat.idle;
}

/** Shadow mode: decide and log, change nothing. */
export function shadow(): boolean {
  return isShadow(S.cfg, S.cwd, S.home);
}

/** The OpenRouter key, unless this project is excluded from Jev (then nothing goes out). */
export function jevKey(): string | undefined {
  return S.key && !S.chat.off && !isExcluded(S.cfg, S.cwd, S.home) ? S.key : undefined;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What a finished turn would have run on without the mod, for the savings report.
 * A turn the mod did not route (excluded project, no key, a /jevg fresh brief) ran
 * on its own model: `baseModel` is that model, so the report finds no saving in it
 * (an entry without any base reads as an old one and is compared with the assumed base).
 */
export function usageBase(
  agentId: string | undefined,
  ranModel: string,
): Pick<LedgerEntry, 'baseModel' | 'baseEffort' | 'effort' | 'steps' | 'escalated' | 'unrouted'> {
  if (agentId !== undefined) {
    const sub = S.subs.get(agentId);
    return sub
      ? { baseModel: sub.baseModel ?? ranModel, baseEffort: sub.baseEffort, effort: sub.effort, steps: sub.steps || undefined, escalated: sub.escalated || undefined }
      : { baseModel: ranModel, unrouted: true };
  }
  const turn = S.turn;
  return turn
    ? { baseModel: turn.baseModel ?? ranModel, baseEffort: turn.baseEffort, effort: turn.sentEffort, steps: turn.steps || undefined, escalated: turn.escalated || undefined }
    : { baseModel: ranModel, unrouted: true };
}

/**
 * Folds a finished main turn into the session's running turn profile. The profile
 * is what every later turn costs (switchEconomics multiplies it by the turns ahead),
 * so a turn that re-wrote the whole context adds its output only: one cold return
 * at 150k would otherwise lift the cache write fourfold and make a downgrade on a
 * warm cache look worth it.
 */
export function learnTurn(usage: { output_tokens: number; cache_creation_input_tokens: number }, rewroteCache = false): void {
  const prev = S.route.turnProfile ?? (rewroteCache ? DEFAULT_TURN : undefined);
  const w = 0.3;
  const write = rewroteCache ? prev!.cacheWrite : usage.cache_creation_input_tokens;
  // One very long turn (a 159-step one wrote 404k) moves the profile at most to 3× where it was,
  // so it cannot make every switch look worth it for the turns after.
  const sample = (value: number, was: number): number => Math.min(value, was * 3);
  S.route.turnProfile = prev
    ? {
        output: Math.round(prev.output * (1 - w) + sample(usage.output_tokens, prev.output) * w),
        cacheWrite: Math.round(prev.cacheWrite * (1 - w) + sample(write, prev.cacheWrite) * w),
      }
    : { output: usage.output_tokens, cacheWrite: usage.cache_creation_input_tokens };
}

export function statusText(model: string, effort: string | undefined, pressureText: string): string {
  return `jev ▸ ${displayModel(model)}${effort ? `·${effort}` : ''}${pressureText ? ` │ ${pressureText}` : ''}`;
}

export type SpawnPlan = {
  rate: Rate;
  prompt: string;
  model?: string;
  decision?: Decision;
  agent?: AgentRecord;
  created: boolean;
  signals?: Signals;
  pressure: Pressure;
  jevMs?: number;
  jevCost?: number;
};

/** What identifies a spawn's task in its subagent's first message. */
export function promptKey(prompt: string): string {
  return prompt.trim().slice(0, 160);
}

// ------------------------------------------------------------- trimming --

export function outputsDir(): string {
  return `${S.data}/outputs/${S.session}`;
}

/** The calls a compaction's decisions drop or truncate. */
export function prunedOf(original: readonly Message[], decisions: readonly CallDecision[]): PrunedCall[] {
  const calls = collectToolCalls(original, Math.max(0, Math.floor(S.cfg.compaction.preserveRecentMessages)));
  return prunedCalls(original, decisions, calls);
}

/** Remembers what a main-loop compaction pruned, to notice when the model runs it again. */
export function rememberPruned(pruned: readonly PrunedCall[]): void {
  const keys = { ...(S.route.pruned ?? {}) };
  for (const call of pruned) {
    const key = rerunKey(call.tool, call.input);
    if (key) keys[key] = callLabel(call.tool, call.input, 160);
  }
  const entries = Object.entries(keys);
  S.route.pruned = Object.fromEntries(entries.slice(-500));
}

/** The text of a tool_result block, or undefined when it holds media (left alone). */
export function resultText(block: Record<string, unknown>): string | undefined {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content as Record<string, unknown>[]) {
    if (item.type !== 'text' || typeof item.text !== 'string') return undefined;
    parts.push(item.text);
  }
  return parts.join('\n');
}

// ------------------------------------------------------------- handoff --

export function handoffDir(): string {
  return `${S.data}/handoffs`;
}

export function kTokens(tokens: number | undefined): string {
  return tokens === undefined ? '?' : `${Math.round(tokens / 100) / 10}k`;
}

/** The main loop sent a request recently enough that its prompt cache is still warm. */
export function cacheWarm(): boolean {
  return S.lastMainStepAt !== undefined && Date.now() - S.lastMainStepAt < (S.cfg.router.cacheTtlMinutes - 2) * 60_000;
}

/** A message of the mod in the language of this chat: `L('по-русски', 'in English')`. */
export const L = (ru: string, en: string): string => (S.lang === 'ru' ? ru : en);
