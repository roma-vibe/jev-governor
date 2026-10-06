// Vendored from tamaratran/fast-jev-compaction (MIT, see ./LICENSE) at commit e3f262a.
// Changes by jev-governor (transport is supplied through JevAsker):
// - result previews: Jev sees the start and end of each tool output
//   (`resultPreviewChars`, 0 = upstream behaviour), not only its length;
// - `limitPruning`: puts calls back until at most `maxPruneRatio` is removed.

import { noulAnswer } from './request.ts';
import { collectToolCalls, estimateTokens, fitState } from './state.ts';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolUse,
} from './types.ts';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
  resultPreviewChars: 0,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
    resultPreviewChars: Math.max(
      0,
      Math.floor(finite(options.resultPreviewChars, DEFAULT_OPTIONS.resultPreviewChars)),
    ),
    ...(options.previewFilter ? { previewFilter: options.previewFilter } : {}),
  };
}

/** The two `noul` questions asked about one call: keep the call, keep its result. */
export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'>,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
      },
    ]),
  );
}

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[fast-jev-compaction truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        if (actions.get(tool.tool_use_id) !== 'drop_result') return tool;
        const text = truncatedResultText(
          tool.text ?? '',
          tool.isError ?? false,
          headChars,
        );
        if ((tool.text ?? '') === text) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const text = truncatedResultText(result.text, result.isError ?? false, headChars);
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      )
    ) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function inputChars(input: Record<string, unknown>): number {
  try {
    return JSON.stringify(input).length;
  } catch {
    return 20;
  }
}

/**
 * Puts pruned calls back, the ones Jev was least sure about first (highest
 * `keepResult`, then `keepCall`), until the compaction removes at most
 * `maxPruneRatio` of the history. One compaction that drops nearly everything
 * leaves the model guessing what it had; this bounds that. Returns `result`
 * itself when it is within the limit.
 */
export function limitPruning(
  messages: readonly Message[],
  result: CompactResult,
  options: { maxPruneRatio: number } & Partial<Pick<ResolvedCompactOptions, 'preserveRecentMessages' | 'truncateHeadChars'>>,
): CompactResult {
  const { charsBefore } = result.stats;
  const max = options.maxPruneRatio;
  if (!(max < 1) || charsBefore === 0 || reductionRatio(result) <= max) return result;
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const byId = new Map(calls.map((call) => [call.id, call]));
  const resultText = new Map<string, string>();
  for (const message of messages) {
    for (const r of message.toolResults ?? []) resultText.set(r.tool_use_id, r.text);
  }
  const saved = (decision: CallDecision): number => {
    const call = byId.get(decision.id);
    if (!call) return 0;
    const text = resultText.get(call.tool_use_id) ?? '';
    if (decision.action === 'drop_call') return inputChars(call.input) + text.length;
    if (decision.action === 'drop_result') {
      return text.length - truncatedResultText(text, call.isError, resolved.truncateHeadChars).length;
    }
    return 0;
  };
  const decisions = result.decisions.map((decision) => ({ ...decision }));
  const position = new Map(decisions.map((decision, i) => [decision, i]));
  // Least sure first; on a tie the newer call (decisions run oldest first).
  const order = decisions
    .filter((decision) => decision.action !== 'keep' && saved(decision) > 0)
    .sort((a, b) => b.keepResult - a.keepResult || b.keepCall - a.keepCall || position.get(b)! - position.get(a)!);
  let after = result.stats.charsAfter;
  let restored = 0;
  const excess = (): number => charsBefore - after - max * charsBefore;
  const restore = (decision: CallDecision): void => {
    after += saved(decision);
    decision.action = 'keep';
    decision.reason = 'restored';
    restored++;
  };
  // First pass, in that order: calls that do not overshoot the cap by more than
  // a tenth of the history (one huge output put back would undo the whole
  // compaction). Second, what is still needed with as little put back as
  // possible: the smallest call that covers it alone, else the largest first.
  const slack = 0.1 * charsBefore;
  for (const decision of order) {
    if (excess() <= 0) break;
    if (saved(decision) <= excess() + slack) restore(decision);
  }
  if (excess() > 0) {
    const left = order.filter((decision) => decision.action !== 'keep');
    const alone = left.filter((decision) => saved(decision) >= excess()).sort((a, b) => saved(a) - saved(b))[0];
    for (const decision of alone ? [alone] : left.sort((a, b) => saved(b) - saved(a))) {
      if (excess() <= 0) break;
      restore(decision);
    }
  }
  const kept = applyDecisions(messages, decisions, calls, resolved.truncateHeadChars);
  return {
    messages: kept,
    decisions,
    stats: {
      ...result.stats,
      messagesAfter: kept.length,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      restored,
    },
  };
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned
 * first and newest messages, whether the call and whether its result must
 * stay. The whole history (results omitted, fitted into `maxStateTokens`) is
 * sent as state with every batch of questions. Throws when Jev fails or the
 * history cannot be fitted; the caller decides whether to fall back.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: '' };
  let batches: ToolCall[][] = [];
  const answers = new Map<string, CallAnswer>();
  if (candidates.length > 0) {
    const state = fitState(messages, calls, resolved);
    fitted = state;
    batches = batchCalls(candidates, state.tokens, resolved);
    const answered = await Promise.all(
      batches.map((batch) => askBatch(asker, state.state, batch)),
    );
    for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
  }

  const decisions = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
  );
  const kept = applyDecisions(
    messages,
    decisions,
    calls,
    resolved.truncateHeadChars,
  );
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests: batches.length,
      ms: Date.now() - started,
    },
  };
}
