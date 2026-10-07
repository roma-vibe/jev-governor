// Session ↔ library mapping for Jev compaction, adapted from
// tamaratran/fast-jev-compaction hooks/fast-jev.ts (MIT): messages the
// library returns untouched are handed back as the engine's own objects
// (handles included), rebuilt ones as fresh messages.

import { compact, limitPruning, reductionRatio, resolveOptions } from './compact.ts';
import { askFolds, collectFoldCandidates, type FoldDecision, type FoldOptions } from './fold.ts';
import { collectToolCalls, fitState } from './state.ts';
import type { CompactOptions, CompactResult, JevAsker, Message, ToolResult, ToolUse } from './types.ts';

/** The engine's SessionMessage, structurally: what the mapping relies on. */
export type EngineMessage = Message & { handle?: string };

export function toEngineMessages<M extends EngineMessage>(
  input: readonly M[],
  output: readonly Message[],
): EngineMessage[] {
  const messages = new Map<Message, M>();
  const uses = new Map<ToolUse, ToolUse>();
  const results = new Map<ToolResult, ToolResult>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: EngineMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => {
        const known = uses.get(tool);
        if (known) return known;
        const copy: ToolUse = { tool_use_id: tool.tool_use_id, tool: tool.tool, input: tool.input };
        if (tool.text !== undefined) copy.text = tool.text;
        if (tool.isError) copy.isError = true;
        return copy;
      }),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) =>
          results.get(result) ?? {
            tool_use_id: result.tool_use_id,
            text: result.text,
            isError: result.isError ?? false,
          },
      );
    }
    return rebuilt;
  });
}

/** One line for the ledger and the toast; `fold`: old messages folded after the pruning, and the reduction of both. */
export function summarizeCompaction(result: CompactResult, fold?: { folded: number; requests: number; ratio: number }): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} calls dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
    stats.restored ? `${stats.restored} put back (prune cap)` : '',
    fold && fold.folded > 0 ? `${fold.folded} old message(s) folded` : '',
  ].filter(Boolean);
  const ratio = fold ? fold.ratio : reductionRatio(result);
  return `${Math.round(ratio * 100)}% reduction; ${parts.join(', ') || 'no tool calls'}; ${stats.requests + (fold?.requests ?? 0)} Jev request(s)`;
}

/** Compacts with Jev, then puts calls back while more than `maxPruneRatio` would go (1 = no cap). */
export async function runCompaction<M extends EngineMessage>(
  messages: readonly M[],
  asker: JevAsker,
  options: CompactOptions & { maxPruneRatio?: number },
): Promise<{ result: CompactResult; messages: EngineMessage[]; ratio: number }> {
  const raw = await compact(messages, asker, options);
  const result = limitPruning(messages, raw, { ...options, maxPruneRatio: options.maxPruneRatio ?? 1 });
  return { result, messages: toEngineMessages(messages, result.messages), ratio: reductionRatio(result) };
}

/**
 * Asks Jev which old dialog messages to fold (./fold.ts), with the state the
 * call questions get. Throws when Jev fails; the caller compacts without folds.
 */
export async function planFolds(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions,
  fold: FoldOptions,
): Promise<{ decisions: FoldDecision[]; requests: number }> {
  const candidates = collectFoldCandidates(messages, fold);
  if (candidates.length === 0) return { decisions: [], requests: 0 };
  const resolved = resolveOptions(options);
  const state = fitState(messages, collectToolCalls(messages, resolved.preserveRecentMessages), resolved);
  return askFolds(asker, state.state, state.tokens, candidates, messages, fold);
}
