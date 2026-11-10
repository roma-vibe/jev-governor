// The Mnema memory service, spoken to directly over its HTTP API. Pure: the caller gives the
// `http` function (the engine's `$.http.fetch` in the mod, `fetch` in the UI server).
//
// Why not through the engine's MCP connection, as before 0.3.16: the mod's own `$.mcp.call` went
// through the session's permission mode (in auto mode the classifier refused `list_facts`, so a
// third of the saves failed), through the mod's own tool hooks, and through the MCP server's own
// idea of which project the session is in (its process folder, fixed at start). In four weeks
// every recall the mod made that way came back empty. Over HTTP the mod names the memories itself.
//
// A memory is a Mnema "user": `dev.<login>` is the person's (it follows them into every project),
// `repo.<host>.<owner>.<name>` a project's (from the git remote, so every checkout shares it), and
// `repo.local.<folder>-<hash>` a project without a remote. The ids are built exactly as the
// mnema-mcp server builds them (its scope.py), so the model's own memory tools and the mod read
// and write the same memories.

export type Http = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; text: string }>;

export type MnemaConfig = { base: string; key: string };

/** A stored fact as the service returns it (the parts the mod and the UI use). */
export type MnemaFact = {
  id: string;
  text: string;
  kind: string;
  tags: string[];
  status: string;
  pinned: boolean;
  importance?: { level?: string };
  createdAt: string;
  updatedAt: string;
};

export type MnemaStats = { factsActive: number; factsTotal: number; messages: number; threads: number };

export const FACT_TYPES = ['decision', 'convention', 'architecture', 'bug', 'gotcha', 'workflow', 'preference', 'reference', 'context'] as const;
export type FactType = (typeof FACT_TYPES)[number];
export type Importance = 'core' | 'high' | 'normal' | 'low';

/** The service's limit for one fact's text. */
export const MAX_FACT_CHARS = 300;
/** The tag of a chat's note (what a chat did and left open), and the prefix of the tag naming the chat. */
export const SESSION_TAG = 'session';
export const CHAT_TAG = 'chat-';

// ------------------------------------------------------------------- ids --

/** SHA-1 of a text (UTF-8), hex. Pure JS: the mod's module has no node imports. */
export function sha1Hex(text: string): string {
  const bytes: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  const bits = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bits / 2 ** 32);
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (bits >>> 24) & 255, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Array<number>(80);
  const rol = (x: number, n: number): number => ((x << n) | (x >>> (32 - n))) >>> 0;
  for (let i = 0; i < bytes.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = ((bytes[i + t * 4]! << 24) | (bytes[i + t * 4 + 1]! << 16) | (bytes[i + t * 4 + 2]! << 8) | bytes[i + t * 4 + 3]!) >>> 0;
    for (let t = 16; t < 80; t++) w[t] = rol((w[t - 3]! ^ w[t - 8]! ^ w[t - 14]! ^ w[t - 16]!) >>> 0, 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const temp = (rol(a, 5) + (f >>> 0) + e + k + w[t]!) >>> 0;
      e = d;
      d = c;
      c = rol(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, '0')).join('');
}

/** Lowercase, only `[a-z0-9._@-]`, no leading dot or dash, short enough for an id (a hash marks a cut). */
export function sanitize(text: string, maxLen = 120): string {
  let cleaned = text.trim().toLowerCase().replace(/[^a-z0-9._@-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').replace(/-{2,}/g, '-');
  if (cleaned.length > maxLen) {
    const digest = sha1Hex(cleaned).slice(0, 8);
    cleaned = `${cleaned.slice(0, maxLen - 9).replace(/[-.]+$/, '')}-${digest}`;
  }
  return cleaned || 'unnamed';
}

/** `git@GitHub.com:Acme/Shop.git` and `https://token@github.com/acme/shop` both give `github.com/acme/shop`. */
export function normalizeRemote(url: string): string | undefined {
  const u = url.trim();
  if (!u) return undefined;
  let hostPath: string;
  if (u.includes('://')) {
    const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:?#]*)(?::\d+)?([^?#]*)/i.exec(u);
    if (!m || m[1]!.toLowerCase() === 'file' || !m[2]) return undefined;
    hostPath = `${m[2]}${m[3] ?? ''}`;
  } else {
    const m = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(u);
    if (!m) return undefined;
    hostPath = `${m[1]}/${m[2]}`;
  }
  hostPath = hostPath.toLowerCase().replace(/\/+$/, '');
  if (hostPath.endsWith('.git')) hostPath = hostPath.slice(0, -4);
  const segments = hostPath.split('/').filter(Boolean);
  return segments.length >= 2 ? segments.join('/') : undefined;
}

/** The person's memory: `dev.<login>` (or the name given in the settings). */
export function personalId(login: string, explicit = ''): string {
  return `dev.${explicit.trim() || sanitize(login || 'default')}`;
}

/** A project's memory id and where it came from. `named` is a `.mnema-mcp.toml` project, when the repository has one. */
export function projectId(input: { root: string; remote?: string; named?: string }): { id: string; source: 'file' | 'remote' | 'local' } {
  if (input.named?.trim()) return { id: `repo.${input.named.trim()}`, source: 'file' };
  const normalized = input.remote ? normalizeRemote(input.remote) : undefined;
  if (normalized) return { id: `repo.${sanitize(normalized.replace(/\//g, '.'))}`, source: 'remote' };
  const root = input.root.replace(/\/+$/, '') || '/';
  const folder = root.split('/').filter(Boolean).pop() ?? 'root';
  return { id: `repo.local.${sanitize(folder, 60)}-${sha1Hex(root).slice(0, 8)}`, source: 'local' };
}

/** `project = "name"` from a repository's `.mnema-mcp.toml` (the only key that file may set). */
export function namedProject(toml: string): string | undefined {
  const m = /^\s*project\s*=\s*["']([A-Za-z0-9._@-]{1,100})["']\s*(?:#.*)?$/m.exec(toml);
  return m && !m[1]!.startsWith('.') ? m[1] : undefined;
}

/** The origin remote (or the first one) from the text of a `.git/config`. */
export function remoteFromGitConfig(text: string): string | undefined {
  const remotes = new Map<string, string>();
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const header = /^\[remote "(.+)"\]$/.exec(line);
    if (header) section = header[1]!;
    else if (line.startsWith('[')) section = '';
    else if (section && /^url\s*=/.test(line) && !remotes.has(section)) remotes.set(section, line.slice(line.indexOf('=') + 1).trim());
  }
  return remotes.get('origin') ?? (remotes.size > 0 ? remotes.get([...remotes.keys()].sort()[0]!) : undefined);
}

/** The service's address and key from the mnema-mcp config file (`api_key = "…"`, `base_url = "…"`). */
export function readMcpConfig(toml: string): { key?: string; base?: string } {
  const pick = (name: string): string | undefined => new RegExp(`^\\s*${name}\\s*=\\s*["']([^"'\\n]+)["']`, 'm').exec(toml)?.[1]?.trim() || undefined;
  return { key: pick('api_key'), base: pick('base_url') };
}

/** A memory's name for people: the repository or folder name (`repo.github.com.acme.shop` → `shop`). */
export function memoryName(id: string): string {
  if (id.startsWith('dev.')) return id.slice(4);
  if (id.startsWith('repo.local.')) return id.slice(11).replace(/-[0-9a-f]{8}$/, '');
  return id.split('.').pop() ?? id;
}

export const isPersonal = (id: string): boolean => id.startsWith('dev.');
export const isLocal = (id: string): boolean => id.startsWith('repo.local.');

// ----------------------------------------------------------------- facts --

/** The coding type a fact was saved with (kept as a tag, as mnema-mcp does). */
export function factType(fact: Pick<MnemaFact, 'tags'>): FactType | undefined {
  return fact.tags.find((t): t is FactType => (FACT_TYPES as readonly string[]).includes(t));
}

/** The service's own kind for a coding type. */
export function kindFor(type: FactType): string {
  return type === 'convention' || type === 'workflow' || type === 'preference' ? 'preference' : 'project';
}

/** A fact's tags: its type first, then the extra ones, cleaned and without repeats. */
export function tagsFor(type: FactType, extra: readonly string[] = []): string[] {
  const seen: string[] = [type];
  for (const tag of extra) {
    const cleaned = tag.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (cleaned && !seen.includes(cleaned)) seen.push(cleaned);
  }
  return seen.slice(0, 8);
}

export const isSessionNote = (fact: Pick<MnemaFact, 'tags'>): boolean => fact.tags.includes(SESSION_TAG);
export const isAuto = (fact: Pick<MnemaFact, 'tags'>): boolean => fact.tags.includes('auto');
/** The tag that ties a chat's note to its chat. */
export const chatTag = (session: string): string => `${CHAT_TAG}${session.replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase()}`;

const words = (s: string): Set<string> => new Set(s.toLowerCase().match(/[\p{L}\p{N}_./-]{3,}/gu) ?? []);

/** Whether two texts say the same thing closely enough to be one fact (shared words over the smaller set). */
export function sameFact(a: string, b: string, threshold = 0.8): boolean {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / Math.min(x.size, y.size) >= threshold;
}

// ------------------------------------------------------------------- API --

export class MnemaError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const seg = (s: string): string => encodeURIComponent(s);

function asFact(raw: unknown): MnemaFact | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.text !== 'string') return undefined;
  const importance = typeof r.importance === 'object' && r.importance !== null ? (r.importance as { level?: unknown }) : undefined;
  return {
    id: r.id,
    text: r.text,
    kind: typeof r.kind === 'string' ? r.kind : '',
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [],
    status: typeof r.status === 'string' ? r.status : 'active',
    pinned: r.pinned === true,
    ...(importance && typeof importance.level === 'string' ? { importance: { level: importance.level } } : {}),
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
  };
}

const facts = (list: unknown): MnemaFact[] => (Array.isArray(list) ? list.map(asFact).filter((f): f is MnemaFact => f !== undefined) : []);

/** The calls the mod and the UI make. Every one rejects with a MnemaError (the service's words) or the transport's error. */
export function mnema(http: Http, config: MnemaConfig) {
  const base = config.base.replace(/\/+$/, '');
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await http(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${config.key}`, 'x-client': 'jev-governor', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let data: unknown;
    try {
      data = response.text ? JSON.parse(response.text) : undefined;
    } catch {
      data = undefined;
    }
    if (!response.ok) {
      const e = (data as { error?: { message?: unknown } | string } | undefined)?.error;
      const said = typeof e === 'string' ? e : typeof e?.message === 'string' ? e.message : response.text.slice(0, 200);
      throw new MnemaError(response.status, `memory service ${response.status}${said ? `: ${said}` : ''}`);
    }
    return data;
  };
  const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
  return {
    /** Every memory this key holds (the person's and the projects'). */
    users: async (): Promise<string[]> => {
      const list = obj(await call('GET', '/v1/users?limit=1000')).users;
      return Array.isArray(list) ? list.filter((u): u is string => typeof u === 'string') : [];
    },
    stats: async (id: string): Promise<MnemaStats> => {
      const s = obj(obj(await call('GET', `/v1/users/${seg(id)}`)).stats);
      const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      return { factsActive: n(s.factsActive), factsTotal: n(s.factsTotal), messages: n(s.messages), threads: n(s.threads) };
    },
    /** The facts relevant to a task, best first (meaning-based; no model call of the service's own). */
    recall: async (id: string, task: string, mode: 'economy' | 'moderate' | 'maximum' = 'economy'): Promise<MnemaFact[]> =>
      facts(obj(await call('POST', `/v1/users/${seg(id)}/recall`, { message: task.slice(0, 2000), mode, instructions: false })).facts),
    facts: async (id: string, options: { status?: string; limit?: number; offset?: number } = {}): Promise<{ facts: MnemaFact[]; total: number }> => {
      const q = `status=${seg(options.status ?? 'active')}&limit=${options.limit ?? 500}&offset=${options.offset ?? 0}`;
      const data = obj(await call('GET', `/v1/users/${seg(id)}/facts?${q}`));
      const list = facts(data.facts);
      return { facts: list, total: typeof data.total === 'number' ? data.total : list.length };
    },
    addFact: async (id: string, input: { text: string; type: FactType; tags?: readonly string[]; importance?: Importance; pinned?: boolean }): Promise<MnemaFact> => {
      const fact = asFact(
        await call('POST', `/v1/users/${seg(id)}/facts`, {
          text: input.text.replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_CHARS),
          kind: kindFor(input.type),
          tags: tagsFor(input.type, input.tags),
          pinned: input.pinned === true,
          importance: input.importance ?? 'normal',
        }),
      );
      if (!fact) throw new MnemaError(502, 'memory service answered without the fact');
      return fact;
    },
    patchFact: async (id: string, factId: string, patch: { text?: string; tags?: string[]; kind?: string; importance?: Importance; pinned?: boolean; status?: string }): Promise<MnemaFact> => {
      const fact = asFact(await call('PATCH', `/v1/users/${seg(id)}/facts/${seg(factId)}`, patch));
      if (!fact) throw new MnemaError(502, 'memory service answered without the fact');
      return fact;
    },
    /** Retires a fact (it stays in the history); `hard` erases it. */
    deleteFact: async (id: string, factId: string, hard = false): Promise<void> => {
      await call('DELETE', `/v1/users/${seg(id)}/facts/${seg(factId)}${hard ? '?hard=true' : ''}`);
    },
    search: async (id: string, query: string, limit = 8): Promise<{ id: string; text: string; score: number }[]> => {
      const hits = obj(await call('POST', `/v1/users/${seg(id)}/search`, { query: query.slice(0, 2000), limit, kinds: ['facts'] })).hits;
      return Array.isArray(hits)
        ? hits.flatMap((h) => {
            const r = obj(h);
            return typeof r.id === 'string' && typeof r.text === 'string' ? [{ id: r.id, text: r.text, score: typeof r.score === 'number' ? r.score : 0 }] : [];
          })
        : [];
    },
  };
}

export type Mnema = ReturnType<typeof mnema>;
