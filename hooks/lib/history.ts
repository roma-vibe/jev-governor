// A small, recent view of the conversation for routing decisions: enough for
// Jev to read a terse follow-up ("yes, do it") in context, small enough to
// keep a decision well under a second.

import { estimateTokens } from './compaction/state.ts';

export type HistoryMessage = {
  role: 'user' | 'assistant';
  text: string;
  toolUses: readonly {
    tool: string;
    input: Record<string, unknown>;
    isError?: boolean;
  }[];
  toolResults?: readonly { isError?: boolean }[];
};

/** Drops the wrapper Claude Code puts around pasted text, keeping the text. */
export function unwrapPasted(text: string): string {
  return text.replace(/<\/?pasted_content[^>]*>/g, ' ');
}

export function clip(text: string, head: number, tail = 0): string {
  const flat = unwrapPasted(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= head + tail + 20) return flat;
  return tail > 0
    ? `${flat.slice(0, head)} […] ${flat.slice(-tail)}`
    : `${flat.slice(0, head)}…`;
}

function toolLine(tool: HistoryMessage['toolUses'][number]): string {
  const input = tool.input ?? {};
  const main =
    input.command ?? input.file_path ?? input.pattern ?? input.description ?? input.url ?? input.prompt;
  const arg = typeof main === 'string' ? clip(main, 80) : '';
  return `${tool.tool}${arg ? `(${arg})` : ''}${tool.isError ? ' → error' : ''}`;
}

/** System prompt, tools and memory files a session carries before any message. */
const BASE_CONTEXT_TOKENS = 30_000;

/**
 * A rough context size from the transcript, for when the engine has no figure
 * yet (before the session's first response): base overhead plus the text,
 * tool inputs and tool outputs at ~3.5 characters a token.
 */
export function estimateContextTokens(
  messages: readonly (HistoryMessage & { toolUses: readonly { text?: string }[] })[],
): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.text.length;
    for (const tool of message.toolUses) {
      chars += JSON.stringify(tool.input ?? {}).length + (tool.text?.length ?? 0);
    }
  }
  return BASE_CONTEXT_TOKENS + Math.round(chars / 3.5);
}

/**
 * The newest messages as one line each (text abridged, tool calls as
 * `Tool(arg)`), oldest first, within `maxTokens`. The latest user message is
 * left out when it equals `latest` (it is sent on its own).
 */
export function recentHistory(
  messages: readonly HistoryMessage[],
  options: { maxTokens: number; maxMessages: number; latest?: string },
): string[] {
  const lines: string[] = [];
  let tokens = 0;
  let skippedLatest = false;
  for (let i = messages.length - 1; i >= 0 && lines.length < options.maxMessages; i--) {
    const message = messages[i]!;
    if (
      !skippedLatest &&
      options.latest !== undefined &&
      message.role === 'user' &&
      message.text.trim() === options.latest.trim()
    ) {
      skippedLatest = true;
      continue;
    }
    const parts: string[] = [];
    if (message.text.trim()) parts.push(clip(message.text, message.role === 'user' ? 500 : 300, 150));
    if (message.toolUses.length > 0) parts.push(message.toolUses.map(toolLine).join('; '));
    const errors = (message.toolResults ?? []).filter((r) => r.isError).length;
    if (errors > 0) parts.push(`${errors} tool error(s)`);
    if (parts.length === 0) continue;
    const line = `${message.role}: ${parts.join(' | ')}`;
    const cost = estimateTokens(line);
    if (tokens + cost > options.maxTokens) break;
    tokens += cost;
    lines.push(line);
  }
  return lines.reverse();
}
