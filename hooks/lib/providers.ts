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

export function displayModel(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('fable')) return 'fable';
  return model;
}
