import { reactive } from 'vue';

import type {
  AgentRecord,
  DraftRecord,
  GovernorConfig,
  LedgerEntry,
  LedgerKind,
  MergeRequest,
  ProjectCommandRecord,
  ProjectRecord,
  SkillRecord,
} from '../../hooks/lib/types.ts';
import type { SavingEvent, SavingSource, SavingsReport } from '../../hooks/lib/savings.ts';
import { lang, t } from './i18n/index.ts';

export type AgentView = AgentRecord & { stats: { uses: number; lastUsedAt: string | null } };
/** The last request to fold near-copy agents together; `none` when there was none. */
export type MergeRecord = MergeRequest | { status: 'none' };
export type SkillView = SkillRecord & { usedBy: string[] };
export type KeyStatus = {
  found: boolean;
  source: 'env' | 'keyFile' | 'pluginRoot' | null;
  path: string | null;
  /** Where «Сохранить ключ» writes (config.jev.keyFile, expanded). */
  keyFile: string;
};
export type KeySaved = { found: true; source: 'keyFile'; path: string; activeSource: KeyStatus['source'] };
export type JevTest = { ok: true; ms: number; noul: number; cost: number | null } | { ok: false; error: string };

export type CompactReason = 'engine' | 'threshold' | 'return' | 'window';
export type TrimOutcome = 'passed' | 'failed' | 'build-error' | 'error' | 'unknown';
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type ByModel<T> = { sonnet: T; opus: T; other: T };
export type Stats = {
  days: number;
  entries: number;
  turns: { count: number; shadow: number; byModel: ByModel<number>; byEffort: Record<string, number>; switches: number };
  subagents: {
    count: number;
    shadow: number;
    byModel: ByModel<number>;
    byAgent: { agent: string; count: number }[];
    created: number;
  };
  rate: { fiveHour: number | null; sevenDay: number | null; ts: string | null };
  usage: { main: ByModel<Tokens>; subagent: ByModel<Tokens> };
  jev: { requests: number; cost: number; avgMs: number };
  compactions: {
    ok: number;
    fallback: number;
    avgRatio: number;
    byReason: Record<CompactReason, number>;
    /** Of them, inside subagents. */
    subagent: number;
    /** Average context per model request, main chat and subagents. */
    contextPerRequest: { main: number; subagent: number };
  };
  trims: {
    /** All trim entries: applied + shadow + skipped. */
    count: number;
    applied: number;
    shadow: number;
    /** Qualified, but a trim would have removed too little: the output stayed whole. */
    skipped: number;
    /** Outputs Jev judged data, not a log: kept whole. */
    logsData?: number;
    /** Sums below cover applied trims only. */
    charsBefore: number;
    charsAfter: number;
    saved: number;
    savedPct: number;
    /** Omitted middle parts Jev put back. */
    jevChunks: number;
    byOutcome: Record<TrimOutcome, number>;
  };
  errors: number;
  agentsCreated: number;
  /** The savings report in short, for the overview card (see `SavingsView`). */
  savings: SavingsBrief;
};

export type { SavingEvent, SavingSource };
/** Dollars (API-equivalent). `jev` is a positive cost; `net` = exact + estimated − jev. */
export type SavingsBrief = { exact: number; estimated: number; jev: number; net: number; actual: number; withoutMod: number };
export type SavingsRow = { exact: number; estimated: number; jev: number; actual: number };
export type SavingsView = {
  days: number;
  /** The project id the report is limited to; null = everything. */
  project: string | null;
  totals: SavingsReport['totals'];
  /** The part of each source's total that is an estimate. */
  estimatedBySource: Record<SavingSource, number>;
  byDay: SavingsReport['byDay'];
  /** All events in the period; `events` holds the newest 500. */
  eventCount: number;
  events: SavingEvent[];
  /** Per project folder name ('' = unknown); absent when the report is limited to one project. */
  byProject?: Record<string, SavingsRow>;
};

/** What the editors send: the server fills origin and timestamps. `tools: null` = all tools. */
export type AgentInput = Pick<AgentRecord, 'name' | 'description' | 'prompt' | 'skills' | 'tier' | 'effort' | 'enabled'> & {
  tools?: string[] | null;
};
export type SkillInput = Pick<SkillRecord, 'name' | 'description' | 'body'>;

export type { AgentRecord, DraftRecord, GovernorConfig, LedgerEntry, LedgerKind, ProjectCommandRecord, ProjectRecord, SkillRecord };

export type CommandGroup = ProjectCommandRecord['group'];
export type ProjectSummary = {
  id: string;
  name: string;
  path: string;
  exists: boolean;
  isWorktree: boolean;
  sessions: number;
  lastActivity: string;
  /** Commands in the stored record, hidden ones not counted; 0 until the first scan. */
  commandCount: number;
  /** null: the project page has not been opened (scanned) yet. */
  scannedAt: string | null;
  favorite: boolean;
};

export type GitInfo = {
  branch: string | null;
  changed: number | null;
  lastCommit: { subject: string; at: string | null; ago: string | null } | null;
} | null;
export type ProjectStats = {
  days: number;
  entries: number;
  sessions: number;
  turns: { count: number; shadow: number; sonnet: number; opus: number; other: number };
  subagents: { count: number; shadow: number };
  jevCost: number;
  learnedCommands: number;
  lastActivity: string | null;
};
export type DescribeState = {
  /** `projects.describeWithClaude` is on. */
  enabled: boolean;
  status: 'idle' | 'pending' | 'working' | 'error';
  error?: string;
  pendingCount: number;
};
export type ProjectView = {
  project: ProjectRecord & { exists: boolean; isWorktree: boolean; sessions: number; lastActivity: string };
  git: GitInfo;
  stats: ProjectStats;
  describe: DescribeState;
  terminal: string;
};
/** A command a person adds: the server fills id, source and timestamps. */
export type CommandInput = { command: string; dir?: string; group: CommandGroup; description?: string };
/** Edits of one command; `description: ''` returns it to the automatic one, `command`/`dir` only for manual commands. */
export type CommandPatch = Partial<{
  description: string;
  group: CommandGroup;
  pinned: boolean;
  hidden: boolean;
  favorite: boolean;
  command: string;
  dir: string;
}>;

export type Toast = { id: number; kind: 'error' | 'ok'; message: string };
export const toasts = reactive<Toast[]>([]);
export const connection = reactive({ ok: true });
let toastId = 0;

export function notify(message: string, kind: Toast['kind'] = 'ok'): void {
  const id = ++toastId;
  toasts.push({ id, kind, message });
  setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 3500);
}

export function dismiss(id: number): void {
  const i = toasts.findIndex((t) => t.id === id);
  if (i >= 0) toasts.splice(i, 1);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Options = { body?: unknown; quiet?: boolean };

async function request<T>(method: string, url: string, options: Options = {}): Promise<{ data: T; headers: Headers }> {
  const mutating = method !== 'GET';
  const headers: Record<string, string> = { accept: 'application/json', 'X-Jev-Lang': lang.value };
  if (mutating) {
    headers['X-Jev-Governor'] = '1';
    headers['Content-Type'] = 'application/json';
  }
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: mutating && options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    connection.ok = true;
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!response.ok) {
      const message =
        typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
          ? data.error
          : t('Error {status}', { status: response.status });
      throw new ApiError(response.status, message);
    }
    return { data: data as T, headers: response.headers };
  } catch (error) {
    if (error instanceof ApiError) {
      if (!options.quiet) notify(error.message, 'error');
      throw error;
    }
    connection.ok = false;
    const failure = new ApiError(0, t('No connection to the jev-governor server.'));
    if (!options.quiet) notify(failure.message, 'error');
    throw failure;
  }
}

const get = async <T>(url: string, quiet = false): Promise<T> => (await request<T>('GET', url, { quiet })).data;
const send = async <T>(method: string, url: string, body?: unknown): Promise<T> =>
  (await request<T>(method, url, { body })).data;
const seg = encodeURIComponent;

export const api = {
  health: () => get<{ ok: true; data: string; version: string }>('/api/health', true),
  config: () => get<GovernorConfig>('/api/config'),
  saveConfig: (patch: unknown) => send<GovernorConfig>('PUT', '/api/config', patch),
  resetConfig: () => send<GovernorConfig>('POST', '/api/config/reset', {}),
  key: () => get<KeyStatus>('/api/key'),
  saveKey: (key: string) => send<KeySaved>('PUT', '/api/key', { key }),
  testJev: () => send<JevTest>('POST', '/api/jev/test', {}),

  agents: () => get<AgentView[]>('/api/agents'),
  createAgent: (agent: AgentInput) => send<AgentRecord>('POST', '/api/agents', agent),
  updateAgent: (name: string, patch: Partial<AgentInput>) => send<AgentRecord>('PUT', `/api/agents/${seg(name)}`, patch),
  deleteAgent: (name: string) => send<{ ok: true }>('DELETE', `/api/agents/${seg(name)}`),

  skills: () => get<SkillView[]>('/api/skills'),
  createSkill: (skill: SkillInput) => send<SkillRecord>('POST', '/api/skills', skill),
  updateSkill: (name: string, patch: Partial<SkillInput>) => send<SkillRecord>('PUT', `/api/skills/${seg(name)}`, patch),
  deleteSkill: (name: string) => send<{ ok: true }>('DELETE', `/api/skills/${seg(name)}`),

  merge: () => get<MergeRecord>('/api/merge', true),
  requestMerge: () => send<MergeRecord>('POST', '/api/merge'),
  createDraft: (description: string) => send<DraftRecord>('POST', '/api/drafts', { description }),
  draft: (id: string, quiet = true) => get<DraftRecord>(`/api/drafts/${seg(id)}`, quiet),
  deleteDraft: (id: string) => send<{ ok: true }>('DELETE', `/api/drafts/${seg(id)}`),
  acceptDraft: (id: string, edited: { agent: AgentInput; skills: SkillInput[] }) =>
    send<{ agent: AgentRecord; skills: SkillRecord[] }>('POST', `/api/drafts/${seg(id)}/accept`, edited),

  async ledger(days: number, limit: number, kind?: LedgerKind, quiet = true) {
    const query = new URLSearchParams({ days: String(days), limit: String(limit) });
    if (kind) query.set('kind', kind);
    const { data, headers } = await request<LedgerEntry[]>('GET', `/api/ledger?${query}`, { quiet });
    return { entries: data, total: Number(headers.get('x-total-count') ?? data.length) };
  },
  stats: (days: number) => get<Stats>(`/api/stats?days=${days}`, true),
  savings: (days: number, project?: string) =>
    get<SavingsView>(`/api/savings?days=${days}${project ? `&project=${seg(project)}` : ''}`, true),

  projects: () => get<ProjectSummary[]>('/api/projects?all=1'),
  project: (id: string, quiet = false) => get<ProjectView>(`/api/projects/${seg(id)}`, quiet),
  setProjectFavorite: (id: string, favorite: boolean) => send<{ favorite: boolean }>('PUT', `/api/projects/${seg(id)}`, { favorite }),
  scanProject: (id: string) => send<ProjectView>('POST', `/api/projects/${seg(id)}/scan`, {}),
  addCommand: (id: string, input: CommandInput) =>
    send<{ command: ProjectCommandRecord }>('POST', `/api/projects/${seg(id)}/commands`, input),
  updateCommand: (id: string, cid: string, patch: CommandPatch) =>
    send<{ command: ProjectCommandRecord }>('PUT', `/api/projects/${seg(id)}/commands/${seg(cid)}`, patch),
  deleteCommand: (id: string, cid: string) =>
    send<{ ok: true; removed: boolean; command?: ProjectCommandRecord }>('DELETE', `/api/projects/${seg(id)}/commands/${seg(cid)}`),
  openProject: (id: string, target: 'finder' | 'terminal') =>
    send<{ ok: true }>('POST', `/api/projects/${seg(id)}/open`, { target }),
  /** Runs the command stored under `cid` in Terminal.app; nothing but the ids is sent. */
  runCommand: (id: string, cid: string) =>
    send<{ ok: true }>('POST', `/api/projects/${seg(id)}/commands/${seg(cid)}/run`, {}),
};
