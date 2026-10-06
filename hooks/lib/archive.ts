// Pruned is not lost: every tool call the Jev compaction drops or truncates is
// saved to a file, and the compacted history points at it, so the model can
// read it back instead of re-running the tool or guessing. Pure: the caller
// writes the files and hands back their paths.

import type { CallDecision, Message, ToolCall } from './compaction/types.ts';

export type PrunedCall = {
  toolUseId: string;
  tool: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
  action: 'drop_result' | 'drop_call';
};

/** The calls the decisions drop or truncate, with their full input and output. */
export function prunedCalls(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
): PrunedCall[] {
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      results.set(result.tool_use_id, { text: result.text, isError: result.isError ?? false });
    }
  }
  const byId = new Map(calls.map((call) => [call.id, call]));
  const pruned: PrunedCall[] = [];
  for (const decision of decisions) {
    if (decision.action === 'keep') continue;
    const call = byId.get(decision.id);
    if (!call) continue;
    const result = results.get(call.tool_use_id);
    pruned.push({
      toolUseId: call.tool_use_id,
      tool: call.tool,
      input: call.input,
      result: result?.text ?? '',
      isError: result?.isError ?? call.isError,
      action: decision.action,
    });
  }
  return pruned;
}

function inputJson(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return '[unserializable input]';
  }
}

/** The main argument of a call, one line: the command, path, pattern or URL. */
export function callLabel(tool: string, input: Record<string, unknown>, max = 120): string {
  const main = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description ?? input.prompt;
  const arg = typeof main === 'string' ? main.replace(/\s+/g, ' ').trim() : '';
  const clipped = arg.length > max ? `${arg.slice(0, max)}…` : arg;
  return clipped ? `${tool}(${clipped})` : tool;
}

/**
 * What makes a later call a re-run of a pruned one: the same command, file,
 * search or URL. Undefined for tools whose re-run is not a lookup (edits,
 * subagents).
 */
export function rerunKey(tool: string, input: Record<string, unknown>): string | undefined {
  const s = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
  switch (tool) {
    case 'Bash': {
      // `cat <file>` reads a file as Read does: the same key.
      const cat = /^(?:cat|head|tail|less|bat)\s+(?:-\S+\s+)*("[^"]+"|'[^']+'|\S+)$/.exec(s(input.command));
      if (cat) return `Read:${cat[1]!.replace(/^["']|["']$/g, '')}`;
      return s(input.command) ? `Bash:${s(input.command)}` : undefined;
    }
    case 'Read':
      return s(input.file_path) ? `Read:${s(input.file_path)}` : undefined;
    case 'Grep':
    case 'Glob':
      return s(input.pattern) ? `${tool}:${s(input.pattern)}|${s(input.path)}` : undefined;
    case 'WebFetch':
      return s(input.url) ? `WebFetch:${s(input.url)}` : undefined;
    case 'WebSearch':
      return s(input.query) ? `WebSearch:${s(input.query)}` : undefined;
    default:
      return undefined;
  }
}

/** The file an edit tool changed, if any. */
export function editedPath(tool: string, input: Record<string, unknown>): string | undefined {
  if (!['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(tool)) return undefined;
  const path = input.file_path ?? input.notebook_path;
  return typeof path === 'string' && path.trim() ? path.trim() : undefined;
}

/** What a pruned call's archive file holds: the call, then its output verbatim. */
export function archiveText(call: PrunedCall): string {
  return [
    `# ${callLabel(call.tool, call.input, 300)}`,
    `tool_use_id: ${call.toolUseId}${call.isError ? ' (error)' : ''}`,
    '',
    '## input',
    inputJson(call.input),
    '',
    '## output',
    call.result,
    '',
  ].join('\n');
}

const POINTER_MARK = '[jev-governor pruned ';

/**
 * A result an earlier compaction already truncated: its full output is in the
 * archive, and the text is only its head and the pointer. Archiving it again
 * would overwrite the full output with the stub.
 */
export function isPointerText(text: string): boolean {
  return text.includes(POINTER_MARK) && text.includes('; full output: ');
}

/**
 * The text a truncated result keeps: its head and where the rest is. Short
 * results (within the head plus a little) stay whole, as the library leaves
 * them, and so does a pointer an earlier compaction left.
 */
export function pointerText(text: string, isError: boolean, headChars: number, path: string): string {
  if (text.length <= headChars + 120 || isPointerText(text)) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}${POINTER_MARK}${text.length - headChars} chars of this tool output${isError ? ' (error)' : ''}; full output: ${path} — read it there instead of re-running the tool]`;
}

/** One line of the pruned-calls index. */
export function indexLine(call: PrunedCall, path: string): string {
  const what = call.action === 'drop_call' ? 'call removed' : 'output truncated';
  const size = isPointerText(call.result) ? 'output archived earlier' : `${call.result.length} chars`;
  return `- ${callLabel(call.tool, call.input)}${call.isError ? ' → error' : ''} · ${what} · ${size} → ${path}`;
}

/** The note the compacted history carries about calls removed whole. */
export function indexNote(count: number, indexPath: string): string {
  return `[jev-governor: ${count} earlier tool call(s) were removed from this conversation to save context; their inputs and outputs are listed in ${indexPath} — read it if you need one]`;
}

/**
 * Puts the archive into the compacted history: a truncated result's note now
 * names its file, and the first rebuilt message mentions the index when calls
 * were removed whole. Messages the library returned untouched stay the same
 * objects (the engine keeps them whole by their handle).
 */
export function withPointers(
  original: readonly Message[],
  compacted: readonly Message[],
  pruned: readonly PrunedCall[],
  paths: ReadonlyMap<string, string>,
  headChars: number,
  index?: { path: string; removed: number },
): Message[] {
  const own = new Set<Message>(original);
  const truncated = new Map<string, PrunedCall>();
  for (const call of pruned) if (call.action === 'drop_result' && paths.has(call.toolUseId)) truncated.set(call.toolUseId, call);
  const point = (id: string, text: string, isError: boolean): string => {
    const call = truncated.get(id);
    return call ? pointerText(call.result, isError, headChars, paths.get(id)!) : text;
  };
  const alreadyNoted = index !== undefined && original.some((m) => m.text.includes(index.path));
  let noted = alreadyNoted || index === undefined || index.removed === 0;
  return compacted.map((message) => {
    if (own.has(message)) return message;
    const toolUses = message.toolUses.map((tool) =>
      truncated.has(tool.tool_use_id) && tool.text !== undefined
        ? { ...tool, text: point(tool.tool_use_id, tool.text, tool.isError ?? false) }
        : tool,
    );
    const rebuilt: Message = { ...message, toolUses };
    if (message.toolResults) {
      rebuilt.toolResults = message.toolResults.map((result) =>
        truncated.has(result.tool_use_id)
          ? { ...result, text: point(result.tool_use_id, result.text, result.isError ?? false) }
          : result,
      );
    }
    if (!noted && index) {
      noted = true;
      rebuilt.text = rebuilt.text.trim() ? `${rebuilt.text}\n\n${indexNote(index.removed, index.path)}` : indexNote(index.removed, index.path);
    }
    return rebuilt;
  });
}
