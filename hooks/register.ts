// jev-governor: Jev decides how much model each step of a Claude Code session
// needs. Main conversation: effort every turn, model only where the prompt
// cache allows. Subagents: model + effort at spawn, mapped onto (or creating)
// a specialist agent. Compaction: Jev prunes stale tool calls instead of a
// lossy summary. The policies live in ./lib (pure, unit-tested); this file
// wires them to the engine. Data: ~/.claude/jev-governor (see docs/DATA.md).

import type { EngineInterface, Register } from 'claude-code';

import type { Message } from './lib/compaction/types.ts';

import { budgetPressure, describePressure, type Pressure } from './lib/budget.ts';
import { archiveText, editedPath, indexLine, isPointerText, rerunKey, withPointers, type PrunedCall } from './lib/archive.ts';
import {
  attachedPrompt,
  BRIEF_MARKER,
  briefPrompt,
  buildSkeleton,
  candidateTurns,
  capsuleId,
  CTX_REF,
  parseGetctxArgs,
  pastePrompt,
  planTurns,
  projectSlug,
  renderCapsule,
  turnQuestions,
  turnState,
  type CapsuleMessage,
  type CapsuleMeta,
} from './lib/capsule.ts';
import { runCompaction, summarizeCompaction } from './lib/compaction/adapter.ts';
import { expandHome, isExcluded, resolveConfig } from './lib/config.ts';
import { clip, estimateContextTokens, recentHistory, type HistoryMessage } from './lib/history.ts';
import { choice, jevAsker, noul, withTimeout, type JevAsker, type JevQuestions, type JevResponse } from './lib/jev.ts';
import { displayModel } from './lib/providers.ts';
import { redact } from './lib/redact.ts';
import { chunkQuestions, isClaudeSavedOutput, isRunnerCommand, persistedOutputPath, MIN_TRIM_GAIN, planTrim, renderTrim, trimKind, worthTrimming, type Chunk } from './lib/trim.ts';
import { commandDir, describePrompt, describeSystem, normalizeObserved, parseDescriptions } from './lib/commands.ts';
import {
  agentQuestion,
  agentType,
  composePrompt,
  DRAFT_SYSTEM,
  draftPrompt,
  NONE,
  parseDraft,
  PLUGIN,
  rankCandidates,
  sanitizeAgent,
  sanitizeSkill,
  withRolePreamble,
  withWaitNote,
} from './lib/registry.ts';
import {
  decideMain,
  decideSubagent,
  escalate,
  fallbackDecision,
  isShortFollowUp,
  MAIN_STATE_CONTEXT,
  mainQuestions,
  readSignals,
  SUBAGENT_STATE_CONTEXT,
  subagentQuestions,
  tierOf,
  type Decision,
} from './lib/router.ts';
import type {
  AgentRecord,
  DescribeRequest,
  DraftRecord,
  LedgerEntry,
  SkillRecord,
} from './lib/types.ts';

import {
  basename,
  cacheWarm,
  type CapsuleRecord,
  errorText,
  type Handoff,
  handoffDir,
  active,
  idleCompaction,
  jevKey,
  kTokens,
  learnTurn,
  type MainOutcome,
  nowIso,
  outputsDir,
  type PendingSpawn,
  promptKey,
  prunedOf,
  type Rate,
  rememberPruned,
  resultText,
  type Route,
  S,
  shadow,
  type SpawnPlan,
  statusText,
  type SubState,
  usageBase,
} from './mod/state.ts';

// How specialists reach a subagent (verified against the engine, 2.1.286):
// a spawn may only be rewritten to an agent type that was offered to the
// model when the turn began; a hidden or freshly registered type is refused,
// the Agent call fails, and `next` cannot be retried. So the spawn's type is
// never rewritten: the specialist's role and skills ride in front of the
// task of the original (generic) subagent, which also keeps the model's agent
// listing, and its prompt cache, untouched. With `agents.exposeToModel` the
// specialists are additionally registered and listed, so the model may call
// one by name; such a call is routed like any other spawn.
/** Most specialists offered to Jev per spawn (pre-ranked by word overlap). */
const MAX_CANDIDATES = 12;
const LEDGER_MAX_LINES = 5000;
/** Jev failures in a row after which the status line shows `jev ✕`. */
const JEV_FAILS_SHOWN = 3;
/** Pause before the one retry of a routing request to Jev. */
const JEV_RETRY_PAUSE_MS = 600;

// ---------------------------------------------------------------- storage --

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  try {
    return JSON.parse(String(await $.fs.read(path)));
  } catch {
    return undefined;
  }
}

async function loadConfig($: EngineInterface, force: boolean): Promise<void> {
  const path = `${S.data}/config.json`;
  try {
    const stat = await $.fs.stat(path);
    if (!force && stat.mtimeMs === S.cfgMtime) return;
    S.cfg = resolveConfig(await readJson($, path));
    S.cfgMtime = stat.mtimeMs;
    // A window changed in the settings takes effect at once (bindSession logs it at start).
    if (!force) await applyAutoWindow($, false);
  } catch {
    // First run: write the defaults so the settings UI has a file to edit.
    S.cfg = resolveConfig(undefined);
    try {
      await $.fs.write(path, `${JSON.stringify(S.cfg, null, 2)}\n`);
      S.cfgMtime = (await $.fs.stat(path)).mtimeMs;
    } catch {
      S.cfgMtime = -1;
    }
  }
}

/**
 * Claude Code compacts on its own when the context reaches its auto-compaction window, also in
 * the middle of a turn and inside subagents, where the mod cannot start one. A smaller window
 * (`compaction.autoWindowTokens`) makes those compactions come sooner, and the session.compact
 * hook prunes them through Jev like ours. The variable is the process's: the value the mod set is
 * remembered in JEV_GOVERNOR_AUTO_WINDOW, so a value the person set is never overwritten and a
 * reload or a config change can update or clear the mod's own. Logged once per session with what
 * the engine actually measures against, so the monitor can tell whether it took.
 */
async function applyAutoWindow($: EngineInterface, log: boolean): Promise<void> {
  try {
    // Only where the hook prunes: in shadow mode, an excluded project or without a key a smaller
    // window would only bring Claude Code's paid summaries sooner.
    const prunes = active() && S.cfg.compaction.enabled && jevKey() !== undefined && !shadow();
    const want = prunes ? S.cfg.compaction.autoWindowTokens : 0;
    const current = await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    const mine = await $.env.get('JEV_GOVERNOR_AUTO_WINDOW');
    const ours = current !== undefined && current === mine;
    let by: 'mod' | 'user' | 'none' = 'none';
    if (current && !ours) by = 'user';
    else if (want > 0) {
      if (current !== String(want)) {
        await $.env.set('CLAUDE_CODE_AUTO_COMPACT_WINDOW', String(want));
        await $.env.set('JEV_GOVERNOR_AUTO_WINDOW', String(want));
      }
      by = 'mod';
    } else if (ours) {
      await $.env.set('CLAUDE_CODE_AUTO_COMPACT_WINDOW', undefined);
      await $.env.set('JEV_GOVERNOR_AUTO_WINDOW', undefined);
    }
    S.autoWindow = by === 'mod' ? want : undefined;
    if (!log || S.autoWindowLogged === S.session) return;
    S.autoWindowLogged = S.session;
    let tokens: number | undefined;
    let source: string | undefined;
    try {
      const b = (await $.session.usage({ breakdown: 'summary' })).context.breakdown;
      tokens = b?.rawMaxTokens;
      source = b?.autocompactSource;
    } catch {
      // No breakdown before the first request in some hosts: the entry still says what was set.
    }
    await ledger($, {
      kind: 'window',
      text: by === 'mod' ? `auto-compaction window ${kTokens(want)}` : by === 'user' ? `auto-compaction window set outside the mod (${current})` : 'auto-compaction window: Claude Code default',
      autoWindow: { by, tokens, source, ...(want > 0 ? { wanted: want } : {}) },
    });
  } catch (error) {
    await ledger($, { kind: 'error', error: `auto window: ${errorText(error)}` });
  }
}

/** The model a subagent runs on, as routed (the main chat's when the mod did not route it). */
function subModel(agentId: string): string | undefined {
  const sub = S.subs.get(agentId);
  return sub ? S.cfg.models[sub.tier] : S.route.lastModel;
}

async function saveConfig($: EngineInterface): Promise<void> {
  const path = `${S.data}/config.json`;
  await $.fs.write(path, `${JSON.stringify(S.cfg, null, 2)}\n`);
  S.cfgMtime = (await $.fs.stat(path)).mtimeMs;
}

async function loadKey($: EngineInterface): Promise<void> {
  const fromEnv = await $.env.get('OPENROUTER_API_KEY');
  if (fromEnv && fromEnv.trim()) {
    S.key = fromEnv.trim();
    return;
  }
  for (const path of [expandHome(S.cfg.jev.keyFile, S.home), `${$.plugin.root}/.openrouter_key`]) {
    try {
      const key = String(await $.fs.read(path)).trim();
      if (key) {
        S.key = key;
        return;
      }
    } catch {
      // try the next place
    }
  }
  S.key = undefined;
}

async function registrySignature($: EngineInterface): Promise<string> {
  const parts: string[] = [];
  for (const dir of ['agents', 'skills']) {
    try {
      for (const entry of await $.fs.list(`${S.data}/${dir}`)) {
        if (entry.name.endsWith('.json')) parts.push(`${dir}/${entry.name}:${entry.mtimeMs}`);
      }
    } catch {
      // no such directory yet
    }
  }
  return parts.sort().join('|');
}

async function loadRegistry($: EngineInterface): Promise<boolean> {
  const sig = await registrySignature($);
  if (sig === S.registrySig) return false;
  const now = nowIso();
  const agents = new Map<string, AgentRecord>();
  const skills = new Map<string, SkillRecord>();
  for (const [dir, into] of [
    ['skills', skills],
    ['agents', agents],
  ] as const) {
    let entries: { name: string }[] = [];
    try {
      entries = await $.fs.list(`${S.data}/${dir}`);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue;
      const raw = await readJson($, `${S.data}/${dir}/${entry.name}`);
      if (dir === 'skills') {
        const skill = sanitizeSkill(raw, now);
        if (skill) skills.set(skill.name, skill);
      } else {
        const agent = sanitizeAgent(raw, now);
        if (agent) (into as Map<string, AgentRecord>).set(agent.name, agent);
      }
    }
  }
  S.agents = agents;
  S.skills = skills;
  S.registrySig = sig;
  return true;
}

async function registerAgent($: EngineInterface, agent: AgentRecord): Promise<void> {
  if (!agent.enabled || !S.cfg.agents.exposeToModel) return;
  await $.agent.register({
    name: agent.name,
    description: agent.description,
    prompt: composePrompt(agent, S.skills),
    ...(agent.tools ? { tools: agent.tools } : {}),
    ...(agent.effort !== 'auto' ? { effort: agent.effort } : {}),
  });
}

async function registerAll($: EngineInterface): Promise<void> {
  for (const agent of S.agents.values()) {
    try {
      await registerAgent($, agent);
    } catch (error) {
      await ledger($, { kind: 'error', error: `register ${agent.name}: ${errorText(error)}` });
    }
  }
}

async function persistAgent($: EngineInterface, agent: AgentRecord, skills: readonly SkillRecord[]): Promise<void> {
  for (const skill of skills) {
    await $.fs.write(`${S.data}/skills/${skill.name}.json`, `${JSON.stringify(skill, null, 2)}\n`);
    S.skills.set(skill.name, skill);
  }
  await $.fs.write(`${S.data}/agents/${agent.name}.json`, `${JSON.stringify(agent, null, 2)}\n`);
  S.agents.set(agent.name, agent);
  S.registrySig = await registrySignature($);
}

/** Appends to ledger/<day>/<session>.jsonl (the file is rewritten whole: $.fs has no append). */
async function ledger($: EngineInterface, entry: Omit<LedgerEntry, 'ts' | 'session'>): Promise<void> {
  if (!S.data) return;
  const ts = nowIso();
  const line = JSON.stringify({ ts, session: S.session, project: S.project, ...entry });
  const path = `${S.data}/ledger/${ts.slice(0, 10)}/${S.session}.jsonl`;
  const run = async (): Promise<void> => {
    let lines = S.ledgerLines.get(path);
    if (!lines) {
      lines = [];
      try {
        lines = String(await $.fs.read(path)).split('\n').filter(Boolean);
      } catch {
        // new file
      }
      S.ledgerLines.set(path, lines);
    }
    lines.push(line);
    if (lines.length > LEDGER_MAX_LINES) lines.splice(0, lines.length - LEDGER_MAX_LINES);
    await $.fs.write(path, `${lines.join('\n')}\n`);
  };
  S.ledgerChain = S.ledgerChain.then(run, run).catch(() => undefined);
  await S.ledgerChain;
}

async function saveRoute($: EngineInterface): Promise<void> {
  try {
    await $.store.set(`route:${S.session}`, { ...S.route, savedAt: Date.now() });
  } catch {
    // best effort
  }
}

/** The chat's own switches (`/jevg chat`, `/jevg idle`) outlive a restart and a resume of the chat. */
async function saveChat($: EngineInterface): Promise<void> {
  try {
    await $.store.set(`chat:${S.session}`, { ...S.chat, savedAt: Date.now() });
  } catch {
    // best effort
  }
}

async function restoreChat($: EngineInterface): Promise<void> {
  try {
    const saved = (await $.store.get(`chat:${S.session}`)) as { off?: unknown; idle?: unknown } | undefined;
    S.chat = { off: saved?.off === true, idle: saved?.idle === true };
  } catch {
    S.chat = { off: false, idle: false };
  }
}

async function restoreRoute($: EngineInterface): Promise<void> {
  try {
    const saved = (await $.store.get(`route:${S.session}`)) as Route | undefined;
    if (saved && typeof saved === 'object') S.route = { ...saved, freeSwitch: Boolean(saved.freeSwitch) };
  } catch {
    // fresh route
  }
}

// -------------------------------------------------------------------- Jev --

/** A Jev client over the engine's fetch; secrets are replaced in every request and counted in the ledger. */
function makeAsker($: EngineInterface, key: string, purpose: string): JevAsker {
  return jevAsker({
    http: async (url, init) => {
      const response = await $.http.fetch(url, init);
      return { status: response.status, ok: response.ok, text: response.text };
    },
    endpoint: S.cfg.jev.endpoint,
    apiKey: key,
    model: S.cfg.jev.model,
    onRedacted: (count) => void ledger($, { kind: 'redacted', count, text: purpose }),
  });
}

async function askJev(
  $: EngineInterface,
  state: object,
  questions: JevQuestions,
  timeoutMs = S.cfg.jev.timeoutMs,
  purpose = 'decision',
): Promise<{ response: JevResponse; ms: number } | undefined> {
  const key = jevKey();
  if (!key) return undefined;
  const asker = makeAsker($, key, purpose);
  const started = Date.now();
  // Routing decisions get one more try after a brief pause: Jev's upstream
  // drops single requests (503 "no healthy upstream", a timeout) and a turn
  // without a decision runs on the session's own effort. Not while Jev keeps
  // failing (each turn would wait twice for nothing), not for trims or
  // compactions (they keep everything without Jev anyway).
  const retry = (purpose === 'decision' || purpose === 'subagent') && S.jevFailures === 0;
  const once = (): Promise<JevResponse> => withTimeout(asker.ask(state, questions), (ms) => $.clock.sleep(ms), timeoutMs);
  try {
    let response: JevResponse;
    try {
      response = await once();
    } catch (error) {
      if (!retry || !isRetriable(error)) throw error;
      await ledger($, { kind: 'error', error: `jev: ${errorText(error)} (retrying)` });
      await $.clock.sleep(JEV_RETRY_PAUSE_MS);
      response = await once();
    }
    S.jevFailures = 0;
    return { response, ms: Date.now() - started };
  } catch (error) {
    S.jevFailures++;
    if (S.jevFailures >= JEV_FAILS_SHOWN && S.cfg.ui.showStatus) {
      $.ui.status(`jev ✕ Jev не отвечает (${S.jevFailures} ${times(S.jevFailures)} подряд): модель и effort — прошлого решения или запасные`);
    }
    await ledger($, { kind: 'error', error: `jev: ${errorText(error)}` });
    return undefined;
  }
}

/** A Jev failure worth one more try: a timeout, a network error, 429 or 5xx (not a bad key or request). */
function isRetriable(error: unknown): boolean {
  const text = errorText(error);
  const status = /\((\d{3})\)/.exec(text)?.[1];
  return status === undefined ? true : status === '429' || status.startsWith('5');
}

/** "раз" in Russian after a count: 2 раза, 5 раз, 21 раз, 22 раза. */
function times(n: number): string {
  const last = n % 10;
  return last >= 2 && last <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'раза' : 'раз';
}

async function pressureNow(
  $: EngineInterface,
): Promise<{ pressure: Pressure; text: string; contextTokens?: number; rate: Rate }> {
  try {
    const usage = await $.session.usage();
    const paced = budgetPressure(usage.rateLimits, Date.now());
    const pct = (kind: string): number | undefined => usage.rateLimits.find((w) => w.kind === kind)?.percentUsed;
    return {
      pressure: S.cfg.router.budgetAware ? paced.pressure : 0,
      text: describePressure(paced.windows),
      contextTokens: usage.context.tokens,
      rate: { fiveHour: pct('five_hour'), sevenDay: pct('seven_day') },
    };
  } catch {
    return { pressure: 0, text: '', rate: {} };
  }
}

// ------------------------------------------------------------- main loop --

async function decideMainTurn($: EngineInterface, text: string): Promise<MainOutcome | undefined> {
  const cfg = S.cfg;
  if (!cfg.router.mainModel && !cfg.router.mainEffort) return undefined;
  const budget = await pressureNow($);
  const sessionModel = await $.session.model();
  // A /model change by the person: adopt it, do not fight it this turn.
  const manual = S.route.lastSessionModel !== undefined && S.route.lastSessionModel !== sessionModel;
  if (manual) {
    await ledger($, {
      kind: 'override',
      scope: 'main',
      text: clip(text, 160),
      model: sessionModel,
      prevModel: S.route.lastModel,
      reasons: [`/model ${displayModel(S.route.lastSessionModel ?? '')} → ${displayModel(sessionModel)}`],
    });
  }
  S.route.lastSessionModel = sessionModel;
  // `lastModel` stays the one the last turn ran on: turn.step sees the /model switch as a switch
  // (the cache is rewritten), and what follows keeps the person's model.
  const current = tierOf(manual ? sessionModel : (S.route.lastModel ?? sessionModel), cfg) ?? 'strong';
  if (manual && S.route.previous) S.route.previous = { ...S.route.previous, tier: current };
  const idle =
    S.route.lastRequestAt !== undefined &&
    Date.now() - S.route.lastRequestAt > cfg.router.cacheTtlMinutes * 60_000;
  const freeSwitch = S.route.freeSwitch || S.route.lastRequestAt === undefined || idle;
  // Without Jev's view (no text, a bare "go on", Jev down): the previous decision, else nothing changes.
  const keep = (why: string, local = false): MainOutcome => ({
    decision: S.route.previous
      ? { ...S.route.previous, switched: false, reasons: [`${why}: previous decision kept`] }
      : { tier: current, effort: cfg.router.defaultEffort, keepEffort: true, switched: false, reasons: [`${why}: nothing changed`] },
    pressure: budget.pressure,
    pressureText: budget.text,
    rate: budget.rate,
    contextTokens: budget.contextTokens,
    cacheCold: idle,
    ...(manual ? { manual: true } : {}),
    ...(local ? { local: true } : {}),
  });

  if (!text.trim()) return keep('no prompt text');
  // "да", "давай", "go on": nothing to judge, so nothing is sent to Jev.
  if (isShortFollowUp(text)) return keep('short follow-up (no Jev)', true);
  let messages: HistoryMessage[] = [];
  try {
    messages = (await $.session.messages()) as unknown as HistoryMessage[];
  } catch {
    messages = [];
  }
  // Before the session's first response the engine has no context figure yet.
  const contextTokens = budget.contextTokens ?? estimateContextTokens(messages);
  const state = {
    context: MAIN_STATE_CONTEXT,
    project: S.project,
    latest_user_request: clip(text, 3000, 600),
    recent_conversation: recentHistory(messages, { maxTokens: 3500, maxMessages: 14, latest: text }),
    current_model: current === 'strong' ? 'Opus 5.5' : 'Sonnet 5.5',
  };
  const asked = await askJev($, state, mainQuestions());
  const signals = asked ? readSignals(asked.response.answers) : undefined;
  // Jev down: the session's own model would be a switch nobody weighed.
  if (!signals) {
    if (S.route.previous || !cfg.router.mainEffort) return keep('Jev unavailable');
    return { ...keep('Jev unavailable'), decision: fallbackDecision(current, 'Jev unavailable, no earlier decision', cfg) };
  }
  const decision = decideMain(
    signals,
    {
      currentTier: current,
      freeSwitch,
      contextTokens,
      pressure: budget.pressure,
      previous: S.route.previous,
      turnProfile: S.route.turnProfile,
    },
    cfg,
  );
  if (manual) {
    decision.tier = current;
    decision.switched = false;
    decision.reasons.push('model set by /model: kept');
  }
  if (!cfg.router.mainEffort) decision.reasons.push('effort routing off');
  return {
    decision,
    signals,
    pressure: budget.pressure,
    pressureText: budget.text,
    rate: budget.rate,
    contextTokens,
    jevMs: asked?.ms,
    jevCost: asked?.response.usage?.cost,
    cacheCold: idle,
    ...(manual ? { manual: true } : {}),
  };
}

// -------------------------------------------------------------- subagents --

async function createAgent(
  $: EngineInterface,
  input: { title: string; task: string },
): Promise<AgentRecord | undefined> {
  const reply = await $.model.complete({
    model: S.cfg.agents.draftModel,
    system: DRAFT_SYSTEM,
    prompt: draftPrompt({
      task: input.task,
      title: input.title,
      project: S.project,
      agents: [...S.agents.values()],
      skills: [...S.skills.values()],
    }),
    maxTokens: 1500,
    effort: 'low',
    timeoutMs: S.cfg.agents.draftTimeoutMs,
  });
  if (!reply.isAnswered) {
    await ledger($, { kind: 'error', error: `draft agent: ${reply.reason}` });
    return undefined;
  }
  const draft = parseDraft(reply.text, { agents: new Set(S.agents.keys()), skills: S.skills }, nowIso());
  if (!draft) {
    await ledger($, { kind: 'error', error: 'draft agent: unusable reply', text: clip(reply.text, 200) });
    return undefined;
  }
  await persistAgent($, draft.agent, draft.skills);
  await registerAgent($, draft.agent);
  await ledger($, {
    kind: 'agent-created',
    agent: draft.agent.name,
    text: clip(input.title, 160),
    reasons: draft.skills.map((s) => `new skill ${s.name}`),
  });
  $.ui.toast(`jev-governor: new subagent ${draft.agent.name}`, { timeoutMs: 6000 });
  return draft.agent;
}

/**
 * The session's project root: where it started, or where `/cd` or a worktree
 * took it. A shell `cd` into a subfolder does not move it (`$.session.cwd()`
 * would): the project, its capsules and its transcript stay the same.
 */
async function projectRoot($: EngineInterface): Promise<string> {
  try {
    return await $.session.root();
  } catch {
    return await $.session.cwd();
  }
}

/** The session may move to another project after it starts: shadow/active follows it. */
async function refreshCwd($: EngineInterface): Promise<void> {
  try {
    S.cwd = await projectRoot($);
    S.project = basename(S.cwd);
  } catch {
    // keep the last known folder
  }
}

async function planSpawn(
  $: EngineInterface,
  e: { subagentType: string; description: string; prompt: string; parentModel: string; model?: string },
): Promise<SpawnPlan | undefined> {
  await loadConfig($, false);
  await refreshCwd($);
  const cfg = S.cfg;
  if (await loadRegistry($)) await registerAll($);
  const ownName = e.subagentType.startsWith(`${PLUGIN}:`) ? e.subagentType.slice(PLUGIN.length + 1) : undefined;
  const remap = cfg.agents.enabled && cfg.agents.remapFrom.includes(e.subagentType);
  const candidates = remap ? rankCandidates([...S.agents.values()], `${e.description} ${e.prompt}`, MAX_CANDIDATES) : [];
  const questions: JevQuestions = {
    ...(cfg.router.subagents ? subagentQuestions() : {}),
    ...(candidates.length > 0 ? { agent: agentQuestion(candidates) } : {}),
  };
  const budget = await pressureNow($);
  const asked =
    Object.keys(questions).length > 0
      ? await askJev(
          $,
          {
            context: SUBAGENT_STATE_CONTEXT,
            project: S.project,
            parent_request: clip(S.turn?.text ?? '', 600, 200),
            subagent_type: e.subagentType,
            task_title: e.description,
            task: clip(e.prompt, 6000, 1000),
          },
          questions,
          undefined,
          'subagent',
        )
      : undefined;
  // Jev down: no specialist is matched or drafted (a draft per spawn would duplicate the
  // registry), but the subagent still gets the fallback effort and the wait note.
  const jevDown = Object.keys(questions).length > 0 && !asked;

  let agent = ownName ? S.agents.get(ownName) : undefined;
  let created = false;
  if (remap && !jevDown) {
    const pick = asked ? choice(asked.response.answers, 'agent') : undefined;
    const p = pick ? (pick.probabilities[pick.choice] ?? 0) : 0;
    if (pick && pick.choice !== NONE && p >= cfg.agents.matchAt && S.agents.get(pick.choice)?.enabled) {
      agent = S.agents.get(pick.choice);
    } else if (cfg.agents.autoCreate && !shadow() && S.agents.size < cfg.agents.maxAgents) {
      // Parallel spawns of the same kind share one draft.
      const key = e.description.toLowerCase().slice(0, 60);
      let pending = S.creating.get(key);
      if (!pending) {
        pending = createAgent($, { title: e.description, task: e.prompt }).catch(async (error) => {
          await ledger($, { kind: 'error', error: `create agent: ${errorText(error)}` });
          return undefined;
        });
        S.creating.set(key, pending);
      }
      agent = await pending;
      S.creating.delete(key);
      created = agent !== undefined;
    }
  }

  const signals = asked ? readSignals(asked.response.answers) : undefined;
  const pinnedTier = agent && agent.tier !== 'auto' ? agent.tier : undefined;
  const pinnedEffort = agent && agent.effort !== 'auto' ? agent.effort : undefined;
  let decision: Decision | undefined;
  // The fallback leaves the model alone unless the agent pins it (an Explore agent keeps its own).
  let keepModel = false;
  if (cfg.router.subagents && jevDown) {
    decision = fallbackDecision(pinnedTier ?? tierOf(e.model ?? e.parentModel, cfg) ?? 'strong', 'Jev unavailable', cfg, pinnedEffort);
    keepModel = pinnedTier === undefined;
  } else if (cfg.router.subagents && signals) {
    decision = decideSubagent(
      signals,
      {
        pressure: budget.pressure,
        subagentType: agent ? agentType(agent.name) : e.subagentType,
        readOnly:
          e.subagentType === 'Explore' ||
          (agent?.tools !== undefined && !agent.tools.some((t) => ['Edit', 'Write', 'NotebookEdit'].includes(t))),
        pinnedTier,
        pinnedEffort,
      },
      cfg,
    );
  } else if (pinnedTier) {
    decision = { tier: pinnedTier, effort: pinnedEffort ?? cfg.router.defaultEffort, switched: false, reasons: ['pinned by agent'] };
  }

  let prompt = e.prompt;
  if (agent && !ownName) prompt = withRolePreamble(agent, S.skills, e.prompt);
  if (cfg.agents.waitHint) prompt = withWaitNote(prompt);
  return {
    rate: budget.rate,
    prompt,
    model: decision && !keepModel ? (decision.light && cfg.router.lightSubagents === 'on' ? cfg.models.light : cfg.models[decision.tier]) : undefined,
    decision,
    agent,
    created,
    signals,
    pressure: budget.pressure,
    jevMs: asked?.ms,
    jevCost: asked?.response.usage?.cost,
  };
}

/**
 * Maps a subagent whose first steps run before its spawn resolved onto that
 * spawn, by the task text its transcript opens with.
 */
async function claimPending($: EngineInterface, agentId: string): Promise<SubState | undefined> {
  const now = Date.now();
  S.pending = S.pending.filter((p) => now - p.at < 120_000);
  if (S.pending.length === 0) return undefined;
  const messages = await $.session.messages({ agentId });
  if (!Array.isArray(messages)) return undefined;
  const first = messages.find((m) => m.role === 'user' && m.text.trim())?.text ?? '';
  const index = S.pending.findIndex((p) => first.includes(p.promptKey));
  if (index < 0) return undefined;
  const [claimed] = S.pending.splice(index, 1);
  S.subs.set(agentId, claimed!.sub);
  return claimed!.sub;
}

/**
 * Trims one tool result if it qualifies; returns the replacement text and a
 * ledger record, or undefined to keep it whole. In shadow mode it only
 * measures (no Jev, no file, nothing replaced).
 */
async function trimResult(
  $: EngineInterface,
  toolUseId: string,
  text: string,
  isError: boolean,
): Promise<{ text: string; entry: Omit<LedgerEntry, 'ts' | 'session'> } | undefined> {
  const t = S.cfg.trim;
  const call = S.calls.get(toolUseId);
  const tool = call?.tool ?? 'unknown';
  // Claude Code already replaced a big Bash output with a 2KB preview of its
  // start: for a test or build run, trim the saved full output instead, so the
  // outcome and the summary at its end are in the conversation. The file is the
  // one the engine named for this call; the path in the preview text (which the
  // command printed, so could forge) only when it is in Claude Code's own folder.
  const named = tool === 'Bash' && isRunnerCommand(call?.command) ? persistedOutputPath(text) : undefined;
  const persisted = named === undefined ? undefined : (call?.persisted ?? (isClaudeSavedOutput(named, S.home) ? named : undefined));
  if (persisted) {
    let full: string;
    try {
      full = String(await $.fs.read(persisted));
    } catch {
      return undefined;
    }
    // Claude Code saves runs that succeeded (a failing one keeps its tail inline): the outcome,
    // the summary and any warning lines are what the preview lacked, not 16k of the log.
    const trimmed = await trimFull($, toolUseId, full, isError, persisted, isError ? undefined : BRIEF_TRIM);
    if (!trimmed) return undefined;
    // What entered the history otherwise was the preview: charsAfter above it is a cost, not a saving.
    trimmed.entry.trim = { ...trimmed.entry.trim!, charsBefore: text.length, persisted: true, fullChars: full.length };
    return trimmed;
  }
  const kind = trimKind(tool, call?.command, text, t);
  if (!kind) return undefined;
  return trimFull($, toolUseId, text, isError, undefined, kind === 'list' ? LIST_TRIM : undefined);
}

/** Settings for a short trim: the outcome, summary and signal lines, little else. */
const BRIEF_TRIM = { headLines: 5, tailLines: 15, contextLines: 1, maxChars: 3000 } as const;
/** Settings for a long listing: its first and last rows; the rest is one grep away in the saved file. */
const LIST_TRIM = { headLines: 40, tailLines: 15, contextLines: 0, maxChars: 4000 } as const;

/**
 * Trims `text`; `savedAt` is where the full output already is (else it is saved
 * to outputs/). A `preset` (BRIEF_TRIM, LIST_TRIM) replaces the line budgets
 * and asks Jev for nothing. A trim that would not remove MIN_TRIM_GAIN of a
 * live output keeps it whole (logged as not applied).
 */
async function trimFull(
  $: EngineInterface,
  toolUseId: string,
  text: string,
  isError: boolean,
  savedAt?: string,
  preset?: typeof BRIEF_TRIM | typeof LIST_TRIM,
): Promise<{ text: string; entry: Omit<LedgerEntry, 'ts' | 'session'> } | undefined> {
  const t = preset ? { ...S.cfg.trim, ...preset, useJev: false } : S.cfg.trim;
  const call = S.calls.get(toolUseId);
  const tool = call?.tool ?? 'unknown';
  let applied = !shadow();
  const plan = planTrim(text, isError, t);
  // What the trim keeps without Jev is the least it can keep: if even that saves too little
  // (source code is full of "error" and "expected"), Jev is not asked and the output stays whole.
  const floor = savedAt ? undefined : renderTrim(plan, { settings: t, originalChars: text.length });
  const hopeless = floor !== undefined && !worthTrimming(text.length, floor.charsAfter);
  let approved = new Set<string>();
  let jevMs: number | undefined;
  let jevCost: number | undefined;
  if (applied && !hopeless && t.useJev && jevKey() && plan.candidates.length > 0) {
    const preview = renderTrim(plan, { settings: t, originalChars: text.length });
    const chunks: Chunk[] = plan.candidates.slice(0, 20);
    const asked = await askJev(
      $,
      {
        context:
          'A coding assistant ran a tool; its long output is being trimmed before it enters the conversation. kept_output is what stays; omitted_chunks would be dropped (the full output stays readable in a file).',
        task: clip(S.turn?.text ?? '', 1500, 300),
        command: clip(call?.command ?? tool, 400),
        kept_output: clip(preview.text, 6000, 2000),
        omitted_chunks: Object.fromEntries(chunks.map((c) => [c.id, c.text])),
      },
      chunkQuestions(chunks),
      undefined,
      'trim',
    );
    if (asked) {
      jevMs = asked.ms;
      jevCost = asked.response.usage?.cost;
      approved = new Set(chunks.filter((c) => (noul(asked.response.answers, `need_${c.id}`) ?? 1) >= t.jevKeepAt).map((c) => c.id));
    } else {
      // Jev unavailable: keep every candidate rather than lose content.
      approved = new Set(chunks.map((c) => c.id));
    }
  }
  // A saved Claude Code output replaces a 2KB preview: there, growing is the point.
  const skipped = hopeless || (!savedAt && !worthTrimming(text.length, renderTrim(plan, { approved, settings: t, originalChars: text.length }).charsAfter));
  if (skipped) applied = false;
  let path: string | undefined = savedAt;
  if (applied && !savedAt) {
    path = `${outputsDir()}/${toolUseId}.txt`;
    try {
      await $.fs.write(path, text.length > 3_900_000 ? text.slice(0, 3_900_000) : text);
    } catch {
      path = undefined;
    }
  }
  const out = renderTrim(plan, { approved, fullPath: path, settings: t, originalChars: text.length });
  return {
    text: out.text,
    entry: {
      kind: 'trim',
      scope: call?.agentId ? 'subagent' : 'main',
      agentId: call?.agentId,
      applied,
      jevMs,
      jevCost,
      text: clip(call?.command ?? tool, 160),
      trim: {
        tool,
        command: call?.command ? clip(call.command, 200) : undefined,
        charsBefore: out.charsBefore,
        charsAfter: out.charsAfter,
        linesBefore: out.linesBefore,
        linesAfter: out.linesAfter,
        outcome: out.outcome.detail,
        jevChunks: out.jevChunks,
        path,
        ...(preset === LIST_TRIM ? { kind: 'list' } : {}),
        ...(skipped ? { skipped: `removes under ${Math.round(MIN_TRIM_GAIN * 100)}%` } : {}),
      },
    },
  };
}

/**
 * Keeps the saved full outputs bounded (our own directory only): files older
 * than `keepDays` go, empty session folders go, and while the total is over
 * `maxStorageMb` the oldest session folders go first.
 */
async function pruneOutputs($: EngineInterface): Promise<void> {
  const root = `${S.data}/outputs`;
  if (!S.data || !(await $.fs.exists(root))) return;
  try {
    await $.process.run(['find', root, '-type', 'f', '-name', '*.txt', '-mtime', `+${S.cfg.trim.keepDays}`, '-delete'], {
      timeoutMs: 10_000,
    });
    await $.process.run(['find', root, '-mindepth', '1', '-type', 'd', '-empty', '-delete'], { timeoutMs: 10_000 });
    const sessions: { path: string; bytes: number; newest: number }[] = [];
    for (const dir of await $.fs.list(root)) {
      if (dir.kind !== 'dir' || dir.name === S.session) continue;
      const files = await $.fs.list(`${root}/${dir.name}`);
      sessions.push({
        path: `${root}/${dir.name}`,
        bytes: files.reduce((sum, f) => sum + f.size, 0),
        newest: files.reduce((max, f) => Math.max(max, f.mtimeMs), 0),
      });
    }
    let total = sessions.reduce((sum, s) => sum + s.bytes, 0);
    const cap = S.cfg.trim.maxStorageMb * 1024 * 1024;
    for (const old of sessions.sort((a, b) => a.newest - b.newest)) {
      if (total <= cap) break;
      if (!old.path.startsWith(`${root}/`)) continue;
      await $.process.run(['rm', '-rf', old.path], { timeoutMs: 10_000 });
      total -= old.bytes;
    }
  } catch {
    // best effort
  }
}

/** Our saved outputs (pruned calls included) and capsules may be read without a prompt; nothing else is decided here. */
async function isSavedOutput($: EngineInterface, path: unknown): Promise<boolean> {
  if (typeof path !== 'string' || !S.data) return false;
  try {
    const stat = await $.fs.stat(path, { resolve: true });
    for (const dir of ['outputs', 'handoffs']) {
      if (!(await $.fs.exists(`${S.data}/${dir}`))) continue;
      const root = await $.fs.stat(`${S.data}/${dir}`, { resolve: true });
      if (stat.realPath && root.realPath && stat.realPath.startsWith(`${root.realPath}/`)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ------------------------------------------------------- idle compaction --

/**
 * Starts a compaction of the main conversation for our own reason. A terminal
 * session takes `$.session.compact()`; a headless / SDK-hosted one (the
 * desktop app) only compacts through a `/compact` command, which our
 * `session.compact` hook then turns into a Jev pruning like any other.
 */
async function requestCompaction($: EngineInterface, reason: 'threshold' | 'return'): Promise<void> {
  S.compacting = true;
  S.compactReason = reason;
  S.compactVia = 'api';
  try {
    try {
      await $.session.compact();
    } catch (error) {
      if (!/headless|not available|inside a turn/i.test(errorText(error))) throw error;
      S.compactVia = 'command';
      await $.command.run({ command: 'compact', args: '' });
    }
  } finally {
    S.compacting = false;
    S.compactReason = undefined;
    S.compactVia = undefined;
  }
}

/**
 * The prompt cache expired while the session sat idle: the next request will
 * re-write the whole history anyway, so shrink it now (Jev pruning, no
 * summary). Claude Code refuses a compaction from inside a prompt's own
 * dispatch, so this runs from a timer (or at session start on resume), before
 * the person is back.
 */
async function compactIdle($: EngineInterface, why: string): Promise<void> {
  const k = S.cfg.compaction;
  if (!active() || !k.enabled || !idleCompaction() || !jevKey() || shadow() || S.compacting) return;
  if (S.route.lastRequestAt === undefined) return;
  const idleFor = Date.now() - S.route.lastRequestAt;
  if (idleFor <= S.cfg.router.cacheTtlMinutes * 60_000) return;
  try {
    const { context } = await $.session.usage();
    if ((context.tokens ?? 0) < k.onReturnMinTokens) return;
    $.ui.log(
      `jev-governor: idle ${Math.round(idleFor / 60_000)} min (${why}), the prompt cache expired: compacting ${Math.round((context.tokens ?? 0) / 1000)}k tokens before you are back`,
    );
    await requestCompaction($, 'return');
  } catch (error) {
    await ledger($, { kind: 'error', error: `idle compaction: ${errorText(error)}` });
  }
}

/** (Re)arms the idle timer for just after the cache TTL from now. */
function scheduleIdle($: EngineInterface): void {
  S.idleTimer?.cancel();
  S.idleTimer = undefined;
  const k = S.cfg.compaction;
  if (!active() || !k.enabled || !idleCompaction() || shadow()) return;
  // From the last request, so that switching `/jevg idle on` on later arms it for the right moment.
  const since = S.route.lastRequestAt === undefined ? 0 : Date.now() - S.route.lastRequestAt;
  const delay = Math.max(1000, S.cfg.router.cacheTtlMinutes * 60_000 + 30_000 - since);
  S.idleTimer = $.clock.after(delay, () => {
    S.idleTimer = undefined;
    void compactIdle($, 'timer');
  });
}

// ------------------------------------------------------------- archive --

/**
 * Saves the calls a compaction prunes (input and full output) under
 * outputs/<session>/pruned/ and points the compacted history at them, so
 * nothing pruned is lost: the model reads it back when it needs it. A call
 * whose file could not be written stays as the library cut it.
 */
async function archivePruned(
  $: EngineInterface,
  original: readonly Message[],
  compacted: readonly Message[],
  pruned: readonly PrunedCall[],
): Promise<{ messages: Message[]; archived: number }> {
  if (pruned.length === 0) return { messages: [...compacted], archived: 0 };
  const dir = `${outputsDir()}/pruned`;
  const paths = new Map<string, string>();
  for (let i = 0; i < pruned.length; i += 16) {
    await Promise.all(
      pruned.slice(i, i + 16).map(async (call) => {
        const path = `${dir}/${call.toolUseId.replace(/[^A-Za-z0-9_-]/g, '_')}.txt`;
        try {
          // Truncated by an earlier compaction: the file holds the full output, the history only the stub.
          if (isPointerText(call.result)) {
            if (await $.fs.exists(path)) paths.set(call.toolUseId, path);
            return;
          }
          const text = archiveText(call);
          await $.fs.write(path, text.length > 3_900_000 ? text.slice(0, 3_900_000) : text);
          paths.set(call.toolUseId, path);
        } catch {
          // left as the library cut it
        }
      }),
    );
  }
  const saved = pruned.filter((call) => paths.has(call.toolUseId));
  const removed = saved.filter((call) => call.action === 'drop_call').length;
  // A stub truncated again is already listed; one now removed whole gets its line.
  const listed = saved.filter((call) => !(call.action === 'drop_result' && isPointerText(call.result)));
  const indexPath = `${dir}/index.md`;
  let index: { path: string; removed: number } | undefined;
  if (listed.length > 0) {
    let existing = '# Tool calls pruned from this session (newest last)\n';
    try {
      existing = String(await $.fs.read(indexPath));
    } catch {
      // first compaction of the session
    }
    try {
      await $.fs.write(indexPath, `${existing.trimEnd()}\n${listed.map((call) => indexLine(call, paths.get(call.toolUseId)!)).join('\n')}\n`);
      if (removed > 0) index = { path: indexPath, removed };
    } catch {
      // the pointers in place still work
    }
  }
  return {
    messages: withPointers(original, compacted, pruned, paths, S.cfg.compaction.truncateHeadChars, index),
    archived: saved.length,
  };
}

async function readCapsule($: EngineInterface, id: string): Promise<{ meta: CapsuleRecord; text: string } | undefined> {
  if (!/^\d{8}-\d{4}-[0-9a-f]{4}$/.test(id)) return undefined;
  const meta = (await readJson($, `${handoffDir()}/${id}.json`)) as CapsuleRecord | undefined;
  if (!meta || typeof meta.id !== 'string' || typeof meta.path !== 'string') return undefined;
  try {
    return { meta, text: String(await $.fs.read(meta.path)) };
  } catch {
    return undefined;
  }
}

/** This project's capsules, newest first. */
async function listCapsules($: EngineInterface): Promise<CapsuleRecord[]> {
  const dir = handoffDir();
  if (!S.data || !(await $.fs.exists(dir))) return [];
  const found: CapsuleRecord[] = [];
  for (const entry of await $.fs.list(dir)) {
    if (!entry.name.endsWith('.json')) continue;
    const meta = (await readJson($, `${dir}/${entry.name}`)) as CapsuleRecord | undefined;
    if (meta && typeof meta.id === 'string' && meta.cwd === S.cwd) found.push(meta);
  }
  return found.sort((a, b) => b.id.localeCompare(a.id));
}

async function pruneCapsules($: EngineInterface): Promise<void> {
  const dir = handoffDir();
  if (!S.data || !(await $.fs.exists(dir))) return;
  try {
    await $.process.run(['find', dir, '-type', 'f', '-mtime', `+${S.cfg.handoff.keepDays}`, '-delete'], { timeoutMs: 10_000 });
  } catch {
    // best effort
  }
}

/** Puts text on the clipboard: the surface's own, else pbcopy (macOS). */
async function copyText($: EngineInterface, text: string): Promise<boolean> {
  try {
    if ((await $.ui.copy({ text })).isCopied) return true;
  } catch {
    // no surface clipboard
  }
  try {
    return (await $.process.run(['pbcopy'], { stdin: text, timeoutMs: 5_000 })).exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * `/jevg getctx [--brief|--nobrief] [focus]`. With a warm cache (or `--brief`)
 * the chat's own model first writes a brief, one short turn that reads the
 * cache; the capsule is made when that turn ends. Otherwise it is made now.
 */
async function startHandoff($: EngineInterface, args: string, fresh = false): Promise<string> {
  const h = S.cfg.handoff;
  if (!h.enabled) return 'Перенос контекста выключен (handoff.enabled в настройках).';
  if (S.handoff) return 'Капсула уже готовится: дождитесь, пока модель допишет бриф.';
  const { brief, focus } = parseGetctxArgs(args);
  const id = capsuleId(new Date(), Math.random());
  const warm = cacheWarm();
  const wantBrief = brief ?? (h.brief === 'always' || (h.brief === 'auto' && warm));
  if (!wantBrief) {
    const note =
      brief === undefined && h.brief === 'auto'
        ? `Бриф моделью пропущен: кэш этого чата остыл, и бриф стоил бы перезаписи всего контекста (сделать всё равно: /jevg ${fresh ? 'fresh' : 'getctx'} --brief).\n\n`
        : '';
    const why = brief === false ? 'brief: --nobrief' : h.brief === 'never' ? 'brief: off in settings' : 'brief skipped: cache cold';
    return note + (await finishHandoff($, id, focus, undefined, why, fresh));
  }
  const pending: Handoff = { id, focus, fresh };
  S.handoff = pending;
  const giveUp = async (why: string): Promise<void> => {
    if (S.handoff !== pending) return;
    S.handoff = undefined;
    pending.timer?.cancel();
    // The chat is not cleared on a capsule the person did not get as asked.
    if (fresh) return cancelFresh($, id, why);
    $.ui.log(`jev-governor: ${why}, капсула без брифа.\n\n${await finishHandoff($, id, focus, undefined, `brief failed: ${why}`, fresh)}`);
  };
  pending.timer = $.clock.after(6 * 60_000, () => void giveUp('бриф не пришёл за 6 минут'));
  // The person asked for it: sent as their own words, read bare (not framed as a plugin's message).
  void $.prompt.submit({ text: briefPrompt(focus, h.briefWords), asUser: true }).catch((error: unknown) => giveUp(`бриф попросить не удалось (${errorText(error)})`));
  return `Готовлю капсулу${focus ? ` (фокус: ${focus})` : ''}. Сначала модель этого чата напишет бриф: один короткий ход, пока кэш тёплый. ${
    fresh ? 'Потом чат очистится (/clear), и капсула подключится к вашему следующему сообщению.' : 'Потом здесь появится промпт для нового чата.'
  }`;
}

/**
 * `/jevg fresh`: the capsule is made; now this chat is cleared and the capsule
 * rides with the next prompt, so the work goes on in the same window with a
 * ~14k context instead of the old one. The clear counts only when the session
 * id changed; otherwise (or should `/clear` fail) nothing is attached and the
 * paste prompt goes to the clipboard as with getctx. Prompts typed meanwhile
 * were held: they go in now, the first with the capsule.
 */
function clearAndAttach($: EngineInterface, id: string, tokens: number, prompt: string): void {
  const from = S.session;
  S.clearing = { id, from };
  $.clock.after(300, () => {
    void (async () => {
      let failed: string | undefined;
      try {
        await $.command.run({ command: 'clear', args: '' });
        if ((await $.session.id()) === from) failed = 'чат не сменился';
      } catch (error) {
        failed = errorText(error);
      }
      S.clearing = undefined;
      if (failed) {
        S.attachNext = undefined;
        await ledger($, { kind: 'error', error: `fresh: /clear failed: ${failed}` });
        const copied = await copyText($, prompt);
        $.ui.log(
          `jev-governor: очистить чат не удалось (${failed}). ${
            copied ? 'Откройте новый чат в этом проекте и вставьте промпт из буфера обмена' : `Откройте новый чат в этом проекте и вставьте:\n\n${prompt}\n\nили наберите там`
          } /jevg ctx.`,
        );
      } else {
        S.attachNext = id;
        await ledger($, { kind: 'handoff', text: 'chat cleared', handoff: { action: 'clear', id, tokens } });
        $.ui.toast(`jev-governor: чат очищен; капсула ${id} (~${kTokens(tokens)} токенов) подключится к вашему следующему сообщению`, {
          timeoutMs: 15_000,
        });
      }
      await releaseHeld($);
    })();
  });
}

/** `/jevg fresh` stopped before the clear: this chat stays as it is. */
async function cancelFresh($: EngineInterface, id: string, why: string): Promise<void> {
  await ledger($, { kind: 'handoff', text: `fresh cancelled: ${why}`, handoff: { action: 'cancel', id, tokens: 0 } });
  $.ui.log(`jev-governor: перенос отменён (${why}); чат не очищен.`);
  await releaseHeld($);
}

/** The prompts held while `/jevg fresh` ran, sent as the person's own, in order. */
async function releaseHeld($: EngineInterface): Promise<void> {
  for (const text of S.held.splice(0)) {
    try {
      await $.prompt.submit({ text, asUser: true });
    } catch (error) {
      await ledger($, { kind: 'error', error: `fresh: held prompt not sent: ${errorText(error)}` });
      $.ui.log(`jev-governor: не удалось отправить придержанное сообщение, наберите его ещё раз:\n\n${text}`);
    }
  }
}

/** Builds, saves and copies the capsule; returns what to show the person. */
async function finishHandoff(
  $: EngineInterface,
  id: string,
  focus: string,
  brief: string | undefined,
  note?: string,
  fresh = false,
): Promise<string> {
  const h = S.cfg.handoff;
  try {
    const messages = (await $.session.messages()) as unknown as CapsuleMessage[];
    const skeleton = buildSkeleton(messages, S.cwd);
    if (skeleton.turns.length === 0 && !skeleton.summary && !brief?.trim()) return 'Переносить пока нечего: в этом чате ещё нет ни одного хода.';
    let need: Map<number, number> | undefined;
    let jevCost: number | undefined;
    let jevMs: number | undefined;
    const candidates = candidateTurns(skeleton.turns);
    if (h.useJev && jevKey() && candidates.length > 0) {
      const asked = await askJev($, turnState(skeleton.turns, candidates, focus), turnQuestions(candidates), Math.max(S.cfg.jev.timeoutMs, 15_000), 'handoff');
      if (asked) {
        need = new Map();
        for (const turn of candidates) {
          const p = noul(asked.response.answers, `need_t${turn.n}`);
          if (p !== undefined) need.set(turn.n, p);
        }
        jevCost = asked.response.usage?.cost;
        jevMs = asked.ms;
      }
    }
    let sourceTokens: number | undefined;
    try {
      sourceTokens = (await $.session.usage()).context.tokens ?? undefined;
    } catch {
      // unknown
    }
    const transcript = `${S.home}/.claude/projects/${projectSlug(S.cwd)}/${S.session}.jsonl`;
    const archive = `${outputsDir()}/pruned`;
    const meta: CapsuleMeta = {
      id,
      project: S.project,
      cwd: S.cwd,
      session: S.session,
      createdAt: nowIso(),
      focus,
      ...((await $.fs.exists(transcript)) ? { transcript } : {}),
      ...((await $.fs.exists(archive)) ? { archive } : {}),
    };
    // The turns get what the brief, summary, files and checks leave of the budget.
    let budget = h.maxTokens;
    let rendered = renderCapsule({ meta, skeleton, plans: planTurns(skeleton.turns, budget, need), brief });
    for (let i = 0; i < 4 && rendered.tokens > h.maxTokens; i++) {
      budget = Math.max(300, budget - (rendered.tokens - h.maxTokens) - 200);
      rendered = renderCapsule({ meta, skeleton, plans: planTurns(skeleton.turns, budget, need), brief });
    }
    const path = `${handoffDir()}/${id}.md`;
    await $.fs.write(path, rendered.text);
    const title = clip(skeleton.turns[0]?.user ?? S.project, 60);
    const record: CapsuleRecord = {
      ...meta,
      title,
      tokens: rendered.tokens,
      sourceTokens,
      turns: skeleton.turns.length,
      brief: Boolean(brief?.trim()),
      jev: need !== undefined && need.size > 0,
      path,
      attached: [],
    };
    await $.fs.write(`${handoffDir()}/${id}.json`, `${JSON.stringify(record, null, 2)}\n`);
    const prompt = pastePrompt(meta, path, title);
    // /jevg fresh copies it only should the clear fail.
    const copied = fresh ? false : await copyText($, prompt);
    await ledger($, {
      kind: 'handoff',
      text: clip(focus || title, 160),
      reasons: note ? [note] : undefined,
      jevCost,
      jevMs,
      handoff: {
        action: 'create',
        id,
        tokens: record.tokens,
        sourceTokens,
        turns: record.turns,
        brief: record.brief,
        jev: record.jev,
        path,
        ...(fresh ? { fresh: true } : {}),
      },
    });
    if (fresh) {
      clearAndAttach($, id, record.tokens, prompt);
      return [
        `Капсула ${id}: ~${kTokens(record.tokens)} токенов вместо ${kTokens(sourceTokens)} в этом чате (ходов ${record.turns}; бриф ${record.brief ? 'да' : 'нет'}).`,
        'Сейчас чат очистится (/clear), и капсула подключится к вашему следующему сообщению: просто продолжайте работу.',
      ].join('\n');
    }
    return [
      `Капсула ${id}: ~${kTokens(record.tokens)} токенов вместо ${kTokens(sourceTokens)} в этом чате (ходов ${record.turns}; бриф ${record.brief ? 'да' : 'нет'}; отбор ходов Jev ${record.jev ? 'да' : 'нет'}).`,
      `Файл: ${path}`,
      copied ? 'Промпт для нового чата скопирован в буфер обмена:' : 'Промпт для нового чата (скопируйте):',
      '',
      prompt,
      '',
      'Откройте новый чат в этом проекте и вставьте промпт: капсула подключится сама. Без вставки — команда /jevg ctx в новом чате.',
    ].join('\n');
  } catch (error) {
    await ledger($, { kind: 'error', error: `handoff: ${errorText(error)}` });
    return `Не удалось собрать капсулу: ${errorText(error)}`;
  }
}

/** `/jevg ctx [list|<id>]` in a new chat: attach a capsule of this project to the next prompt. */
async function attachCommand($: EngineInterface, rest: string): Promise<string> {
  const list = await listCapsules($);
  const none = 'Капсул для этого проекта нет. В старом чате: /jevg getctx';
  if (rest === 'list') {
    if (list.length === 0) return none;
    return [
      'Капсулы этого проекта (новые сверху):',
      ...list.slice(0, 12).map(
        (m) =>
          `- ${m.id} · ${m.title} · ~${kTokens(m.tokens)}${m.focus ? ` · фокус: ${m.focus}` : ''}${m.session === S.session ? ' · из этого чата' : ''}${m.attached.length > 0 ? ` · подключалась ${m.attached.length}×` : ''}`,
      ),
      '',
      '/jevg ctx <id> — подключить к следующему сообщению.',
    ].join('\n');
  }
  const target = rest
    ? (list.find((m) => m.id === rest || m.id.endsWith(rest)) ?? (await readCapsule($, rest))?.meta)
    : list.find((m) => m.session !== S.session);
  if (!target) return rest ? `Капсула ${rest} не найдена. Список: /jevg ctx list` : none;
  if (target.session === S.session) return `Капсула ${target.id} сделана в этом же чате: подключать её сюда незачем.`;
  S.attachNext = target.id;
  return `Капсула ${target.id} («${target.title}», ~${kTokens(target.tokens)} токенов) будет подключена к вашему следующему сообщению.`;
}

/**
 * Suggests moving on with a fresh chat (only a suggestion, also in shadow
 * mode; at most once per 10 turns) when every step would re-read a large
 * old history for little reason: Jev sees a new task on a large context, or
 * the cache of a very large context went cold, so the next step re-writes
 * all of it anyway.
 */
async function suggestNewChat($: EngineInterface, text: string, outcome: MainOutcome): Promise<void> {
  const h = S.cfg.handoff;
  const p = outcome.signals?.newTopic ?? 0;
  const tokens = outcome.contextTokens ?? 0;
  const newTask = h.suggestAtTokens > 0 && p >= h.suggestAt && tokens >= h.suggestAtTokens;
  const cold = h.suggestColdAtTokens > 0 && outcome.cacheCold === true && tokens >= h.suggestColdAtTokens;
  if (!h.enabled || (!newTask && !cold)) return;
  if (S.mainTurns - S.hintTurn < 10 || text.includes(BRIEF_MARKER) || CTX_REF.test(text)) return;
  S.hintTurn = S.mainTurns;
  $.ui.toast(
    newTask
      ? `jev-governor: похоже, это новая задача, а контекст уже ${kTokens(tokens)} — каждый шаг перечитывает его. Дешевле продолжить с чистым чатом и капсулой: /jevg fresh`
      : `jev-governor: кэш остыл, и этот ход заново запишет ${kTokens(tokens)} контекста. Дешевле продолжить с чистым чатом и капсулой: /jevg fresh`,
    { timeoutMs: 15_000 },
  );
  await ledger($, {
    kind: 'hint',
    text: clip(text, 160),
    newTopic: p,
    reasons: [`context ${kTokens(tokens)}`, ...(newTask ? [] : ['cache cold'])],
  });
}

// ------------------------------------------------------------------- UI --

async function processDrafts($: EngineInterface): Promise<void> {
  if (S.draftsBusy || !S.cfg.enabled) return;
  S.draftsBusy = true;
  try {
    const dir = `${S.data}/drafts`;
    if (!(await $.fs.exists(dir))) return;
    for (const entry of await $.fs.list(dir)) {
      if (!entry.name.endsWith('.json')) continue;
      const path = `${dir}/${entry.name}`;
      const draft = (await readJson($, path)) as (DraftRecord & { worker?: string }) | undefined;
      if (!draft || draft.status !== 'pending' || typeof draft.request?.description !== 'string') continue;
      // Claim it, then make sure no other session claimed it at the same time.
      await $.fs.write(path, JSON.stringify({ ...draft, status: 'working', worker: S.session, updatedAt: nowIso() }, null, 2));
      await $.clock.sleep(400);
      const claimed = (await readJson($, path)) as { worker?: string } | undefined;
      if (claimed?.worker !== S.session) continue;
      const reply = await $.model.complete({
        model: S.cfg.agents.draftModel,
        system: DRAFT_SYSTEM,
        prompt: draftPrompt({
          task: draft.request.description,
          title: clip(draft.request.description, 80),
          project: S.project,
          agents: [...S.agents.values()],
          skills: [...S.skills.values()],
        }),
        maxTokens: 1500,
        effort: 'low',
        timeoutMs: S.cfg.agents.draftTimeoutMs,
      });
      const parsed = reply.isAnswered
        ? parseDraft(reply.text, { agents: new Set(S.agents.keys()), skills: S.skills }, nowIso())
        : undefined;
      if (parsed) parsed.agent.origin = 'manual';
      const done: DraftRecord = parsed
        ? { ...draft, status: 'done', result: parsed, updatedAt: nowIso() }
        : {
            ...draft,
            status: 'error',
            error: reply.isAnswered ? 'the reply was not a usable agent' : `model call failed: ${reply.reason}`,
            updatedAt: nowIso(),
          };
      await $.fs.write(path, `${JSON.stringify(done, null, 2)}\n`);
    }
  } catch (error) {
    await ledger($, { kind: 'error', error: `drafts: ${errorText(error)}` });
  } finally {
    S.draftsBusy = false;
  }
}

/** Writes the command descriptions the UI asked for (describe/*.json). */
async function processDescribe($: EngineInterface): Promise<void> {
  if (!S.cfg.enabled || !S.cfg.projects.enabled || !S.cfg.projects.describeWithClaude || S.describeBusy) return;
  const dir = `${S.data}/describe`;
  if (!(await $.fs.exists(dir))) return;
  S.describeBusy = true;
  try {
    await describeAll($, dir);
  } catch (error) {
    await ledger($, { kind: 'error', error: `describe: ${errorText(error)}` });
  } finally {
    S.describeBusy = false;
  }
}

async function describeAll($: EngineInterface, dir: string): Promise<void> {
  for (const entry of await $.fs.list(dir)) {
    if (!entry.name.endsWith('.json')) continue;
    const path = `${dir}/${entry.name}`;
    const request = (await readJson($, path)) as DescribeRequest | undefined;
    if (!request || request.status !== 'pending' || !Array.isArray(request.items) || request.items.length === 0) continue;
    await $.fs.write(path, JSON.stringify({ ...request, status: 'working', worker: S.session, updatedAt: nowIso() }, null, 2));
    await $.clock.sleep(400);
    const claimed = (await readJson($, path)) as { worker?: string } | undefined;
    if (claimed?.worker !== S.session) continue;
    const items = request.items.slice(0, 60).map((i) => ({ ...i, source: i.source as never }));
    const reply = await $.model.complete({
      model: S.cfg.agents.draftModel,
      system: describeSystem(request.lang === 'en' ? 'en' : 'ru'),
      prompt: describePrompt(request.project, items),
      maxTokens: 4000,
      effort: 'low',
      timeoutMs: S.cfg.agents.draftTimeoutMs * 2,
    });
    const results = reply.isAnswered ? parseDescriptions(reply.text, new Set(items.map((i) => i.id))) : {};
    const done: DescribeRequest =
      Object.keys(results).length > 0
        ? { ...request, status: 'done', results, updatedAt: nowIso() }
        : {
            ...request,
            status: 'error',
            error: reply.isAnswered ? 'the reply had no usable descriptions' : `model call failed: ${reply.reason}`,
            updatedAt: nowIso(),
          };
    await $.fs.write(path, `${JSON.stringify(done, null, 2)}\n`);
  }
}

async function startUi($: EngineInterface): Promise<string> {
  const server = `${$.plugin.root}/ui/server.ts`;
  if (!(await $.fs.exists(server))) return `UI server not found at ${server}.`;
  const candidates = [S.cfg.ui.nodePath, '/opt/homebrew/bin/node', '/usr/local/bin/node', `${S.home}/.local/bin/node`];
  for (const node of candidates) {
    try {
      const run = await $.process.run(
        [node, server, '--detach', '--port', String(S.cfg.ui.port), '--data', S.data],
        { timeoutMs: 15_000 },
      );
      if (run.exitCode === 0) return run.stdout.trim() || `UI: http://127.0.0.1:${S.cfg.ui.port}`;
    } catch {
      // try the next node
    }
  }
  return `Could not start the UI. Run it yourself: node "${server}" --port ${S.cfg.ui.port}`;
}

/**
 * `/jevg chat on|off`: the mod does nothing in this chat (no routing, compaction, trimming, requests to Jev).
 * `/jevg idle on|off`: compact this chat after a pause even when the setting is off. Both belong to the chat.
 */
async function chatCommand($: EngineInterface, which: 'chat' | 'idle', arg: string): Promise<string> {
  await loadConfig($, false);
  const show = (): string =>
    `This chat: mod ${S.chat.off ? 'OFF' : 'on'}; compaction after a pause ${S.cfg.compaction.onReturn ? 'on (setting)' : S.chat.idle ? 'on (this chat)' : 'off'}.`;
  if (arg !== 'on' && arg !== 'off') return `${show()}\nUsage: /jevg ${which} on|off`;
  const on = arg === 'on';
  if (which === 'chat') {
    S.chat = { ...S.chat, off: !on };
    if (!on) {
      S.turn = undefined;
      S.idleTimer?.cancel();
      S.idleTimer = undefined;
      $.ui.status('jev ▸ off in this chat');
    } else {
      scheduleIdle($);
      $.ui.status('jev ▸ on');
    }
  } else {
    S.chat = { ...S.chat, idle: on };
    scheduleIdle($);
  }
  await saveChat($);
  await applyAutoWindow($, false);
  await ledger($, { kind: 'chat', text: `/jevg ${which} ${arg}`, reasons: [`chat ${S.chat.off ? 'off' : 'on'}, idle ${S.chat.idle ? 'on' : 'off'}`] });
  return `${show()}${which === 'chat' && !on ? ' Nothing is sent to Jev and nothing is changed until /jevg chat on.' : ''}`;
}

async function statusReport($: EngineInterface): Promise<string> {
  const budget = await pressureNow($);
  const cfg = S.cfg;
  const prev = S.route.previous;
  const lines = [
    `jev-governor ${cfg.enabled ? (S.chat.off ? 'OFF in this chat (/jevg chat on)' : `ON (${shadow() ? 'наблюдение' : 'active'})`) : 'OFF'} · key ${S.key ? 'found' : 'MISSING'} · Jev ${cfg.jev.model}${isExcluded(cfg, S.cwd, S.home) ? ' · проект исключён: к Jev ничего не уходит' : ''}`,
    `routing: main model ${cfg.router.mainModel ? 'on' : 'off'}, main effort ${cfg.router.mainEffort ? 'on' : 'off'}, subagents ${cfg.router.subagents ? 'on' : 'off'}; compaction ${cfg.compaction.enabled ? `on (at ${Math.round(cfg.compaction.compactAtTokens / 1000)}k${cfg.compaction.archive ? ', archive' : ''})` : 'off'}; handoff ${cfg.handoff.enabled ? 'on' : 'off'}`,
    `last: ${S.route.lastModel ? displayModel(S.route.lastModel) : '—'}${prev ? ` · ${prev.effort}` : ''} · budget ${budget.text || 'n/a'} (pressure ${budget.pressure})`,
    `agents: ${S.agents.size} (${[...S.agents.keys()].slice(0, 12).join(', ') || 'none yet'}) · skills: ${S.skills.size}`,
    `data: ${S.data}`,
    'commands: /jevg status | on | off | chat on|off | idle on|off | ui | reload | fresh [--brief|--nobrief] [фокус] | getctx [--brief|--nobrief] [фокус] | ctx [list|<id>]',
  ];
  return lines.join('\n');
}

// ------------------------------------------------------------------ init --

/**
 * Binds the mod to the session: paths, config, key, registry, the /jevg
 * command, timers. Runs at `session.start` (the process's first, and again
 * when this code is reloaded), and from the first hook when this load of the
 * module has not bound itself yet.
 */
async function bindSession($: EngineInterface, starting: boolean): Promise<void> {
  boundHere = true;
  try {
    S.home = (await $.env.get('HOME')) ?? '';
    S.data = (await $.env.get('JEV_GOVERNOR_HOME')) || `${S.home}/.claude/jev-governor`;
    const session = await $.session.id();
    // `S` outlived a reload that came after a /clear: what it holds is the old conversation's.
    if (S.session && S.session !== session) resetConversation();
    S.session = session;
    S.sessionEnded = false;
    S.cwd = await projectRoot($);
    S.project = basename(S.cwd);
    await loadConfig($, true);
    await loadKey($);
    await applyAutoWindow($, true);
    await restoreRoute($);
    await restoreChat($);
    await applyAutoWindow($, false);
    await loadRegistry($);
    await registerAll($);
    void pruneOutputs($);
    void pruneCapsules($);
    // A resumed session that idled past the cache TTL: compact before the first prompt.
    if (starting) void compactIdle($, 'resumed session');
    await $.command.register({
      name: 'jevg',
      description: 'jev-governor: status, on, off, chat on|off (this chat only), idle on|off (compact after a pause in this chat), ui, reload; fresh — продолжить в этом окне с чистым чатом и капсулой; getctx — капсула для нового чата, ctx — подключить её',
      argumentHint: '[status|on|off|chat on|off|idle on|off|ui|reload|fresh [фокус]|getctx [фокус]|ctx [list|id]]',
    });
    $.clock.every(8000, () => {
      void processDrafts($).then(() => processDescribe($)).catch(() => undefined);
    });
    if (!S.key) $.ui.log('jev-governor: no OpenRouter key found; routing is off until one is set (/jevg status).');
  } catch (error) {
    $.ui.log(`jev-governor: start failed (${errorText(error)})`);
  }
}

/**
 * After `/clear` (or a resume) the process goes on under a new session id and
 * no `session.start` comes: the per-conversation state starts over. What
 * `/jevg fresh` set up to attach (`attachNext`) carries over on purpose.
 */
async function rebindConversation($: EngineInterface): Promise<void> {
  S.sessionEnded = false;
  try {
    const id = await $.session.id();
    if (id === S.session) return;
    S.session = id;
  } catch {
    return;
  }
  resetConversation();
  await refreshCwd($);
  await restoreRoute($);
  await restoreChat($);
  await applyAutoWindow($, false);
}

/** Per-conversation state back to a new conversation's (what `/jevg fresh` set up to attach stays). */
function resetConversation(): void {
  S.idleTimer?.cancel();
  S.idleTimer = undefined;
  S.handoff?.timer?.cancel();
  S.handoff = undefined;
  S.route = { freeSwitch: true };
  S.chat = { off: false, idle: false };
  S.turn = undefined;
  S.subs.clear();
  S.pending = [];
  S.calls.clear();
  S.mainTurns = 0;
  S.hintTurn = -Infinity;
  S.lastMainStepAt = undefined;
  S.jevFailures = 0;
}

/**
 * Whether this load of the module has bound itself (`S`, in mod/state.ts, may
 * outlive a reload of this file alone, but the command and timers do not).
 */
let boundHere = false;

/** The mod's state after a hot reload is empty: bind it once, from whichever hook comes first. */
async function ensureInit($: EngineInterface): Promise<void> {
  if (!boundHere) S.initializing = undefined;
  if (S.data && boundHere) {
    if (S.sessionEnded) await rebindConversation($);
    return;
  }
  S.initializing ??= bindSession($, false);
  await S.initializing;
}

// --------------------------------------------------------------- register --

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e);
    S.initializing = bindSession($, true);
    await S.initializing;
    return result;
  });

  on('session.end', async ($, e, next) => {
    const result = await next(e);
    if (e.reason === 'clear' || e.reason === 'resume') {
      S.sessionEnded = true;
      // The idle compaction was for the conversation that just ended.
      S.idleTimer?.cancel();
      S.idleTimer = undefined;
    }
    return result;
  });

  on('command.run', { command: 'jevg' }, async ($, e) => {
    await ensureInit($);
    const raw = e.args.trim();
    const sub = raw.split(/\s+/)[0]?.toLowerCase() ?? '';
    if (sub === 'getctx') return { text: await startHandoff($, raw.slice(sub.length)) };
    if (sub === 'fresh') return { text: await startHandoff($, raw.slice(sub.length), true) };
    if (sub === 'ctx') return { text: await attachCommand($, raw.slice(sub.length).trim()) };
    const arg = raw.toLowerCase();
    if (arg === 'on' || arg === 'off') {
      await loadConfig($, true);
      S.cfg = { ...S.cfg, enabled: arg === 'on' };
      await saveConfig($);
      return { text: `jev-governor ${arg === 'on' ? 'enabled' : 'disabled'}.` };
    }
    if (sub === 'chat' || sub === 'idle') return { text: await chatCommand($, sub, raw.slice(sub.length).trim().toLowerCase()) };
    if (arg === 'ui') return { text: await startUi($) };
    if (arg === 'reload') {
      await loadConfig($, true);
      await loadKey($);
      S.registrySig = '';
      await loadRegistry($);
      await registerAll($);
      return { text: `Reloaded. ${S.agents.size} agents, ${S.skills.size} skills, key ${S.key ? 'found' : 'missing'}.` };
    }
    return { text: await statusReport($) };
  });

  on('turn.start', async ($, e, next) => {
    await ensureInit($);
    S.idleTimer?.cancel();
    S.idleTimer = undefined;
    S.mainTurns++;
    const brief = S.handoff !== undefined && S.handoff.turnId === undefined && e.text.includes(BRIEF_MARKER);
    if (brief) S.handoff!.turnId = e.turnId;
    await loadConfig($, false);
    await refreshCwd($);
    // The handoff brief runs on the chat's own model (turn.step): nothing to ask Jev.
    if (!active() || !jevKey() || brief) {
      S.turn = undefined;
      return next(e);
    }
    const decision = decideMainTurn($, e.text).catch(async (error) => {
      await ledger($, { kind: 'error', error: `decide: ${errorText(error)}` });
      return undefined;
    });
    S.turn = { id: e.turnId, text: e.text, decision, errors: 0, logged: false, steps: 0 };
    return next(e);
  });

  on('turn.step', async function* ($, e, next) {
    await ensureInit($);
    if (e.agentId === undefined) S.lastMainStepAt = Date.now();
    // The handoff brief: same model (its cache is what makes it cheap), no deep reasoning needed.
    if (e.agentId === undefined && S.handoff?.turnId === e.turnId) {
      S.route.lastRequestAt = Date.now();
      return yield* next(e.effort === undefined ? e : { ...e, effort: 'medium' });
    }
    if (!active()) return yield* next(e);

    if (e.agentId !== undefined) {
      if (shadow()) return yield* next(e);
      const sub = S.subs.get(e.agentId) ?? (await claimPending($, e.agentId));
      if (!sub || !S.cfg.router.subagents) return yield* next(e);
      sub.steps++;
      if (sub.baseEffort === undefined && typeof e.effort === 'string') sub.baseEffort = e.effort;
      const steps = S.cfg.router.escalateAfterErrors > 0 ? Math.floor(sub.errors / S.cfg.router.escalateAfterErrors) : 0;
      if (sub.light) {
        // The light model has no effort to send. Its window is smaller and it reasons less: a growing
        // task or failing tools move it to the standard model (one cache rewrite, once).
        if (sub.steps <= S.cfg.router.lightMaxSteps && steps === 0) return yield* next(e);
        sub.light = false;
        sub.tier = 'standard';
        sub.model = S.cfg.models.standard;
        await ledger($, {
          kind: 'light-up',
          scope: 'subagent',
          agentId: e.agentId,
          model: S.cfg.models.standard,
          reasons: [steps > 0 ? 'light subagent: tool errors, moved to the standard model' : `light subagent: ${sub.steps} steps, moved to the standard model`],
        });
        return yield* next({ ...e, model: S.cfg.models.standard, effort: escalate(sub.effort, Math.min(2, steps), S.cfg) });
      }
      if (steps > 0) sub.escalated = Math.max(sub.escalated ?? 0, Math.min(2, steps));
      return yield* next({ ...e, ...(sub.model ? { model: sub.model } : {}), effort: escalate(sub.effort, Math.min(2, steps), S.cfg) });
    }

    const turn = S.turn;
    if (!turn || turn.id !== e.turnId) return yield* next(e);
    turn.steps++;
    if (turn.baseModel === undefined) turn.baseModel = e.model;
    if (turn.baseEffort === undefined && typeof e.effort === 'string') {
      turn.baseEffort = e.effort;
      // The session's own effort changed between turns: the person set it (/effort), not us.
      const before = S.route.lastBaseEffort;
      S.route.lastBaseEffort = e.effort;
      if (before !== undefined && before !== e.effort) {
        await ledger($, { kind: 'override', scope: 'main', text: clip(turn.text, 160), effort: e.effort, reasons: [`effort ${before} → ${e.effort}`] });
      }
    }
    const outcome = await turn.decision;
    if (!outcome) return yield* next(e);

    const { decision } = outcome;
    const applied = !shadow();
    // Keep the session's exact id when it already is the chosen tier (same cache).
    const model =
      S.cfg.router.mainModel && tierOf(e.model, S.cfg) !== decision.tier ? S.cfg.models[decision.tier] : e.model;
    const steps = S.cfg.router.escalateAfterErrors > 0 ? Math.floor(turn.errors / S.cfg.router.escalateAfterErrors) : 0;
    const effort =
      S.cfg.router.mainEffort && !decision.keepEffort ? escalate(decision.effort, Math.min(2, steps), S.cfg) : undefined;
    if (effort && steps > 0) turn.escalated = Math.max(turn.escalated ?? 0, Math.min(2, steps));
    const prevModel = S.route.lastModel;
    S.route.lastModel = applied ? model : e.model;
    S.route.lastRequestAt = Date.now();
    const wasFree = S.route.freeSwitch;
    S.route.freeSwitch = false;
    if (!decision.keepEffort) S.route.previous = { tier: decision.tier, effort: decision.effort };

    if (!turn.logged) {
      turn.logged = true;
      const switched = prevModel !== undefined && tierOf(prevModel, S.cfg) !== tierOf(model, S.cfg);
      // A /model switch rewrites the cache too, whoever made it.
      turn.rewroteCache = (switched && (applied || outcome.manual === true)) || wasFree || outcome.cacheCold === true;
      // What the mod's own switch cost: a warm cache rewritten on the other model (savings count it).
      const rewrite = switched && applied && !outcome.manual && !wasFree && !outcome.cacheCold ? outcome.contextTokens : undefined;
      const shown = statusText(model, effort ?? (typeof e.effort === 'string' ? e.effort : undefined), outcome.pressureText);
      // While Jev fails, the ✕ stays (a bare "go on" decided without Jev would hide it).
      if (S.cfg.ui.showStatus && S.jevFailures < JEV_FAILS_SHOWN) $.ui.status(applied ? shown : `${shown} (наблюдение)`);
      if (switched && applied) {
        $.ui.log(`jev-governor: ${displayModel(prevModel ?? '')} → ${displayModel(model)} (${decision.reasons.join('; ')})`);
      }
      await ledger($, {
        kind: 'turn',
        scope: 'main',
        text: clip(turn.text, 160),
        model,
        prevModel,
        effort,
        switched,
        ...(rewrite ? { rewrite } : {}),
        pStrong: outcome.signals?.pStrong,
        effortScore: outcome.signals?.effortExpected,
        risky: outcome.signals?.risky,
        continuation: outcome.signals?.continuation,
        newTopic: outcome.signals?.newTopic,
        correction: outcome.signals?.correction,
        ...(outcome.local ? { local: true } : {}),
        pressure: outcome.pressure,
        reasons: decision.reasons,
        jevMs: outcome.jevMs,
        jevCost: outcome.jevCost,
        applied,
        rate: outcome.rate,
        baseModel: turn.baseModel,
        baseEffort: turn.baseEffort,
      });
      await suggestNewChat($, turn.text, outcome);
    }
    if (!applied) return yield* next(e);
    if (effort) turn.sentEffort = effort;
    return yield* next({ ...e, model, ...(effort ? { effort } : {}) });
  });

  on('tool.call', async ($, e, next) => {
    await ensureInit($);
    const tool: string = e.tool;
    if ((tool === 'Read' || tool === 'Grep' || tool === 'Bash') && S.data) {
      // Grep may be a Bash `grep`/`rg` in builds without a Grep tool.
      const input = e as unknown as { file_path?: unknown; path?: unknown; pattern?: unknown; command?: unknown };
      const target = tool === 'Bash' ? input.command : (input.file_path ?? input.path);
      if (typeof target === 'string' && (target.includes(`${S.data}/outputs/`) || target.includes('/tool-results/'))) {
        await ledger($, {
          kind: 'output-read',
          scope: e.agentId ? 'subagent' : 'main',
          agentId: e.agentId,
          text: `${tool} ${clip(target, 160)}${typeof input.pattern === 'string' ? ` /${clip(input.pattern, 60)}/` : ''}`,
        });
      }
    }
    if (e.tool_use_id) {
      const command = e.tool === 'Bash' && typeof e.command === 'string' ? e.command : undefined;
      S.calls.set(e.tool_use_id, { tool: e.tool, command, agentId: e.agentId });
      if (S.calls.size > 500) S.calls.delete(S.calls.keys().next().value as string);
    }
    const result = await next(e);
    if (e.tool_use_id && result.deny === undefined) {
      const saved = (result.result as { persistedOutputPath?: unknown } | undefined)?.persistedOutputPath;
      const call = S.calls.get(e.tool_use_id);
      if (call && typeof saved === 'string') call.persisted = saved;
    }
    if (e.agentId === undefined && S.route.pruned && result.deny === undefined) {
      const input = e as unknown as Record<string, unknown>;
      const key = rerunKey(tool, input);
      const label = key ? S.route.pruned[key] : undefined;
      if (key && label !== undefined) {
        delete S.route.pruned[key];
        await ledger($, { kind: 'rerun-after-prune', scope: 'main', text: label });
      }
      // The file changed: reading it again is reading the new version, not a pruned output.
      const edited = editedPath(tool, input);
      if (edited) delete S.route.pruned[`Read:${edited}`];
    }
    if (tool === 'Bash' && active() && S.cfg.projects.enabled && S.cfg.projects.learnFromClaude && S.cwd && result.deny === undefined) {
      const command = (e as unknown as { command?: unknown }).command;
      const seen = typeof command === 'string' ? normalizeObserved(command) : undefined;
      // The shell may have `cd`-ed into a subfolder: the command is the project's, run from there.
      const shell = seen ? await $.session.cwd().catch(() => S.cwd) : S.cwd;
      const dir = seen ? commandDir(S.cwd, shell, seen.dir) : undefined;
      if (seen && dir !== undefined) {
        await ledger($, {
          kind: 'command',
          scope: e.agentId ? 'subagent' : 'main',
          agentId: e.agentId,
          cwd: S.cwd,
          command: seen.command,
          ...(dir ? { dir } : {}),
          success: result.isError !== true,
        });
      }
    }
    if (result.deny === undefined && result.isError === true) {
      if (e.agentId !== undefined) {
        const sub = S.subs.get(e.agentId);
        if (sub) sub.errors++;
      } else if (S.turn) {
        S.turn.errors++;
      }
    }
    return result;
  });

  on('agent.offer', ($, e, next) => {
    if (!e.agent.startsWith(`${PLUGIN}:`) || S.cfg.agents.exposeToModel) return next(e);
    return { isOffered: false };
  });

  on('agent.spawn', async ($, e, next) => {
    await ensureInit($);
    if (!active() || !jevKey() || e.fork || (!S.cfg.router.subagents && !S.cfg.agents.enabled)) return next(e);
    let plan: SpawnPlan | undefined;
    try {
      plan = await planSpawn($, e);
    } catch (error) {
      await ledger($, { kind: 'error', error: `spawn plan: ${errorText(error)}` });
    }
    if (!plan) return next(e);
    if (shadow()) {
      const result = await next(e);
      await ledger($, {
        kind: 'subagent',
        scope: 'subagent',
        agentId: result.agentId,
        subagentType: e.subagentType,
        agent: plan.agent?.name,
        text: clip(e.description, 160),
        model: plan.model ?? result.model,
        effort: plan.decision?.effort,
        pStrong: plan.signals?.pStrong,
        effortScore: plan.signals?.effortExpected,
        risky: plan.signals?.risky,
        pressure: plan.pressure,
        reasons: [...(plan.decision?.reasons ?? []), `ran as ${result.model ?? e.parentModel}`],
        ...(plan.decision?.light ? { light: true, lightApplied: false } : {}),
        jevMs: plan.jevMs,
        jevCost: plan.jevCost,
        applied: false,
        rate: plan.rate,
      });
      return result;
    }
    const sub: SubState | undefined = plan.decision
      ? {
          tier: plan.decision.tier,
          ...(plan.decision.light && S.cfg.router.lightSubagents === 'on' ? { light: true } : {}),
          effort: plan.decision.effort,
          agent: plan.agent?.name,
          errors: 0,
          steps: 0,
          baseModel: e.model ?? e.parentModel,
        }
      : undefined;
    const pending: PendingSpawn | undefined = sub ? { promptKey: promptKey(plan.prompt), sub, at: Date.now() } : undefined;
    if (pending) S.pending.push(pending);
    const model = plan.model ? { model: plan.model } : {};
    let result;
    try {
      result = await next({ ...e, prompt: plan.prompt, ...model });
    } finally {
      if (pending) S.pending = S.pending.filter((p) => p !== pending);
    }
    if (result.agentId && sub && !S.subs.has(result.agentId)) S.subs.set(result.agentId, sub);
    if (S.subs.size > 200) S.subs.delete(S.subs.keys().next().value as string);
    await ledger($, {
      kind: 'subagent',
      scope: 'subagent',
      agentId: result.agentId,
      subagentType: e.subagentType,
      agent: plan.agent?.name,
      created: plan.created,
      text: clip(e.description, 160),
      model: plan.model ?? result.model,
      effort: plan.decision?.effort,
      pStrong: plan.signals?.pStrong,
      effortScore: plan.signals?.effortExpected,
      risky: plan.signals?.risky,
      pressure: plan.pressure,
      reasons: [
        ...(plan.decision?.reasons ?? []),
        ...(plan.agent && plan.prompt.startsWith('<role>') && !e.prompt.startsWith('<role>') ? [`specialist ${plan.agent.name} (role prepended)`] : []),
        ...(plan.prompt.includes('<cache-note>') && !e.prompt.includes('<cache-note>') ? ['wait note added'] : []),
        ...(result.deny ? [`denied: ${result.deny}`] : []),
      ],
      jevMs: plan.jevMs,
      jevCost: plan.jevCost,
      ...(plan.decision?.light ? { light: true, lightApplied: sub?.light === true } : {}),
      applied: true,
      rate: plan.rate,
      baseModel: e.model ?? e.parentModel,
    });
    return result;
  });

  on('turn.complete', async ($, e, next) => {
    await ensureInit($);
    const result = await next(e);
    const pending = S.handoff;
    const briefTurn = e.agentId === undefined && pending?.turnId === e.turnId;
    if (briefTurn && pending) {
      S.handoff = undefined;
      pending.timer?.cancel();
      // Interrupted (Esc), failed or refused: no brief. For /jevg fresh that stops it, the chat stays.
      const answered = e.reason === 'answer' && e.answer.trim().length > 0;
      const why = e.reason === 'aborted' ? 'бриф прерван' : e.reason === 'answer' ? 'бриф пустой' : `бриф не получен: ${e.reason}`;
      // Not from inside turn.complete (the turn waits on it): just after it.
      $.clock.after(300, () => {
        if (pending.fresh && !answered) {
          void cancelFresh($, pending.id, why);
          return;
        }
        void finishHandoff($, pending.id, pending.focus, answered ? e.answer : undefined, answered ? undefined : `brief failed: ${e.reason}`, pending.fresh).then((text) =>
          $.ui.log(text),
        );
      });
    }
    if (!active()) return result;
    if (e.usage) {
      const rate = e.agentId === undefined ? (await pressureNow($)).rate : undefined;
      await ledger($, {
        rate,
        applied: !shadow(),
        kind: 'usage',
        scope: e.agentId ? 'subagent' : 'main',
        agentId: e.agentId,
        agent: e.agentId ? S.subs.get(e.agentId)?.agent : undefined,
        ...usageBase(e.agentId, e.usage.model),
        usage: {
          model: e.usage.model,
          input: e.usage.input_tokens,
          output: e.usage.output_tokens,
          cacheRead: e.usage.cache_read_input_tokens,
          cacheWrite: e.usage.cache_creation_input_tokens,
        },
      });
    }
    // A /jevg fresh brief: the chat is about to be cleared, nothing to learn, idle or compact.
    if (e.agentId === undefined && !(briefTurn && pending?.fresh)) {
      if (e.usage && !e.isAborted && !briefTurn) learnTurn(e.usage, S.turn?.id === e.turnId && S.turn.rewroteCache === true);
      await saveRoute($);
      scheduleIdle($);
      const k = S.cfg.compaction;
      if (k.enabled && (k.compactAtTokens > 0 || k.compactAtPercent > 0) && jevKey() && !S.compacting && !shadow()) {
        try {
          const { context } = await $.session.usage();
          const tokens = context.tokens ?? 0;
          const due =
            (k.compactAtTokens > 0 && tokens >= k.compactAtTokens) ||
            (k.compactAtPercent > 0 && (context.percent ?? 0) >= k.compactAtPercent);
          const grown = S.route.compactedAt === undefined || tokens - S.route.compactedAt >= k.recompactAfterTokens;
          if (due && grown) {
            S.route.compactedAt = tokens;
            // Not from inside turn.complete (the turn waits on it): just after it.
            $.clock.after(1500, () => {
              void requestCompaction($, 'threshold').catch(async (error) => {
                await ledger($, { kind: 'error', error: `auto-compact: ${errorText(error)}` });
              });
            });
          }
        } catch (error) {
          await ledger($, { kind: 'error', error: `auto-compact: ${errorText(error)}` });
        }
      }
    }
    return result;
  });

  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    await ensureInit($);
    if (!active() || !S.cfg.trim.enabled) return next(e);
    let changed = false;
    const content: Record<string, unknown>[] = [];
    for (const block of e.message.content as Record<string, unknown>[]) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
        content.push(block);
        continue;
      }
      const text = resultText(block);
      const trimmed = text === undefined ? undefined : await trimResult($, block.tool_use_id, text, block.is_error === true).catch(() => undefined);
      if (trimmed) await ledger($, trimmed.entry);
      if (trimmed && trimmed.entry.applied) {
        changed = true;
        content.push({ ...block, content: [{ type: 'text', text: trimmed.text }] });
      } else {
        content.push(block);
      }
    }
    if (!changed) return next(e);
    return next({ ...e, message: { ...e.message, content: content as typeof e.message.content } });
  });

  on('prompt.submit', async ($, e, next) => {
    await ensureInit($);
    // /jevg fresh under way: typed now, a prompt would run on the old context and then be wiped by
    // /clear. It waits and goes in after the clear, with the capsule.
    const typed = e.origin === undefined || e.origin.kind === 'composer' || e.origin.kind === 'bridge';
    if ((S.handoff?.fresh || S.clearing) && typed && !e.text.includes(BRIEF_MARKER) && e.text.trim()) {
      S.held.push(e.text);
      return {
        drop: `jev-governor: сообщение придержано — оно уйдёт сразу после очистки чата, вместе с капсулой${e.attachments?.length ? ' (вложения прикрепите заново)' : ''}.`,
      };
    }
    if (!S.cfg.enabled || !S.cfg.handoff.enabled || !S.data || e.text.includes(BRIEF_MARKER)) return next(e);
    const ref = CTX_REF.exec(e.text)?.[1];
    const id = ref ?? S.attachNext;
    if (!id) return next(e);
    const capsule = await readCapsule($, id);
    // A capsule is for another chat: a reference to it in its own chat is just text.
    if (!capsule || capsule.meta.session === S.session) return next(e);
    S.attachNext = undefined;
    const result = await next({
      ...e,
      text: ref ? attachedPrompt(e.text) : e.text,
      context: [...(e.context ?? []), capsule.text],
    });
    // Refused below: the capsule waits for the prompt that does enter.
    if (result.drop && !ref) S.attachNext = id;
    if (!result.drop) {
      const meta: CapsuleRecord = { ...capsule.meta, attached: [...new Set([...(capsule.meta.attached ?? []), S.session])] };
      try {
        await $.fs.write(`${handoffDir()}/${id}.json`, `${JSON.stringify(meta, null, 2)}\n`);
      } catch {
        // the attach itself worked
      }
      await ledger($, {
        kind: 'handoff',
        text: clip(meta.title, 160),
        handoff: { action: 'attach', id, tokens: meta.tokens, sourceTokens: meta.sourceTokens, turns: meta.turns, path: meta.path },
      });
      $.ui.toast(`jev-governor: подключён контекст прошлого чата (~${kTokens(meta.tokens)} токенов)`, { timeoutMs: 6000 });
    }
    return result;
  });

  on('tool.check', async ($, e, next) => {
    await ensureInit($);
    const tool: string = e.tool;
    if (tool !== 'Read' && tool !== 'Grep') return next(e);
    const input = e as unknown as { file_path?: unknown; path?: unknown };
    if (await isSavedOutput($, input.file_path ?? input.path)) return { decision: 'allow' };
    return next(e);
  });

  on('session.compact', async ($, e, next) => {
    await ensureInit($);
    const markFree = (): void => {
      if (e.agentId === undefined && e.trigger !== 'precompute') S.route.freeSwitch = true;
    };
    const k = S.cfg.compaction;
    const key = jevKey();
    if (!active() || !k.enabled || !key || shadow()) {
      const result = await next(e);
      if (result.messages) markFree();
      return result;
    }
    // A precompute would only be kept for the compaction that comes, which runs this hook
    // anyway: pruning now would ask Jev twice and archive twice. Nothing is computed or kept.
    if (e.trigger === 'precompute') return { skip: 'jev-governor: Jev prunes when the compaction comes' };
    const who = { scope: e.agentId === undefined ? ('main' as const) : ('subagent' as const), agentId: e.agentId };
    const inner = makeAsker($, key, 'compaction');
    let jevCost = 0;
    const startedAt = Date.now();
    const asker = {
      ask: async (state: string | object, questions: JevQuestions) => {
        const response = await inner.ask(state, questions);
        jevCost += response.usage?.cost ?? 0;
        return response;
      },
    };
    let fallback = '';
    try {
      const { result, messages, ratio } = await runCompaction(e.messages, asker, {
        keepThreshold: k.keepThreshold,
        preserveRecentMessages: k.preserveRecentMessages,
        truncateHeadChars: k.truncateHeadChars,
        maxStateTokens: k.maxStateTokens,
        maxRequestTokens: k.maxRequestTokens,
        resultPreviewChars: k.resultPreviewChars,
        previewFilter: (text) => redact(text).text,
        maxPruneRatio: k.maxPruneRatio,
      });
      // Claude Code's own trigger well under the model's limit: the smaller window the mod set fired it.
      const byWindow =
        e.trigger === 'auto' && S.autoWindow !== undefined && result.stats.charsBefore / 3.5 < S.autoWindow * 1.5;
      const reason: 'engine' | 'threshold' | 'return' | 'window' =
        e.agentId === undefined && S.compactReason
          ? S.compactReason
          : e.agentId === undefined && e.trigger === 'plugin'
            ? 'threshold'
            : byWindow
              ? 'window'
              : 'engine';
      const stats = {
        charsBefore: result.stats.charsBefore,
        charsAfter: result.stats.charsAfter,
        ratio,
        requests: result.stats.requests,
        reason,
        ...(result.stats.restored ? { restored: result.stats.restored } : {}),
        ...(e.agentId === undefined && S.compactVia ? { via: S.compactVia } : {}),
        trigger: e.trigger,
      };
      const minimum =
        reason === 'return' ? k.onReturnMinReduction : reason === 'threshold' ? k.thresholdMinReduction : k.minReductionRatio;
      if (ratio >= minimum) {
        let kept: readonly Message[] = messages;
        let archived = 0;
        const pruned = prunedOf(e.messages, result.decisions);
        const installed = e.agentId === undefined;
        if (installed) {
          rememberPruned(pruned);
          void saveRoute($);
        }
        if (k.archive) {
          try {
            ({ messages: kept, archived } = await archivePruned($, e.messages, messages, pruned));
          } catch (error) {
            await ledger($, { kind: 'error', error: `archive: ${errorText(error)}` });
          }
        }
        if (installed) S.route.compactedAt = Math.round((S.route.compactedAt ?? 0) * (1 - ratio)) || undefined;
        markFree();
        await ledger($, {
          kind: 'compact',
          ...who,
          text: summarizeCompaction(result),
          compaction: { ...stats, archived },
          jevCost,
          jevMs: Date.now() - startedAt,
          model: e.agentId === undefined ? S.route.lastModel : subModel(e.agentId),
        });
        $.ui.toast(`jev-governor: compacted without a summary (${summarizeCompaction(result)})`, { timeoutMs: 8000 });
        return { messages: kept as typeof e.messages };
      }
      fallback = `reduction ${Math.round(ratio * 100)}% below ${Math.round(minimum * 100)}%`;
      if (reason === 'return' || reason === 'threshold') {
        // Our own trigger and not worth it: a summary instead would cost a full read and lose detail.
        await ledger($, { kind: 'compact', ...who, text: `skipped (${reason})`, compaction: { ...stats, fallback }, jevCost });
        return { skip: `jev-governor: compaction skipped (${fallback})` };
      }
      await ledger($, { kind: 'compact', ...who, text: 'fallback to built-in summary', compaction: { ...stats, fallback }, jevCost });
    } catch (error) {
      fallback = errorText(error);
      await ledger($, { kind: 'compact', ...who, text: 'fallback to built-in summary', compaction: { charsBefore: 0, charsAfter: 0, ratio: 0, requests: 0, fallback, trigger: e.trigger } });
    }
    $.ui.log(`jev-governor: built-in compaction (${fallback})`);
    const result = await next(e);
    if (result.messages) markFree();
    return result;
  });
};
