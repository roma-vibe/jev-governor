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
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : now,
  };
}

/** The agent's system prompt with its skills appended as short sections. */
export function composePrompt(agent: AgentRecord, skills: ReadonlyMap<string, SkillRecord>): string {
  const sections = agent.skills
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

function words(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/**
 * The enabled agents most related to a task by word overlap, best first, at
 * most `limit`: Jev then picks among them (or none).
 */
export function rankCandidates(
  agents: readonly AgentRecord[],
  task: string,
  limit: number,
): AgentRecord[] {
  const taskWords = words(task);
  return agents
    .filter((agent) => agent.enabled)
    .map((agent) => {
      const own = words(`${agent.name.replace(/-/g, ' ')} ${agent.description}`);
      let overlap = 0;
      for (const w of own) if (taskWords.has(w)) overlap++;
      return { agent, overlap: overlap / Math.sqrt(own.size || 1) };
    })
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, limit)
    .map((entry) => entry.agent);
}

export const NONE = 'none';

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
Rules:
- The agent must be reusable for the whole CLASS of similar tasks, never tied to the specific task given.
- name: kebab-case, 2-4 words, max 40 chars, e.g. "rust-test-fixer".
- description: one line, max 160 chars, says WHEN to use the agent.
- prompt: English, max 600 chars, second person, imperative. Cover role, approach and what to report back. No filler, no restating generic coding advice.
- tools: subset of [Read, Grep, Glob, Bash, Edit, Write, WebFetch, WebSearch]; use null for all tools. Read-only roles must not get Edit or Write.
- reuse_skills: names from existing_skills that clearly apply.
- new_skills: at most 2, only for concrete reusable know-how (exact commands, project conventions, pitfalls) visible in the task or project; body max 600 chars. Prefer reuse over new.
- If an existing agent already covers this class of task, still return a design, but make the name and description distinct from it.`;

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
    existing_agents: input.agents.map((a) => ({ name: a.name, description: a.description })),
    existing_skills: input.skills.map((s) => ({ name: s.name, description: s.description })),
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

/** Turns a drafting reply into records ready to save; undefined when unusable. */
export function parseDraft(
  reply: string,
  existing: { agents: ReadonlySet<string>; skills: ReadonlyMap<string, SkillRecord> },
  now: string,
): { agent: AgentRecord; skills: SkillRecord[] } | undefined {
  const raw = extractJson(reply);
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const takenSkills = new Set(existing.skills.keys());
  const newSkills: SkillRecord[] = [];
  for (const draft of Array.isArray(r.new_skills) ? r.new_skills.slice(0, 2) : []) {
    if (typeof draft !== 'object' || draft === null) continue;
    const d = draft as Record<string, unknown>;
    const name = uniqueName(typeof d.name === 'string' ? slug(d.name) : '', takenSkills);
    const skill = sanitizeSkill({ ...d, name, origin: 'auto', createdAt: now, updatedAt: now }, now);
    if (skill) {
      takenSkills.add(skill.name);
      newSkills.push(skill);
    }
  }
  const reuse = Array.isArray(r.reuse_skills)
    ? r.reuse_skills.filter((s): s is string => typeof s === 'string' && existing.skills.has(s))
    : [];
  const tools =
    Array.isArray(r.tools) && r.tools.length > 0
      ? r.tools.filter((t): t is string => (KNOWN_TOOLS as readonly string[]).includes(t as string))
      : undefined;
  const agent = sanitizeAgent(
    {
      name: uniqueName(typeof r.name === 'string' ? slug(r.name) : '', existing.agents),
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
  return agent ? { agent, skills: newSkills } : undefined;
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
