// Specialist subagents and their skills: validation, prompt composition,
// candidate ranking and the drafting prompt. Pure: storage lives in the hook.

import type { ChoiceQuestion } from './jev.ts';
import { EFFORTS, type AgentRecord, type Effort, type SkillRecord, type Tier } from './types.ts';

export const PLUGIN = 'jev-governor';
export const NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;
export const LIMITS = { description: 200, prompt: 1500, skillBody: 2000, skillsPerAgent: 4 } as const;
export const KNOWN_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
] as const;

export function agentType(name: string): string {
  return `${PLUGIN}:${name}`;
}

export function slug(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return /^[a-z]/.test(base) ? base : `a-${base}`.slice(0, 40);
}

export function uniqueName(wanted: string, taken: ReadonlySet<string>): string {
  const base = NAME_RE.test(wanted) ? wanted : slug(wanted || 'agent');
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const name = `${base.slice(0, 36)}-${i}`;
    if (!taken.has(name)) return name;
  }
  return `${base.slice(0, 30)}-${Date.now() % 100000}`;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function isTier(value: unknown): value is Tier {
  return value === 'standard' || value === 'strong';
}

function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value);
}

/** Validates a stored or drafted agent; returns undefined when unusable. */
export function sanitizeAgent(raw: unknown, now: string): AgentRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' && NAME_RE.test(r.name) ? r.name : undefined;
  const description = text(r.description, LIMITS.description);
  const prompt = text(r.prompt, LIMITS.prompt);
  if (!name || !description || !prompt) return undefined;
  const tools = Array.isArray(r.tools)
    ? r.tools.filter((t): t is string => typeof t === 'string' && /^[A-Za-z_][\w:-]*$/.test(t))
    : undefined;
  const skills = Array.isArray(r.skills)
    ? r.skills.filter((s): s is string => typeof s === 'string' && NAME_RE.test(s)).slice(0, LIMITS.skillsPerAgent)
    : [];
  return {
    name,
    description,
    prompt,
    ...(tools && tools.length > 0 ? { tools } : {}),
    skills,
    tier: isTier(r.tier) ? r.tier : 'auto',
    effort: isEffort(r.effort) ? r.effort : 'auto',
    enabled: r.enabled !== false,
    origin: r.origin === 'manual' ? 'manual' : 'auto',
    ...(typeof r.uses === 'number' && Number.isFinite(r.uses) && r.uses >= 0 ? { uses: Math.floor(r.uses) } : {}),
    ...(typeof r.lastUsedAt === 'string' ? { lastUsedAt: r.lastUsedAt } : {}),
    ...(typeof r.retiredAt === 'string' ? { retiredAt: r.retiredAt } : {}),
    ...(typeof r.mergedInto === 'string' && NAME_RE.test(r.mergedInto) && r.mergedInto !== name ? { mergedInto: r.mergedInto } : {}),
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : now,
  };
}

/**
 * The specialist to turn off when the registry is full: an auto-drafted, enabled one that
 * has not run for `idleDays` (by its last use, else its creation), the least used and oldest first.
 */
export function retireCandidate(agents: readonly AgentRecord[], now: number, idleDays: number): AgentRecord | undefined {
  const last = (a: AgentRecord): number => Date.parse(a.lastUsedAt ?? a.createdAt) || 0;
  return agents
    .filter((a) => a.enabled && a.origin === 'auto' && now - last(a) >= idleDays * 86_400_000)
    .sort((a, b) => (a.uses ?? 0) - (b.uses ?? 0) || last(a) - last(b))[0];
}

export function sanitizeSkill(raw: unknown, now: string): SkillRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' && NAME_RE.test(r.name) ? r.name : undefined;
  const description = text(r.description, LIMITS.description);
  const body = text(r.body, LIMITS.skillBody);
  if (!name || !description || !body) return undefined;
  return {
    name,
    description,
    body,
    origin: r.origin === 'manual' ? 'manual' : 'auto',
    ...(typeof r.mergedInto === 'string' && NAME_RE.test(r.mergedInto) && r.mergedInto !== name ? { mergedInto: r.mergedInto } : {}),
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : now,
  };
}

/** The agent's system prompt with its skills appended as short sections. */
export function composePrompt(agent: AgentRecord, skills: ReadonlyMap<string, SkillRecord>): string {
  const names = [...new Set(agent.skills.map((name) => resolveSkill(skills, name) ?? name))];
  const sections = names
    .map((name) => skills.get(name))
    .filter((skill): skill is SkillRecord => skill !== undefined)
    .map((skill) => `## Skill: ${skill.name}\n${skill.body}`);
  return [agent.prompt, ...sections].join('\n\n');
}

const STOP = new Set(
  'the a an and or of to in on for with by is are be this that it as at from into your you our we use using when then than not no all any each'.split(
    ' ',
  ),
);

/** Endings dropped so `researcher` meets `research`, `auditor` meets `audit`, `tests` meets `test`. */
const SUFFIXES = ['ions', 'ion', 'ers', 'ors', 'ing', 'er', 'or', 'ed', 'es', 's', 'e'];

function stem(word: string): string {
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length);
  }
  return word;
}

function words(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map(stem),
  );
}

/**
 * The enabled agents most related to a task, best first, at most `limit`: Jev
 * then picks among them (or none). A shared word counts by its rarity among the
 * specialists (`review` or `files` says little) and twice when the title has it.
 */
export function rankCandidates(
  agents: readonly AgentRecord[],
  task: string,
  limit: number,
  title = '',
): AgentRecord[] {
  const enabled = agents.filter((agent) => agent.enabled);
  const own = enabled.map((agent) => words(`${agent.name.replace(/-/g, ' ')} ${agent.description}`));
  const spread = new Map<string, number>();
  for (const set of own) for (const w of set) spread.set(w, (spread.get(w) ?? 0) + 1);
  const taskWords = words(task);
  const titleWords = words(title);
  return enabled
    .map((agent, i) => {
      const set = own[i]!;
      let score = 0;
      for (const w of set) {
        const weight = titleWords.has(w) ? 2 : taskWords.has(w) ? 1 : 0;
        if (weight > 0) score += weight * Math.log(1 + enabled.length / spread.get(w)!);
      }
      return { agent, score: score / Math.sqrt(set.size || 1) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.agent);
}

export const NONE = 'none';

/**
 * The specialist Jev picked: the likeliest one once it reaches `matchAt`, or once the
 * specialists together do (near-copies split the vote between them) and `none` is not the pick.
 */
export function pickedAgent(
  pick: { choice: string; probabilities: Record<string, number> } | undefined,
  matchAt: number,
): string | undefined {
  if (!pick || pick.choice === NONE) return undefined;
  let best: string | undefined;
  let top = 0;
  let sum = 0;
  for (const [name, p] of Object.entries(pick.probabilities)) {
    if (name === NONE || !Number.isFinite(p)) continue;
    sum += p;
    if (p > top) [best, top] = [name, p];
  }
  return best !== undefined && (top >= matchAt || sum >= matchAt) ? best : undefined;
}

/** What a specialist's name stands for now: itself, or the one it was merged into. Undefined when off. */
export function resolveAgent(agents: ReadonlyMap<string, AgentRecord>, name: string): AgentRecord | undefined {
  let agent = agents.get(name);
  for (let hops = 0; agent?.mergedInto !== undefined && hops < 8; hops++) agent = agents.get(agent.mergedInto);
  return agent?.enabled ? agent : undefined;
}

/** A skill's name as agents should list it: itself, or the one it was merged into. */
export function resolveSkill(skills: ReadonlyMap<string, SkillRecord>, name: string): string | undefined {
  let skill = skills.get(name);
  for (let hops = 0; skill?.mergedInto !== undefined && hops < 8; hops++) skill = skills.get(skill.mergedInto);
  return skill?.name;
}

/** One Choice over the candidates plus `none`, candidates in random order. */
export function agentQuestion(
  candidates: readonly AgentRecord[],
  random: () => number = Math.random,
): ChoiceQuestion {
  const shuffled = [...candidates]
    .map((agent) => ({ agent, key: random() }))
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.agent);
  const criteria: Record<string, string> = {};
  for (const agent of shuffled) criteria[agent.name] = agent.description;
  criteria[NONE] = 'None of the other options is a good fit for this task';
  return {
    type: 'choice',
    instructions:
      'Which specialist subagent should do `task`? Pick one only if its description clearly covers this kind of work.',
    criteria,
  };
}

export const DRAFT_SYSTEM = `You design reusable Claude Code subagents. Reply with ONE JSON object and nothing else:
{"name": string, "description": string, "prompt": string, "tools": string[] | null, "reuse_skills": string[], "new_skills": [{"name": string, "description": string, "body": string}]}
or, when an existing agent already fits, {"reuse": string}.
Rules:
- First check existing_agents: if one already covers this CLASS of task (even under another name, or described for a narrower case of it), reply {"reuse": "<its name>"} and design nothing. Near-copies of an existing agent are a bug.
- The agent must be reusable for the whole CLASS of similar tasks, never tied to the specific task given.
- name: kebab-case, 2-4 words, max 40 chars, e.g. "rust-test-fixer".
- description: one line, max 160 chars, says WHEN to use the agent.
- prompt: English, max 600 chars, second person, imperative. Cover role, approach and what to report back. No filler, no restating generic coding advice.
- tools: subset of [Read, Grep, Glob, Bash, Edit, Write, WebFetch, WebSearch]; use null for all tools. Read-only roles must not get Edit or Write.
- reuse_skills: names from existing_skills that clearly apply. Never write a new skill that repeats an existing one: reuse it.
- new_skills: at most 2, only for concrete reusable know-how (exact commands, project conventions, pitfalls) visible in the task or project; body max 600 chars. Prefer reuse over new.`;

export function draftPrompt(input: {
  task: string;
  title: string;
  project: string;
  agents: readonly AgentRecord[];
  skills: readonly SkillRecord[];
}): string {
  return JSON.stringify({
    project: input.project,
    task_title: input.title,
    task: input.task.slice(0, 2500),
    existing_agents: input.agents.filter((a) => a.enabled).map((a) => ({ name: a.name, description: a.description })),
    existing_skills: input.skills.filter((s) => s.mergedInto === undefined).map((s) => ({ name: s.name, description: s.description })),
  });
}

/** The first JSON object in a reply (tolerates fences and prose around it). */
export function extractJson(reply: string): unknown {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(reply.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** A drafting reply: a new agent with its new skills, or the existing agent it says already fits. */
export type ParsedDraft = { agent: AgentRecord; skills: SkillRecord[] } | { reuse: string };

/**
 * Turns a drafting reply into records ready to save; undefined when unusable. A reply naming an
 * existing agent, by `reuse` or by drafting under its very name, is that agent (no `-2` copy);
 * a new skill under an existing skill's name is that skill.
 */
export function parseDraft(
  reply: string,
  existing: { agents: ReadonlySet<string>; skills: ReadonlyMap<string, SkillRecord> },
  now: string,
): ParsedDraft | undefined {
  const raw = extractJson(reply);
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.reuse === 'string' && existing.agents.has(r.reuse)) return { reuse: r.reuse };
  const wanted = typeof r.name === 'string' ? slug(r.name) : '';
  if (wanted && existing.agents.has(wanted)) return { reuse: wanted };
  const takenSkills = new Set(existing.skills.keys());
  const reuse = new Set(
    (Array.isArray(r.reuse_skills) ? r.reuse_skills : [])
      .map((s) => (typeof s === 'string' ? resolveSkill(existing.skills, s) : undefined))
      .filter((s): s is string => s !== undefined),
  );
  const newSkills: SkillRecord[] = [];
  for (const draft of Array.isArray(r.new_skills) ? r.new_skills.slice(0, 2) : []) {
    if (typeof draft !== 'object' || draft === null) continue;
    const d = draft as Record<string, unknown>;
    const same = typeof d.name === 'string' ? resolveSkill(existing.skills, slug(d.name)) : undefined;
    if (same) {
      reuse.add(same);
      continue;
    }
    const name = uniqueName(typeof d.name === 'string' ? slug(d.name) : '', takenSkills);
    const skill = sanitizeSkill({ ...d, name, origin: 'auto', createdAt: now, updatedAt: now }, now);
    if (skill) {
      takenSkills.add(skill.name);
      newSkills.push(skill);
    }
  }
  const tools =
    Array.isArray(r.tools) && r.tools.length > 0
      ? r.tools.filter((t): t is string => (KNOWN_TOOLS as readonly string[]).includes(t as string))
      : undefined;
  const agent = sanitizeAgent(
    {
      name: uniqueName(wanted, existing.agents),
      description: r.description,
      prompt: r.prompt,
      tools,
      skills: [...reuse, ...newSkills.map((s) => s.name)].slice(0, LIMITS.skillsPerAgent),
      tier: 'auto',
      effort: 'auto',
      enabled: true,
      origin: 'auto',
      createdAt: now,
      updatedAt: now,
    },
    now,
  );
  return agent ? { agent, skills: newSkills.filter((s) => agent.skills.includes(s.name)) } : undefined;
}

// ------------------------------------------------------------------ merge --

export const MERGE_SYSTEM = `You keep a registry of reusable Claude Code subagents ("specialists") and their skills free of near-copies. Reply with ONE JSON object and nothing else:
{"agents": [{"keep": string, "merge": string[], "description": string | null, "prompt": string | null}], "skills": [{"keep": string, "merge": string[]}]}
Rules:
- A group is specialists that cover the same CLASS of task: any one of them would serve the others' tasks just as well (e.g. several packet judges or graders, several lesson writers, an extractor and its "-2" copy).
- Different kinds of work stay apart even in one project: a reviewer and a fixer, a researcher and a translator, an auditor and a builder.
- keep: the clearest, most general and most used member; merge: all the others of its group.
- description / prompt: for the kept specialist, rewritten to cover the whole group's class of task when its own is narrower (description max 160 chars and says WHEN to use it; prompt max 600 chars, English, second person, imperative); null keeps its own.
- Specialists with origin "manual" are never in merge (they may be kept). The same for skills.
- Skills: group skills that give the same know-how; keep the more complete one.
- Leave out everything without a near-copy. Empty lists are a fine answer.`;

export function mergePrompt(agents: readonly AgentRecord[], skills: readonly SkillRecord[]): string {
  return JSON.stringify({
    agents: agents
      .filter((a) => a.enabled)
      .map((a) => ({ name: a.name, description: a.description, skills: a.skills, uses: a.uses ?? 0, origin: a.origin })),
    skills: skills
      .filter((s) => s.mergedInto === undefined)
      .map((s) => ({ name: s.name, description: s.description, body: s.body.slice(0, 300), origin: s.origin })),
  });
}

export type MergePlan = {
  agents: { keep: string; merge: string[]; description?: string; prompt?: string }[];
  skills: { keep: string; merge: string[] }[];
};

/** A merge reply checked against the registry: real, enabled names, each in one group at most, nothing manual merged away. */
export function parseMerge(
  reply: string,
  agents: ReadonlyMap<string, AgentRecord>,
  skills: ReadonlyMap<string, SkillRecord>,
): MergePlan | undefined {
  const raw = extractJson(reply);
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const groups = <T extends { origin: 'auto' | 'manual' }>(
    list: unknown,
    known: (name: string) => T | undefined,
  ): { keep: string; merge: string[]; raw: Record<string, unknown> }[] => {
    const seen = new Set<string>();
    const out: { keep: string; merge: string[]; raw: Record<string, unknown> }[] = [];
    for (const item of Array.isArray(list) ? list : []) {
      if (typeof item !== 'object' || item === null) continue;
      const g = item as Record<string, unknown>;
      const keep = typeof g.keep === 'string' && known(g.keep) && !seen.has(g.keep) ? g.keep : undefined;
      if (!keep) continue;
      const merge = [
        ...new Set(
          (Array.isArray(g.merge) ? g.merge : []).filter(
            (n): n is string => typeof n === 'string' && n !== keep && !seen.has(n) && known(n)?.origin === 'auto',
          ),
        ),
      ];
      if (merge.length === 0) continue;
      for (const n of [keep, ...merge]) seen.add(n);
      out.push({ keep, merge, raw: g });
    }
    return out;
  };
  const liveAgent = (name: string) => {
    const a = agents.get(name);
    return a?.enabled ? a : undefined;
  };
  const liveSkill = (name: string) => {
    const s = skills.get(name);
    return s && s.mergedInto === undefined ? s : undefined;
  };
  return {
    agents: groups(r.agents, liveAgent).map(({ keep, merge, raw: g }) => {
      const description = text(g.description, LIMITS.description);
      const prompt = text(g.prompt, LIMITS.prompt);
      return { keep, merge, ...(description ? { description } : {}), ...(prompt ? { prompt } : {}) };
    }),
    skills: groups(r.skills, liveSkill).map(({ keep, merge }) => ({ keep, merge })),
  };
}

/**
 * The records a merge changes. The kept specialist takes the group's skills (its own first),
 * tools (all when any member had all), runs and last run; the others are turned off with
 * `mergedInto`, and so are merged skills, whose names every agent's list follows.
 */
export function applyMerge(
  plan: MergePlan,
  agents: ReadonlyMap<string, AgentRecord>,
  skills: ReadonlyMap<string, SkillRecord>,
  now: string,
): { agents: AgentRecord[]; skills: SkillRecord[] } {
  const skillTo = new Map<string, string>();
  for (const g of plan.skills) for (const name of g.merge) skillTo.set(name, g.keep);
  const changedSkills = plan.skills.flatMap((g) =>
    g.merge.map((name) => ({ ...skills.get(name)!, mergedInto: g.keep, updatedAt: now })),
  );
  const changed = new Map<string, AgentRecord>();
  const current = (name: string): AgentRecord => changed.get(name) ?? agents.get(name)!;
  for (const agent of agents.values()) {
    const mapped = [...new Set(agent.skills.map((s) => skillTo.get(s) ?? s))];
    if (mapped.length !== agent.skills.length || mapped.some((s, i) => s !== agent.skills[i])) {
      changed.set(agent.name, { ...agent, skills: mapped, updatedAt: now });
    }
  }
  for (const g of plan.agents) {
    const keep = current(g.keep);
    const group = [keep, ...g.merge.map(current)];
    const lastUsedAt = group
      .map((a) => a.lastUsedAt)
      .filter((t): t is string => t !== undefined)
      .sort()
      .at(-1);
    const { tools: _tools, ...rest } = keep;
    const tools = group.every((a) => a.tools) ? [...new Set(group.flatMap((a) => a.tools!))] : undefined;
    changed.set(keep.name, {
      ...rest,
      ...(g.description ? { description: g.description } : {}),
      ...(g.prompt ? { prompt: g.prompt } : {}),
      ...(tools ? { tools } : {}),
      skills: [...new Set(group.flatMap((a) => a.skills))].slice(0, LIMITS.skillsPerAgent),
      uses: group.reduce((n, a) => n + (a.uses ?? 0), 0),
      ...(lastUsedAt ? { lastUsedAt } : {}),
      updatedAt: now,
    });
    for (const name of g.merge) changed.set(name, { ...current(name), enabled: false, mergedInto: keep.name, updatedAt: now });
  }
  return { agents: [...changed.values()], skills: changedSkills };
}

/**
 * Appended to every subagent's task. A subagent's prompt cache lives 5
 * minutes: a single wait longer than that (a blocking build, an until/sleep
 * loop, a long TaskOutput wait) makes its next step write the whole context
 * again, ~$1–1.5 at 200–300k tokens, where a check every few minutes costs
 * a few cents. At the end, so the task's start still identifies the spawn.
 */
export const WAIT_NOTE =
  '<cache-note>Your prompt cache expires after 5 minutes without a request, and re-creating it costs far more than a short check. Keep every single wait under 4 minutes: run long builds, installs and test suites in the background and check on them at most every 3–4 minutes; cap sleep and until-loops at 240 seconds per call.</cache-note>';

export function withWaitNote(prompt: string): string {
  return prompt.includes('<cache-note>') ? prompt : `${prompt}\n\n${WAIT_NOTE}`;
}

/**
 * The specialist as a generic subagent receives it: role (prompt + skills,
 * plus its tool list as an instruction, since a generic subagent has every
 * tool) in front of the task.
 */
export function withRolePreamble(
  agent: AgentRecord,
  skills: ReadonlyMap<string, SkillRecord>,
  task: string,
): string {
  const tools = agent.tools && agent.tools.length > 0 ? `\n\nUse only these tools: ${agent.tools.join(', ')}.` : '';
  return `<role>\n${composePrompt(agent, skills)}${tools}\n</role>\n\n<task>\n${task}\n</task>`;
}
