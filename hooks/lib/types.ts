// Shared data contract of jev-governor: the mod (hooks/) and the settings UI
// (ui/) both read and write these shapes under the data directory
// (~/.claude/jev-governor by default). Keep docs/DATA.md in sync.

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** The two model tiers the router chooses between. */
export type Tier = 'standard' | 'strong';

export type GovernorConfig = {
  version: 1;
  /** Master switch: off, the mod changes nothing. */
  enabled: boolean;
  /** `shadow`: decide and log what would be done, change nothing (for evaluation). */
  mode: 'active' | 'shadow';
  /** Sessions whose working directory starts with one of these run in shadow mode. */
  shadowPaths: string[];
  /** Sessions under these paths are active even in shadow mode (and win over shadowPaths). */
  activePaths: string[];
  /** Projects whose work never goes to Jev (someone else's or work code): no routing, compaction or trimming by Jev there. */
  excludeProjects: string[];
  jev: {
    /** Jev model id as the System One API takes it. */
    model: string;
    /** TypeSafe-compatible System One endpoint (OpenRouter by default). */
    endpoint: string;
    /** File holding the OpenRouter key; `~` is the home directory. Env OPENROUTER_API_KEY wins. */
    keyFile: string;
    /** A decision that takes longer is abandoned and nothing changes. */
    timeoutMs: number;
    /**
     * The same for a subagent spawn: rare, and followed by minutes of work, so it can wait longer.
     * A spawn also retries once when Jev failed just before (an outage hits the spawns too).
     */
    subagentTimeoutMs: number;
  };
  models: Record<Tier, string> & {
    /** The light model read-only subagents may run on (`router.lightSubagents`). */
    light: string;
  };
  router: {
    /** Choose the main conversation's model (only where the prompt cache allows). */
    mainModel: boolean;
    /** Choose the main conversation's effort every turn (cache-safe on Opus/Sonnet 5.5). */
    mainEffort: boolean;
    /** Choose model and effort for every subagent at spawn. */
    subagents: boolean;
    /** P(strong) to move standard → strong where a switch is free or cheap. */
    upgradeAt: number;
    /** P(strong) to move standard → strong even with a warm cache. */
    forceUpgradeAt: number;
    /** P(standard) to move strong → standard where a switch is free or cheap. */
    downgradeAt: number;
    /** P(strong) for a subagent to run on the strong tier. */
    subagentStrongAt: number;
    /**
     * Read-only subagents with an easy task on the light model (Haiku 5.5): $0.10/$0.50 per MTok and
     * cache reads at $0.01 under a 100K-token prompt (5× that above), against Sonnet 5.5's $2/$10 and
     * $0.20. `shadow` only records what it would have chosen.
     */
    lightSubagents: 'off' | 'shadow' | 'on';
    /** A subagent goes light only when P(strong) is below this. */
    lightBelow: number;
    /** A light subagent moves to the standard tier after this many steps (a task that grew past searching) or after failed tool calls. */
    lightMaxSteps: number;
    /** Context below this many tokens makes a model switch cheap (for upgrades; downgrades weigh dollars). */
    cheapSwitchTokens: number;
    /** Turns a downgrade is expected to last: its per-turn gain times this must beat the cache re-write it costs. */
    expectedTurns: number;
    /** Never move to the standard tier when the context is larger than this. */
    standardMaxContextTokens: number;
    /** Idle minutes after which the prompt cache is assumed cold. */
    cacheTtlMinutes: number;
    minEffort: Effort;
    maxEffort: Effort;
    /** Effort used when Jev is not confident. */
    defaultEffort: Effort;
    /** Effort when Jev cannot be reached and there is no earlier decision (a chat's or a subagent's first turn). */
    fallbackEffort: Effort;
    /**
     * Jev unreachable at a subagent spawn: a task that reads like research (description starts with
     * research / explore / find / audit / review ...) runs on the standard model at medium effort
     * instead of keeping the parent's tier. On 8 October a Jev outage left twenty such "Research X API"
     * subagents on Opus.
     */
    fallbackReadOnlyStandard: boolean;
    /** Jev confidence below which its effort score is ignored. */
    effortConfidenceAt: number;
    /** Failed tool calls in one turn before effort goes up one level (0 = never). */
    escalateAfterErrors: number;
    /**
     * Errors are counted among this many latest tool results (0 = the whole turn). A long turn
     * collects scattered failures (a grep with no match, a stale browser ref) that are not the
     * model being stuck: over the whole turn they raised 71 turns (13 to max), within 6 results 29 (none to max).
     */
    errorWindow: number;
    /** `risky` probability that forces at least `high` effort and the strong tier. */
    riskyAt: number;
    /** `continuation` probability that reuses the previous turn's decision. */
    continuationAt: number;
    /** Spend less when the 5-hour / weekly windows run ahead of pace. */
    budgetAware: boolean;
  };
  agents: {
    /** Map generic subagent spawns onto registry specialists. */
    enabled: boolean;
    /** Create a specialist when none fits (drafted by `draftModel`). */
    autoCreate: boolean;
    /** Subagent types eligible for remapping onto specialists. */
    remapFrom: string[];
    /** Jev probability for an existing specialist to be chosen. */
    matchAt: number;
    /** List specialists to the model (costs context); hidden by default. */
    exposeToModel: boolean;
    draftModel: string;
    draftTimeoutMs: number;
    /** Fold near-copy specialists in the background at most this often (hours); 0 is off. Runs only when a specialist was drafted since the last pass. */
    autoMergeHours: number;
    /** Ask every subagent to keep each wait under 4 minutes: its prompt cache lives 5 (WAIT_NOTE). */
    waitHint: boolean;
  };
  compaction: {
    /** Replace the compaction summary with Jev pruning of stale tool calls. */
    enabled: boolean;
    /** Compact when the context reaches this many tokens (0 = off). */
    compactAtTokens: number;
    /** Or at this context percentage (0 = off). */
    compactAtPercent: number;
    /** Not again until the context grew this much since the last compaction (or skipped attempt). */
    recompactAfterTokens: number;
    /** Our size-triggered compaction runs only if Jev removes at least this share; otherwise it is skipped. */
    thresholdMinReduction: number;
    /** When Claude Code compacts (window limit, /compact): below this share, fall back to its own summary. */
    minReductionRatio: number;
    keepThreshold: number;
    preserveRecentMessages: number;
    truncateHeadChars: number;
    maxStateTokens: number;
    maxRequestTokens: number;
    /** Back after the prompt cache expired: compact first, so the unavoidable re-write is smaller. */
    onReturn: boolean;
    /** Only when the context is at least this large. */
    onReturnMinTokens: number;
    /** On return any reduction is pure gain; below this share nothing is done. */
    onReturnMinReduction: number;
    /** Pruned calls are saved to files and the history points at them instead of losing them. */
    archive: boolean;
    /** Most of the history one compaction may remove; above it the calls Jev was least sure about are put back (1 = no cap). */
    maxPruneRatio: number;
    /** Characters of each tool output's start and end Jev sees when deciding (0 = only its size). */
    resultPreviewChars: number;
    /**
     * Claude Code's auto-compaction window, set through CLAUDE_CODE_AUTO_COMPACT_WINDOW for this
     * process (0 = Claude Code's own). The only way to compact in the middle of a turn and inside
     * subagents: the mod cannot start a compaction while a turn runs. Set by you in the
     * environment, your value wins.
     */
    autoWindowTokens: number;
    /**
     * Fold old dialog text at every compaction: earlier answers, agent results, monitor events and
     * long pastes keep their first lines and point at their archived full text (outputs/<session>/
     * folded/). Jev keeps what the work still depends on.
     */
    fold: boolean;
    /** The newest prompts whose turns are never folded. */
    foldKeepTurns: number;
  };
  /** Moving the work to a new chat with a compact capsule instead of the whole history. */
  handoff: {
    enabled: boolean;
    /** Capsule budget in estimated tokens. */
    maxTokens: number;
    /** A brief written by the original chat's model: `auto` only while its prompt cache is warm. */
    brief: 'auto' | 'always' | 'never';
    briefWords: number;
    /** Ask Jev which older turns the capsule keeps; otherwise newest first. */
    useJev: boolean;
    /** Suggest a new chat when Jev sees a new topic on a context at least this large (0 = never). */
    suggestAtTokens: number;
    /** `new_topic` probability for that suggestion. */
    suggestAt: number;
    /** Also suggest it when the cache of a context at least this large went cold (0 = never). */
    suggestColdAtTokens: number;
    /** Days to keep capsules. */
    keepDays: number;
  };
  /** Large tool outputs trimmed before they enter the history (full output saved to a file). */
  trim: {
    enabled: boolean;
    /** Test / build / install output shorter than this stays whole. */
    minChars: number;
    /** Any other output longer than this is trimmed too. */
    hugeChars: number;
    /** A listing (ls, du, ps, find… with filters) longer than this is shortened to its first and last rows; 0 = never. */
    listChars: number;
    /** A successful test / build / install run between this and minChars is cut to its outcome, summary and warnings (no Jev); 0 = never. */
    briefChars: number;
    /**
     * Other command outputs (a script, a server, a deploy, git push, a polling loop) from logChars up:
     * Jev judges whether it is a log or data the assistant asked for, and a log is trimmed.
     * `shadow`: Jev is asked and its verdict logged, nothing is cut.
     */
    logs: 'off' | 'shadow' | 'on';
    logChars: number;
    /** Jev probability of "a log" from which it is trimmed (high = trims less). */
    logAt: number;
    headLines: number;
    tailLines: number;
    /** Lines kept around each error / warning / failure line. */
    contextLines: number;
    /** Soft budget for the kept text; error and summary lines are never dropped for it. */
    maxChars: number;
    /** Ask Jev which omitted middle parts are still needed for the task. */
    useJev: boolean;
    /** Jev probability at which an omitted part is put back (low = keep more). */
    jevKeepAt: number;
    /** Days to keep the saved full outputs. */
    keepDays: number;
    /** Cap on all saved outputs together, in MB; the oldest sessions go first. */
    maxStorageMb: number;
  };
  /** Project pages of the settings UI: discovered and learned commands. */
  projects: {
    /** The whole project panel (UI tab, learned commands, descriptions); off, the mod and the UI leave projects alone. */
    enabled: boolean;
    /** Language of the generated command descriptions. */
    descriptionLanguage: 'ru' | 'en';
    /** Remember commands Claude runs successfully, per project. */
    learnFromClaude: boolean;
    /** Successful runs before a learned command is listed. */
    minSuccesses: number;
    /** Write missing descriptions with Claude (Sonnet, low effort) through an open session. */
    describeWithClaude: boolean;
    /** List git worktrees (…/.claude/worktrees/…) as projects too. */
    showWorktrees: boolean;
  };
  /**
   * Long-term memory through an MCP memory server (Mnema): what earlier sessions decided and learned,
   * recalled into a new conversation and into subagents so they do not rediscover it by reading.
   */
  memory: {
    /** The whole option; off, the mod neither recalls nor saves, and refuses the server's tools (`modelTools`). */
    enabled: boolean;
    /** The MCP server's name as /mcp lists it (`claude mcp add <name> ...`). */
    server: string;
    /** Start the local memory server (`startCommand`) when it does not answer; tried at most once in 10 minutes. */
    autoStart: boolean;
    /** Command that starts the local server; empty: the mod's scripts/mnema-local.sh start. */
    startCommand: string;
    /** The first prompt of a conversation gets the notes relevant to it, as context. */
    recallOnStart: boolean;
    /** A subagent's task gets the notes relevant to it, prepended to its prompt. */
    recallForSubagents: boolean;
    /** A subagent prompt shorter than this gets no recall (a one-line errand needs none). */
    subagentMinChars: number;
    /** The brief of `/jevg getctx` / `/jevg fresh` is saved as a session summary. */
    saveOnHandoff: boolean;
    /** The model may call the memory's tools itself (save_fact, recall, ...); off, those calls are refused. */
    modelTools: boolean;
    /**
     * The model may call `recall` itself. Off (default), that one call is refused while its other
     * tools (save_fact, search, ...) stay: the mod already recalls at the start of a chat and for
     * subagents, and the server's own instruction makes every subagent recall again, a step over
     * the whole context that mostly returns nothing.
     */
    modelRecall: boolean;
    /** Most characters of notes added to one prompt. */
    maxChars: number;
    /** Most facts added to one prompt. */
    maxFacts: number;
    /** A recall that takes longer is dropped and the prompt goes without it. */
    timeoutMs: number;
  };
  ui: {
    port: number;
    /** Language of the settings page (the page itself is translated in ui/src/i18n). */
    language: 'auto' | 'en' | 'ru';
    /** Terminal used by "run in terminal" (only Terminal.app for now). */
    terminal: 'Terminal';
    /** Show the current routing in the status line. */
    showStatus: boolean;
    /** Node binary used by `/jevg ui` (PATH lookup when bare). */
    nodePath: string;
  };
  /** How the savings page counts. */
  savings: {
    /** Share of a turn one effort level is worth (estimate; the A/B runs showed ~0.3). */
    effortFactor: number;
    /** What sessions run on without the mod, for ledger entries older than the base fields. */
    defaultBaseModel: string;
    defaultBaseEffort: Effort;
  };
  /** Reserved for the Codex provider (not in v1). */
  codex: { enabled: boolean };
};

export type AgentRecord = {
  /** kebab-case, unique; registered as `jev-governor:<name>`. */
  name: string;
  /** When to use it: one line. */
  description: string;
  /** Concise English system prompt (role, approach, output). */
  prompt: string;
  /** Allowed tools; absent = everything the parent has. */
  tools?: string[];
  /** Skill names composed into the prompt. */
  skills: string[];
  /** Pin a tier, or let the router decide. */
  tier: Tier | 'auto';
  /** Pin an effort, or let the router decide. */
  effort: Effort | 'auto';
  enabled: boolean;
  origin: 'auto' | 'manual';
  /** Spawns it ran (since 0.3.2), and the last one. */
  uses?: number;
  lastUsedAt?: string;
  /** Turned off by an older mod's size cap (`enabled` false); a draft that reuses it turns it back on. */
  retiredAt?: string;
  /** Folded into this specialist as a near-copy of it (`enabled` false): a spawn that picks or redrafts it gets that one. */
  mergedInto?: string;
  createdAt: string;
  updatedAt: string;
};

export type SkillRecord = {
  name: string;
  description: string;
  /** Concrete reusable know-how (commands, conventions, pitfalls). */
  body: string;
  origin: 'auto' | 'manual';
  /** Folded into this skill as a near-copy of it: agents list that one instead. */
  mergedInto?: string;
  createdAt: string;
  updatedAt: string;
};

/** A request from the UI for the mod to fold near-copy specialists together (merge.json). */
export type MergeRequest = {
  status: 'pending' | 'working' | 'done' | 'error';
  /** What was folded: each kept specialist with the ones merged into it, and skills likewise. */
  result?: { agents: { keep: string; merged: string[] }[]; skills: { keep: string; merged: string[] }[] };
  error?: string;
  createdAt: string;
  updatedAt: string;
};

/** A request from the UI for the mod to draft an agent with Claude. */
export type DraftRecord = {
  id: string;
  status: 'pending' | 'working' | 'done' | 'error';
  request: { description: string };
  result?: { agent: AgentRecord; skills: SkillRecord[] };
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type LedgerKind =
  | 'turn'
  | 'subagent'
  | 'usage'
  | 'compact'
  | 'agent-created'
  | 'trim'
  | 'output-read'
  | 'command'
  | 'handoff'
  | 'hint'
  | 'redacted'
  | 'rerun-after-prune'
  | 'override'
  | 'light-up'
  | 'chat'
  | 'window'
  | 'memory'
  | 'error';

/** One line of ledger/<YYYY-MM-DD>/<session>.jsonl. */
export type LedgerEntry = {
  ts: string;
  session: string;
  kind: LedgerKind;
  /** The mod version that wrote it (since 0.3.2). */
  v?: string;
  scope?: 'main' | 'subagent';
  agentId?: string;
  project?: string;
  /** First characters of the prompt or task. */
  text?: string;
  model?: string;
  prevModel?: string;
  effort?: Effort;
  switched?: boolean;
  /** `turn`: tokens the mod's own model switch on a warm cache rewrote (the context then). */
  rewrite?: number;
  /** `usage`: a turn the mod did not route (excluded project, no key, a /jevg fresh brief). */
  unrouted?: boolean;
  pStrong?: number;
  effortScore?: number;
  risky?: number;
  continuation?: number;
  pressure?: number;
  reasons?: string[];
  /** `subagent`: the task qualified for the light model; `lightApplied` says whether it ran there. */
  light?: boolean;
  lightApplied?: boolean;
  agent?: string;
  subagentType?: string;
  created?: boolean;
  /** `agent-created`: not a new specialist but one turned off (`retired`) or folded into `mergedInto` (`merged`). */
  change?: 'retired' | 'merged';
  mergedInto?: string;
  usage?: {
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** The part of the above from requests whose prompt was over 100K tokens (Haiku 5.5's long rate card); absent when none was. */
    long?: { input: number; output: number; cacheRead: number; cacheWrite: number; steps: number };
  };
  /** `usage`: summed from the turn's steps (0.3.4 on), or the turn's own figure, which starts over at a compaction inside the turn. */
  usageFrom?: 'steps' | 'turn';
  /** `output-read`: whose saved text was read (archiveOf). */
  archive?: 'pruned' | 'folded' | 'trim' | 'tool-results' | 'other';
  jevCost?: number;
  jevMs?: number;
  /**
   * `window`: Claude Code's auto-compaction window at session start. `tokens` is what the
   * engine measures against (`rawMaxTokens`), `source` how it was settled (`env` when the
   * variable is set), `by` who set the variable.
   */
  autoWindow?: { tokens?: number; source?: string; by: 'mod' | 'user' | 'none'; wanted?: number };
  compaction?: {
    charsBefore: number;
    charsAfter: number;
    ratio: number;
    fallback?: string;
    requests: number;
    /**
     * Why it ran: Claude Code's own trigger, the size threshold, the return after the cache expired,
     * or Claude Code's trigger at the smaller window the mod set (`compaction.autoWindowTokens`).
     */
    reason?: 'engine' | 'threshold' | 'return' | 'window';
    /** Pruned calls saved to files (outputs/<session>/pruned/). */
    archived?: number;
    /** Calls put back because Jev would have removed more than `maxPruneRatio`. */
    restored?: number;
    /** Old dialog messages folded (Jev asked about `candidates`; `chars` folded away; outputs/<session>/folded/). */
    folded?: {
      candidates: number;
      folded: number;
      chars: number;
      requests: number;
      byKind: Record<string, number>;
      /** Every candidate as `kind:keep:chars:turnsAgo` (keep = Jev's probability it must stay, 2 decimals): what keepAt is tuned on. */
      keeps?: string[];
    };
    /** How our own compaction was started: `$.session.compact` or the `/compact` command (the desktop app). */
    via?: 'api' | 'command';
    /** Claude Code's trigger; `precompute` installs nothing (computed ahead for the compaction that comes). */
    trigger?: 'manual' | 'auto' | 'plugin' | 'precompute';
  };
  /**
   * `handoff`: a capsule made (`create`), attached in a new chat (`attach`), this chat cleared
   * for it (`/jevg fresh`), or a `/jevg fresh` stopped before the clear (`cancel`, `tokens` 0).
   */
  /**
   * `memory`: a call to the memory server (`for`: the first prompt, a handoff, the model's own
   * call refused, the server started). On a `subagent` entry: the recall its prompt got.
   */
  memory?: {
    action: 'recall' | 'save' | 'start' | 'refuse';
    for?: 'prompt' | 'subagent' | 'handoff' | 'model';
    ok: boolean;
    /** Facts added to the prompt (recall). */
    facts?: number;
    /** Characters added to the prompt (recall) or sent (save). */
    chars?: number;
    ms?: number;
    error?: string;
  };
  handoff?: {
    action: 'create' | 'attach' | 'clear' | 'cancel';
    id: string;
    tokens: number;
    /** Context of the original chat when the capsule was made. */
    sourceTokens?: number;
    turns?: number;
    brief?: boolean;
    jev?: boolean;
    path?: string;
    /** Made by `/jevg fresh`: the chat is cleared and the capsule attached to the next prompt. */
    fresh?: boolean;
  };
  /** `turn`: Jev's probability that the request starts a new task. */
  newTopic?: number;
  /** `turn`: Jev's probability that the request corrects the previous answer (it was wrong or incomplete). */
  correction?: number;
  /** `turn`: decided locally, without Jev (a short follow-up). */
  local?: boolean;
  /** `usage`: effort levels added after failed tool calls in this turn. */
  escalated?: number;
  trim?: {
    tool: string;
    command?: string;
    charsBefore: number;
    charsAfter: number;
    linesBefore: number;
    linesAfter: number;
    outcome: string;
    jevChunks: number;
    path?: string;
    /** Claude Code had already saved the output to a file and left a preview (Bash over ~30k): trimmed from that file. */
    persisted?: boolean;
    /** The full output's size then (charsBefore is the preview that would have entered). */
    fullChars?: number;
    /** `list`: a long listing shortened to its first and last rows; `brief`: a successful test or build cut to its outcome; `log`: an output Jev judged to be a log. */
    kind?: 'list' | 'brief' | 'log';
    /** `log`: Jev's probability that the output is a log, not data. */
    logProb?: number;
    /** Why the output stayed whole although it qualified (the entry is then not applied). */
    skipped?: string;
  };
  error?: string;
  /** `redacted`: secrets replaced in one request to Jev. */
  count?: number;
  /** False when the decision was only logged (shadow mode). */
  applied?: boolean;
  /** What would have run without the mod: the request's own model and effort before the rewrite. */
  baseModel?: string;
  baseEffort?: Effort;
  /** `usage`: model requests the turn made (each re-reads the whole context). */
  steps?: number;
  /** `command`: the session's working directory (the project), the normalized command, its subdir, how it ended. */
  cwd?: string;
  command?: string;
  dir?: string;
  success?: boolean;
  /** Rate-limit windows at the time, percent used. */
  rate?: { fiveHour?: number; sevenDay?: number };
};

/** One command of a project page (projects/<id>.json, written by the UI server). */
export type ProjectCommandRecord = {
  id: string;
  command: string;
  /** Subdirectory relative to the project root; absent = root. */
  dir?: string;
  group: 'run' | 'build' | 'test' | 'check' | 'db' | 'deploy' | 'other';
  source: 'package.json' | 'Makefile' | 'Cargo.toml' | 'justfile' | 'pyproject' | 'compose' | 'launch.json' | 'docs' | 'claude' | 'manual';
  sourceDetail?: string;
  /** What the source says (comment, script body): shown until a description exists. */
  hint?: string;
  description?: string;
  descriptionLang?: 'ru' | 'en';
  /** `manual` descriptions are never regenerated. */
  descriptionSource?: 'auto' | 'manual';
  pinned?: boolean;
  hidden?: boolean;
  /** Shown in the project's «Избранные команды» section. */
  favorite?: boolean;
  /** The person changed the group of an auto-discovered command; scans keep it. */
  groupEdited?: boolean;
  /** No longer found by a scan (kept while pinned or edited). */
  stale?: boolean;
  /** Runs observed from Claude sessions. */
  uses?: number;
  successes?: number;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectRecord = {
  id: string;
  name: string;
  path: string;
  /** Listed under «Избранные» on the projects tab. */
  favorite?: boolean;
  commands: ProjectCommandRecord[];
  scannedAt?: string;
  updatedAt: string;
};

/** describe/<id>.json: the UI asks, an open Claude Code session with the mod answers. */
export type DescribeRequest = {
  id: string;
  status: 'pending' | 'working' | 'done' | 'error';
  lang: 'ru' | 'en';
  project: { id: string; name: string; path: string };
  items: { id: string; command: string; dir?: string; hint?: string; source: string }[];
  results?: Record<string, string>;
  error?: string;
  worker?: string;
  createdAt: string;
  updatedAt: string;
};
