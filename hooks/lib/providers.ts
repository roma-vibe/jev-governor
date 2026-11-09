// Where a routing decision is carried out. v1 has one provider: Claude Code
// itself (model + effort on the request or the subagent). The shape leaves
// room for Codex: a tier could map to `{ provider: 'codex', model, effort }`,
// carried out by a registered tool or agent that runs the official `codex`
// CLI (`codex exec`) under the person's own ChatGPT login.

import type { Effort, GovernorConfig, Tier } from './types.ts';

export type ClaudeTarget = { provider: 'claude'; model: string; effort: Effort };
/** Not used in v1; see docs/ARCHITECTURE.md, "Codex". */
export type CodexTarget = { provider: 'codex'; model: string; effort: string };
export type Target = ClaudeTarget | CodexTarget;

export function claudeTarget(tier: Tier, effort: Effort, config: GovernorConfig): ClaudeTarget {
  return { provider: 'claude', model: config.models[tier], effort };
}

/** A model id as people name it: `claude-fable-5-2` → "Fable 5.2"; an id of another shape stays as it is. */
export function modelLabel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:$|[-[])/i.exec(model.trim());
  if (!m) return model;
  return `${m[1]!.charAt(0).toUpperCase()}${m[1]!.slice(1).toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

export function displayModel(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('fable')) return 'fable';
  return model;
}
