import { EFFORTS, type Effort, type GovernorConfig } from './types.ts';

export const DEFAULT_CONFIG: GovernorConfig = {
  version: 1,
  enabled: true,
  mode: 'active',
  shadowPaths: [],
  activePaths: [],
  excludeProjects: [],
  jev: {
    model: 'jev-latest',
    endpoint: 'https://openrouter.ai/api/v1/systemone',
    keyFile: '~/.claude/jev-governor/openrouter.key',
    timeoutMs: 2500,
  },
  models: { standard: 'claude-sonnet-5-5', strong: 'claude-opus-5-5', light: 'claude-haiku-4-5-20251001' },
  router: {
    mainModel: true,
    mainEffort: true,
    subagents: true,
    upgradeAt: 0.55,
    forceUpgradeAt: 0.8,
    downgradeAt: 0.65,
    subagentStrongAt: 0.5,
    lightSubagents: 'shadow',
    lightBelow: 0.15,
    lightMaxSteps: 30,
    cheapSwitchTokens: 30_000,
    expectedTurns: 4,
    standardMaxContextTokens: 180_000,
    cacheTtlMinutes: 60,
    minEffort: 'medium',
    maxEffort: 'max',
    defaultEffort: 'medium',
    fallbackEffort: 'high',
    effortConfidenceAt: 0.5,
    escalateAfterErrors: 2,
    riskyAt: 0.7,
    continuationAt: 0.6,
    budgetAware: true,
  },
  agents: {
    enabled: true,
    autoCreate: true,
    remapFrom: ['general-purpose'],
    matchAt: 0.6,
    maxAgents: 40,
    exposeToModel: false,
    draftModel: 'claude-sonnet-5-5',
    draftTimeoutMs: 30_000,
    waitHint: true,
  },
  compaction: {
    enabled: true,
    compactAtTokens: 200_000,
    compactAtPercent: 0,
    recompactAfterTokens: 60_000,
    thresholdMinReduction: 0.4,
    minReductionRatio: 0.25,
    keepThreshold: 0.5,
    preserveRecentMessages: 6,
    truncateHeadChars: 300,
    maxStateTokens: 25_000,
    maxRequestTokens: 30_000,
    onReturn: true,
    onReturnMinTokens: 60_000,
    onReturnMinReduction: 0.15,
    archive: true,
    maxPruneRatio: 0.8,
    resultPreviewChars: 150,
    autoWindowTokens: 250_000,
  },
  handoff: {
    enabled: true,
    maxTokens: 14_000,
    brief: 'auto',
    briefWords: 350,
    useJev: true,
    suggestAtTokens: 150_000,
    suggestAt: 0.8,
    // Off: after a pause the mod compacts first (compaction.onReturn); on 2026-10-06 none of the hints was taken.
    suggestColdAtTokens: 0,
    keepDays: 30,
  },
  trim: {
    enabled: true,
    minChars: 6_000,
    hugeChars: 40_000,
    listChars: 6_000,
    headLines: 30,
    tailLines: 100,
    contextLines: 3,
    maxChars: 16_000,
    useJev: true,
    jevKeepAt: 0.35,
    keepDays: 7,
    maxStorageMb: 200,
  },
  projects: {
    enabled: true,
    descriptionLanguage: 'en',
    learnFromClaude: true,
    minSuccesses: 2,
    describeWithClaude: true,
    showWorktrees: false,
  },
  ui: { port: 4777, language: 'en', showStatus: true, nodePath: 'node', terminal: 'Terminal' },
  savings: { effortFactor: 0.3, defaultBaseModel: 'claude-opus-5-5', defaultBaseEffort: 'xhigh' },
  codex: { enabled: false },
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function effort(value: unknown, fallback: Effort): Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)
    ? (value as Effort)
    : fallback;
}

function strings(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : fallback;
}

/**
 * Merges a stored (possibly partial or hand-edited) config over the defaults,
 * clamping every number to a sane range; unknown keys are dropped.
 */
export function resolveConfig(raw: unknown): GovernorConfig {
  const d = DEFAULT_CONFIG;
  const c = isObject(raw) ? raw : {};
  const jev = isObject(c.jev) ? c.jev : {};
  const models = isObject(c.models) ? c.models : {};
  const r = isObject(c.router) ? c.router : {};
  const a = isObject(c.agents) ? c.agents : {};
  const k = isObject(c.compaction) ? c.compaction : {};
  const t = isObject(c.trim) ? c.trim : {};
  const h = isObject(c.handoff) ? c.handoff : {};
  const ui = isObject(c.ui) ? c.ui : {};
  const pr = isObject(c.projects) ? c.projects : {};
  const sv = isObject(c.savings) ? c.savings : {};
  const codex = isObject(c.codex) ? c.codex : {};
  const minEffort = effort(r.minEffort, d.router.minEffort);
  let maxEffort = effort(r.maxEffort, d.router.maxEffort);
  if (EFFORTS.indexOf(maxEffort) < EFFORTS.indexOf(minEffort)) maxEffort = minEffort;
  return {
    version: 1,
    enabled: bool(c.enabled, d.enabled),
    mode: c.mode === 'shadow' ? 'shadow' : 'active',
    shadowPaths: strings(c.shadowPaths, d.shadowPaths).map((p) => p.trim()).filter(Boolean),
    activePaths: strings(c.activePaths, d.activePaths).map((p) => p.trim()).filter(Boolean),
    excludeProjects: strings(c.excludeProjects, d.excludeProjects).map((p) => p.trim()).filter(Boolean),
    jev: {
      model: str(jev.model, d.jev.model),
      endpoint: str(jev.endpoint, d.jev.endpoint),
      keyFile: str(jev.keyFile, d.jev.keyFile),
      timeoutMs: num(jev.timeoutMs, d.jev.timeoutMs, 300, 20_000),
    },
    models: {
      standard: str(models.standard, d.models.standard),
      strong: str(models.strong, d.models.strong),
      light: str(models.light, d.models.light),
    },
    router: {
      mainModel: bool(r.mainModel, d.router.mainModel),
      mainEffort: bool(r.mainEffort, d.router.mainEffort),
      subagents: bool(r.subagents, d.router.subagents),
      upgradeAt: num(r.upgradeAt, d.router.upgradeAt, 0, 1),
      forceUpgradeAt: num(r.forceUpgradeAt, d.router.forceUpgradeAt, 0, 1),
      downgradeAt: num(r.downgradeAt, d.router.downgradeAt, 0, 1),
      subagentStrongAt: num(r.subagentStrongAt, d.router.subagentStrongAt, 0, 1),
      lightSubagents: r.lightSubagents === 'on' || r.lightSubagents === 'off' ? r.lightSubagents : 'shadow',
      lightBelow: num(r.lightBelow, d.router.lightBelow, 0, 1),
      lightMaxSteps: num(r.lightMaxSteps, d.router.lightMaxSteps, 1, 500),
      cheapSwitchTokens: num(r.cheapSwitchTokens, d.router.cheapSwitchTokens, 0, 2_000_000),
      expectedTurns: num(r.expectedTurns, d.router.expectedTurns, 1, 100),
      standardMaxContextTokens: num(
        r.standardMaxContextTokens,
        d.router.standardMaxContextTokens,
        10_000,
        2_000_000,
      ),
      cacheTtlMinutes: num(r.cacheTtlMinutes, d.router.cacheTtlMinutes, 1, 24 * 60),
      minEffort,
      maxEffort,
      defaultEffort: effort(r.defaultEffort, d.router.defaultEffort),
      fallbackEffort: effort(r.fallbackEffort, d.router.fallbackEffort),
      effortConfidenceAt: num(r.effortConfidenceAt, d.router.effortConfidenceAt, 0, 1),
      escalateAfterErrors: num(r.escalateAfterErrors, d.router.escalateAfterErrors, 0, 20),
      riskyAt: num(r.riskyAt, d.router.riskyAt, 0, 1),
      continuationAt: num(r.continuationAt, d.router.continuationAt, 0, 1),
      budgetAware: bool(r.budgetAware, d.router.budgetAware),
    },
    agents: {
      enabled: bool(a.enabled, d.agents.enabled),
      autoCreate: bool(a.autoCreate, d.agents.autoCreate),
      remapFrom: strings(a.remapFrom, d.agents.remapFrom),
      matchAt: num(a.matchAt, d.agents.matchAt, 0, 1),
      maxAgents: num(a.maxAgents, d.agents.maxAgents, 0, 500),
      exposeToModel: bool(a.exposeToModel, d.agents.exposeToModel),
      draftModel: str(a.draftModel, d.agents.draftModel),
      draftTimeoutMs: num(a.draftTimeoutMs, d.agents.draftTimeoutMs, 5_000, 120_000),
      waitHint: bool(a.waitHint, d.agents.waitHint),
    },
    compaction: {
      enabled: bool(k.enabled, d.compaction.enabled),
      compactAtTokens: num(k.compactAtTokens, d.compaction.compactAtTokens, 0, 2_000_000),
      compactAtPercent: num(k.compactAtPercent, d.compaction.compactAtPercent, 0, 95),
      recompactAfterTokens: num(k.recompactAfterTokens, d.compaction.recompactAfterTokens, 0, 2_000_000),
      thresholdMinReduction: num(k.thresholdMinReduction, d.compaction.thresholdMinReduction, 0, 1),
      minReductionRatio: num(k.minReductionRatio, d.compaction.minReductionRatio, 0, 1),
      keepThreshold: num(k.keepThreshold, d.compaction.keepThreshold, 0, 1),
      preserveRecentMessages: num(
        k.preserveRecentMessages,
        d.compaction.preserveRecentMessages,
        0,
        100,
      ),
      truncateHeadChars: num(k.truncateHeadChars, d.compaction.truncateHeadChars, 0, 5_000),
      maxStateTokens: num(k.maxStateTokens, d.compaction.maxStateTokens, 2_000, 30_000),
      maxRequestTokens: num(k.maxRequestTokens, d.compaction.maxRequestTokens, 3_000, 31_000),
      onReturn: bool(k.onReturn, d.compaction.onReturn),
      onReturnMinTokens: num(k.onReturnMinTokens, d.compaction.onReturnMinTokens, 0, 2_000_000),
      onReturnMinReduction: num(k.onReturnMinReduction, d.compaction.onReturnMinReduction, 0, 1),
      archive: bool(k.archive, d.compaction.archive),
      // Below ~0.5 a capped compaction falls under the minimum reductions and is skipped every time.
      maxPruneRatio: num(k.maxPruneRatio, d.compaction.maxPruneRatio, 0.5, 1),
      resultPreviewChars: num(k.resultPreviewChars, d.compaction.resultPreviewChars, 0, 1_000),
      // Under ~100k the engine would compact every few steps.
      autoWindowTokens: Math.round(num(k.autoWindowTokens, d.compaction.autoWindowTokens, 0, 2_000_000)),
    },
    handoff: {
      enabled: bool(h.enabled, d.handoff.enabled),
      maxTokens: num(h.maxTokens, d.handoff.maxTokens, 2_000, 60_000),
      brief: h.brief === 'always' || h.brief === 'never' ? h.brief : 'auto',
      briefWords: num(h.briefWords, d.handoff.briefWords, 100, 1_500),
      useJev: bool(h.useJev, d.handoff.useJev),
      suggestAtTokens: num(h.suggestAtTokens, d.handoff.suggestAtTokens, 0, 2_000_000),
      suggestAt: num(h.suggestAt, d.handoff.suggestAt, 0, 1),
      suggestColdAtTokens: num(h.suggestColdAtTokens, d.handoff.suggestColdAtTokens, 0, 2_000_000),
      keepDays: num(h.keepDays, d.handoff.keepDays, 1, 365),
    },
    trim: {
      enabled: bool(t.enabled, d.trim.enabled),
      minChars: num(t.minChars, d.trim.minChars, 1_000, 1_000_000),
      hugeChars: num(t.hugeChars, d.trim.hugeChars, 5_000, 4_000_000),
      listChars: t.listChars === 0 ? 0 : num(t.listChars, d.trim.listChars, 1_000, 1_000_000),
      headLines: num(t.headLines, d.trim.headLines, 0, 1_000),
      tailLines: num(t.tailLines, d.trim.tailLines, 0, 2_000),
      contextLines: num(t.contextLines, d.trim.contextLines, 0, 50),
      maxChars: num(t.maxChars, d.trim.maxChars, 2_000, 200_000),
      useJev: bool(t.useJev, d.trim.useJev),
      jevKeepAt: num(t.jevKeepAt, d.trim.jevKeepAt, 0, 1),
      keepDays: num(t.keepDays, d.trim.keepDays, 1, 90),
      maxStorageMb: num(t.maxStorageMb, d.trim.maxStorageMb, 10, 10_000),
    },
    projects: {
      enabled: bool(pr.enabled, d.projects.enabled),
      descriptionLanguage: pr.descriptionLanguage === 'ru' ? 'ru' : 'en',
      learnFromClaude: bool(pr.learnFromClaude, d.projects.learnFromClaude),
      minSuccesses: num(pr.minSuccesses, d.projects.minSuccesses, 1, 50),
      describeWithClaude: bool(pr.describeWithClaude, d.projects.describeWithClaude),
      showWorktrees: bool(pr.showWorktrees, d.projects.showWorktrees),
    },
    ui: {
      terminal: 'Terminal',
      port: num(ui.port, d.ui.port, 1024, 65_535),
      language: ui.language === 'ru' ? 'ru' : 'en',
      showStatus: bool(ui.showStatus, d.ui.showStatus),
      nodePath: str(ui.nodePath, d.ui.nodePath),
    },
    savings: {
      effortFactor: num(sv.effortFactor, d.savings.effortFactor, 0, 0.6),
      defaultBaseModel: str(sv.defaultBaseModel, d.savings.defaultBaseModel),
      defaultBaseEffort: effort(sv.defaultBaseEffort, d.savings.defaultBaseEffort),
    },
    codex: { enabled: bool(codex.enabled, d.codex.enabled) },
  };
}

/** `cwd` is `path` or inside it (`~` expanded). */
function under(path: string, cwd: string, home: string): boolean {
  const root = expandHome(path, home).replace(/\/+$/, '');
  return root.length > 0 && (cwd === root || cwd.startsWith(`${root}/`));
}

/** Whether a session in `cwd` only observes (shadow mode). */
export function isShadow(config: GovernorConfig, cwd: string, home: string): boolean {
  if (config.activePaths.some((p) => under(p, cwd, home))) return false;
  return config.mode === 'shadow' || config.shadowPaths.some((p) => under(p, cwd, home));
}

/** Whether a session in `cwd` must not send anything to Jev (`excludeProjects`). */
export function isExcluded(config: GovernorConfig, cwd: string, home: string): boolean {
  return config.excludeProjects.some((p) => under(p, cwd, home));
}

/** Expands a leading `~` against the home directory. */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  return path.startsWith('~/') ? `${home}/${path.slice(2)}` : path;
}
