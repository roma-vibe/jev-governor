// The memory tab's side of the server: the person's memory and the projects' memories, read from
// and written to the Mnema service with the same client the mod uses (hooks/lib/mnema.ts), plus
// the registry of projects the mod keeps (memory/projects.json: names, folders, older ids,
// related projects). The service's key never leaves this process.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expandHome } from '../../hooks/lib/config.ts';
import { findProject, link, mergeProjects, readRegistry, syncMemories, unlink, type MemRegistry } from '../../hooks/lib/memreg.ts';
import {
  FACT_TYPES,
  factType,
  isAuto,
  isLocal,
  isPersonal,
  isSessionNote,
  MAX_FACT_CHARS,
  memoryName,
  mnema,
  MnemaError,
  personalId,
  readMcpConfig,
  type FactType,
  type Importance,
  type Mnema,
  type MnemaFact,
} from '../../hooks/lib/mnema.ts';
import type { GovernorConfig, LedgerEntry } from '../../hooks/lib/types.ts';
import { tr } from './i18n.ts';
import type { FactView, MemoryOverview, MemoryProjectView } from './memory-types.ts';

export type { FactView, MemoryOverview, MemoryProjectView };

export type MemoryDeps = {
  data: string;
  home: string;
  loadConfig: () => Promise<GovernorConfig>;
  loadLedger: (days: number) => Promise<LedgerEntry[]>;
  readJson: (file: string) => Promise<unknown>;
  writeJson: (file: string, value: unknown) => Promise<void>;
  withLock: <T>(fn: () => T | Promise<T>) => Promise<T>;
  HttpError: new (status: number, message: string) => Error;
  /** The login the person's memory is named after; the system's by default. */
  login?: string;
  fetchImpl?: typeof fetch;
};

const ID_RE = /^(dev|repo)\.[A-Za-z0-9._@-]{1,150}$/;
const IMPORTANCE: readonly Importance[] = ['core', 'high', 'normal', 'low'];

const view = (memory: string, f: MnemaFact): FactView => ({
  id: f.id,
  memory,
  text: f.text,
  type: factType(f) ?? null,
  tags: f.tags,
  importance: (IMPORTANCE as readonly string[]).includes(f.importance?.level ?? '') ? (f.importance!.level as Importance) : 'normal',
  pinned: f.pinned,
  status: f.status,
  auto: isAuto(f),
  session: isSessionNote(f),
  createdAt: f.createdAt,
  updatedAt: f.updatedAt,
});

export function createMemory(deps: MemoryDeps) {
  const { data, home, loadConfig, loadLedger, readJson, writeJson, withLock, HttpError } = deps;
  const regFile = path.join(data, 'memory', 'projects.json');
  const doFetch = deps.fetchImpl ?? fetch;

  async function connect(): Promise<{ api: Mnema | undefined; url: string; keyFile: string }> {
    const m = (await loadConfig()).memory;
    const keyFile = expandHome(m.keyFile, home);
    let key = process.env.MNEMA_API_KEY?.trim() || undefined;
    let base = m.url || undefined;
    try {
      const text = await fs.readFile(keyFile, 'utf8');
      const parsed = readMcpConfig(text);
      key ??= parsed.key ?? (/^[\w.-]{16,}$/.test(text.trim()) ? text.trim() : undefined);
      base ??= parsed.base;
    } catch {
      // no file: the environment's key, or none
    }
    const url = base ?? 'http://127.0.0.1:8787';
    if (!key) return { api: undefined, url, keyFile };
    const api = mnema(
      async (target, init) => {
        const response = await doFetch(target, { ...init, signal: AbortSignal.timeout(10_000) });
        return { status: response.status, ok: response.ok, text: await response.text() };
      },
      { base: url, key },
    );
    return { api, url, keyFile };
  }

  /** The service's client, or an HTTP error the page can show. */
  async function service(): Promise<Mnema> {
    const c = await connect();
    if (!c.api) throw new HttpError(503, tr(`No key for the memory service (${c.keyFile}).`, `Нет ключа сервиса памяти (${c.keyFile}).`));
    return c.api;
  }

  /** Turns the service's refusals and outages into errors with a status and the service's words. */
  async function ask<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof MnemaError) throw new HttpError(error.status >= 500 ? 502 : error.status === 404 ? 404 : 400, error.message);
      throw new HttpError(503, tr('The memory service does not answer. Start it and try again.', 'Сервис памяти не отвечает. Запустите его и повторите.'));
    }
  }

  const loadReg = async (): Promise<MemRegistry> => readRegistry(await readJson(regFile).catch(() => undefined));
  const saveReg = async (reg: MemRegistry): Promise<void> => {
    await fs.mkdir(path.dirname(regFile), { recursive: true });
    await writeJson(regFile, reg);
  };

  const personal = async (): Promise<string> => personalId(deps.login ?? os.userInfo().username, (await loadConfig()).memory.personal);

  function checkId(id: unknown): string {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new HttpError(400, tr('Invalid memory id.', 'Недопустимый id памяти.'));
    return id;
  }

  async function activity(days: number): Promise<MemoryOverview['activity']> {
    const out = { days, recalls: 0, recallsWithNotes: 0, notes: 0, saves: 0, factsSaved: 0, chatNotes: 0, failures: 0, lastError: null as string | null };
    for (const e of await loadLedger(days)) {
      const m = e.kind === 'memory' ? e.memory : undefined;
      if (!m) continue;
      if (m.action === 'recall' && (m.for === 'prompt' || m.for === 'subagent')) {
        out.recalls++;
        if ((m.facts ?? 0) > 0) out.recallsWithNotes++;
        out.notes += m.facts ?? 0;
      } else if (m.action === 'extract') {
        out.saves++;
        out.factsSaved += m.facts ?? 0;
        out.chatNotes += m.sessions ?? 0;
      }
      if (!m.ok && m.action !== 'refuse') {
        out.failures++;
        out.lastError = m.error ?? out.lastError;
      }
    }
    return out;
  }

  async function overview(): Promise<MemoryOverview> {
    const config = await loadConfig();
    const c = await connect();
    const base: MemoryOverview = {
      enabled: config.memory.enabled,
      configured: c.api !== undefined,
      reachable: false,
      error: null,
      url: c.url,
      keyFile: c.keyFile,
      personal: null,
      projects: [],
      activity: await activity(7),
    };
    if (!c.api) return base;
    const api = c.api;
    let users: string[];
    try {
      users = await api.users();
    } catch (error) {
      return { ...base, error: error instanceof MnemaError ? error.message : tr('The memory service does not answer.', 'Сервис памяти не отвечает.') };
    }
    const reg = await withLock(async () => {
      const r = await loadReg();
      if (syncMemories(r, users)) await saveReg(r);
      return r;
    });
    const mine = await personal();
    const count = new Map<string, number>();
    await Promise.all(
      [...new Set([mine, ...users])].map(async (id) => {
        try {
          count.set(id, (await api.stats(id)).factsActive);
        } catch {
          count.set(id, 0);
        }
      }),
    );
    const projects: MemoryProjectView[] = reg.projects
      .map((p) => ({
        id: p.id,
        name: p.name,
        names: p.names,
        roots: p.roots,
        aliases: p.aliases.map((id) => ({ id, facts: count.get(id) ?? 0 })),
        related: p.related,
        facts: (count.get(p.id) ?? 0) + p.aliases.reduce((n, id) => n + (count.get(id) ?? 0), 0),
        local: isLocal(p.id),
        seenAt: p.seenAt ?? null,
      }))
      .sort((a, b) => b.facts - a.facts || a.name.localeCompare(b.name));
    return { ...base, reachable: true, personal: { id: mine, facts: count.get(mine) ?? 0 }, projects };
  }

  /** A memory's facts; a project's include the ones in its older ids. */
  async function facts(id: string, all: boolean): Promise<{ id: string; facts: FactView[] }> {
    const api = await service();
    const reg = await loadReg();
    const entry = isPersonal(id) ? undefined : findProject(reg, id);
    const ids = entry ? [entry.id, ...entry.aliases] : [id];
    const status = all ? 'active,superseded,outdated,possible,archived,expired' : 'active';
    const lists = await ask(() => Promise.all(ids.map(async (memory) => (await api.facts(memory, { status, limit: 500 })).facts.map((f) => view(memory, f)))));
    return { id, facts: lists.flat().sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt)) };
  }

  function factInput(body: Record<string, unknown>, partial: boolean): { text?: string; type?: FactType; importance?: Importance; pinned?: boolean } {
    const out: { text?: string; type?: FactType; importance?: Importance; pinned?: boolean } = {};
    if (body.text !== undefined || !partial) {
      const text = typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
      if (text.length < 8) throw new HttpError(400, tr('A fact is one full sentence.', 'Факт — это одно полное предложение.'));
      if (text.length > MAX_FACT_CHARS) throw new HttpError(400, tr(`A fact holds at most ${MAX_FACT_CHARS} characters; this one has ${text.length}.`, `Факт вмещает не больше ${MAX_FACT_CHARS} символов; здесь ${text.length}.`));
      out.text = text;
    }
    if (body.type !== undefined || !partial) {
      if (!(FACT_TYPES as readonly unknown[]).includes(body.type)) throw new HttpError(400, tr('Unknown fact type.', 'Неизвестный тип факта.'));
      out.type = body.type as FactType;
    }
    if (body.importance !== undefined) {
      if (!(IMPORTANCE as readonly unknown[]).includes(body.importance)) throw new HttpError(400, tr('Unknown importance.', 'Неизвестная важность.'));
      out.importance = body.importance as Importance;
    }
    if (body.pinned !== undefined) {
      if (typeof body.pinned !== 'boolean') throw new HttpError(400, tr('“pinned” must be true or false.', '«pinned» должно быть true или false.'));
      out.pinned = body.pinned;
    }
    return out;
  }

  async function addFact(body: Record<string, unknown>): Promise<FactView> {
    const id = checkId(body.id);
    const input = factInput(body, false);
    const api = await service();
    return view(id, await ask(() => api.addFact(id, { text: input.text!, type: input.type!, importance: input.importance, pinned: input.pinned })));
  }

  async function patchFact(body: Record<string, unknown>): Promise<FactView> {
    const id = checkId(body.id);
    if (typeof body.factId !== 'string' || !body.factId) throw new HttpError(400, tr('No fact id.', 'Нет id факта.'));
    const input = factInput(body, true);
    const api = await service();
    return ask(async () => {
      let tags: string[] | undefined;
      let kind: string | undefined;
      if (input.type) {
        // The type is the fact's first tag; its other tags (auto, a chat's) stay.
        const current = (await api.facts(id, { status: 'active', limit: 500 })).facts.find((f) => f.id === body.factId);
        const rest = (current?.tags ?? []).filter((t) => !(FACT_TYPES as readonly string[]).includes(t));
        tags = [input.type, ...rest];
        kind = input.type === 'convention' || input.type === 'workflow' || input.type === 'preference' ? 'preference' : 'project';
      }
      const patch = { ...(input.text ? { text: input.text } : {}), ...(tags ? { tags, kind } : {}), ...(input.importance ? { importance: input.importance } : {}), ...(input.pinned !== undefined ? { pinned: input.pinned } : {}) };
      if (Object.keys(patch).length === 0) throw new HttpError(400, tr('Nothing to change.', 'Нечего менять.'));
      return view(id, await api.patchFact(id, body.factId as string, patch));
    });
  }

  async function removeFact(query: URLSearchParams): Promise<{ ok: true }> {
    const id = checkId(query.get('id'));
    const factId = query.get('factId');
    if (!factId) throw new HttpError(400, tr('No fact id.', 'Нет id факта.'));
    const api = await service();
    await ask(() => api.deleteFact(id, factId));
    return { ok: true };
  }

  /** Moves a fact to another memory (a project fact filed under the person, or the other way): saved there, retired here. */
  async function moveFact(body: Record<string, unknown>): Promise<FactView> {
    const from = checkId(body.from);
    const to = checkId(body.to);
    if (from === to) throw new HttpError(400, tr('The fact is already there.', 'Факт уже там.'));
    if (typeof body.factId !== 'string' || !body.factId) throw new HttpError(400, tr('No fact id.', 'Нет id факта.'));
    const api = await service();
    return ask(async () => {
      const fact = (await api.facts(from, { status: 'active', limit: 500 })).facts.find((f) => f.id === body.factId);
      if (!fact) throw new HttpError(404, tr('Fact not found.', 'Факт не найден.'));
      const type = factType(fact) ?? 'context';
      const saved = await api.addFact(to, {
        text: fact.text,
        type,
        tags: fact.tags.filter((t) => t !== type),
        importance: (IMPORTANCE as readonly string[]).includes(fact.importance?.level ?? '') ? (fact.importance!.level as Importance) : 'normal',
        pinned: fact.pinned,
      });
      await api.deleteFact(from, fact.id);
      return view(to, saved);
    });
  }

  /** Names a project and sets what it is related to (both ways). */
  async function updateProject(body: Record<string, unknown>): Promise<{ ok: true }> {
    const id = checkId(body.id);
    await withLock(async () => {
      const reg = await loadReg();
      const entry = reg.projects.find((p) => p.id === id);
      if (!entry) throw new HttpError(404, tr('Project not found in the memory.', 'Проект не найден в памяти.'));
      if (typeof body.name === 'string' && body.name.trim()) entry.name = body.name.trim().slice(0, 80);
      if (Array.isArray(body.related)) {
        const wanted = new Set(body.related.filter((r): r is string => typeof r === 'string').map((r) => findProject(reg, r)?.id).filter((r): r is string => r !== undefined && r !== id));
        for (const old of [...entry.related]) if (!wanted.has(old)) unlink(reg, id, old);
        for (const next of wanted) link(reg, id, next);
      }
      await saveReg(reg);
    });
    return { ok: true };
  }

  /** "These two are one project": `from` becomes an older id of `into` (still read, no longer written to). */
  async function merge(body: Record<string, unknown>): Promise<{ ok: true }> {
    const from = checkId(body.from);
    const into = checkId(body.into);
    await withLock(async () => {
      const reg = await loadReg();
      if (!mergeProjects(reg, from, into)) throw new HttpError(400, tr('These memories cannot be joined.', 'Эти памяти нельзя объединить.'));
      await saveReg(reg);
    });
    return { ok: true };
  }

  /** Undoes a join: the older id is a project of its own again. */
  async function split(body: Record<string, unknown>): Promise<{ ok: true }> {
    const id = checkId(body.id);
    await withLock(async () => {
      const reg = await loadReg();
      const owner = reg.projects.find((p) => p.aliases.includes(id));
      if (!owner) throw new HttpError(404, tr('This memory is not joined to a project.', 'Эта память не присоединена к проекту.'));
      owner.aliases = owner.aliases.filter((a) => a !== id);
      reg.projects.push({ id, name: memoryName(id), names: [], roots: [], aliases: [], related: [], apart: true });
      await saveReg(reg);
    });
    return { ok: true };
  }

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
    const [part] = segments;
    if (!part && method === 'GET') return { status: 200, body: await overview() };
    if (part === 'facts') {
      if (method === 'GET') return { status: 200, body: await facts(checkId(query.get('id')), query.get('status') === 'all') };
      if (method === 'POST') return { status: 201, body: await addFact(await readBody()) };
      if (method === 'PUT') return { status: 200, body: await patchFact(await readBody()) };
      if (method === 'DELETE') return { status: 200, body: await removeFact(query) };
    }
    if (part === 'move' && method === 'POST') return { status: 200, body: await moveFact(await readBody()) };
    if (part === 'projects' && method === 'PUT') return { status: 200, body: await updateProject(await readBody()) };
    if (part === 'merge' && method === 'POST') return { status: 200, body: await merge(await readBody()) };
    if (part === 'split' && method === 'POST') return { status: 200, body: await split(await readBody()) };
    throw new HttpError(404, tr('Not found.', 'Не найдено.'));
  }

  return { handle, overview };
}
