// jev-governor addition to the vendored compaction (not upstream): Jev folds
// old dialog text. compact.ts only ever touches tool calls, so in a long chat
// earlier answers, background-task notifications and long pastes pile up and
// are carried through every compaction (one real chat kept ~96k tokens of
// them, written into the cache again at each of its 67 compactions). A folded
// message keeps its first lines and a pointer to the archived full text, which
// the model reads back when it needs it.

import { noulAnswer } from './request.ts';
import { estimateTokens, isPinned } from './state.ts';
import type { CompactionState, JevAsker, JevQuestions, Message, Role } from './types.ts';

/**
 * `answer`: the assistant's text; `paste`: a long user message; `agent`,
 * `monitor`, `task`: a `<task-notification>` with an agent's result, a
 * monitor's event, or anything else (a background command finishing).
 */
export type FoldKind = 'answer' | 'paste' | 'agent' | 'monitor' | 'task';

export interface FoldOptions {
  /** The newest user prompts whose turns are never folded (superseded notifications aside). */
  keepTurns: number;
  /** Newest messages never touched; the first message is always kept. */
  preserveRecentMessages: number;
  /** Shortest text of each kind worth folding. */
  minChars: Record<FoldKind, number>;
  /** Keep probability at or above which a message of each kind stays verbatim. */
  keepAt: Record<FoldKind, number>;
  /** Characters of a folded text (a notification: of its body) left in place. */
  headChars: Record<FoldKind, number>;
  /** Characters of a candidate's start quoted in its question (and half that of its end). */
  previewChars: number;
  /** Estimated token ceiling for the state plus one batch of questions. */
  maxRequestTokens: number;
  /** Applied to the quoted start and end before Jev sees them (secrets). */
  previewFilter?: (text: string) => string;
}

export const DEFAULT_FOLD_OPTIONS: FoldOptions = {
  keepTurns: 2,
  preserveRecentMessages: 6,
  minChars: { answer: 800, paste: 3000, agent: 800, monitor: 200, task: 400 },
  // Jev's keep probabilities for old dialog sit between ~0.15 and ~0.35. On 340
  // messages of a long chat graded in hindsight (did the work after the
  // compaction need more than the first 300 chars?) none was needed beyond its
  // head; Jev ranked the ones related to the ongoing work highest (AUC 0.84).
  // These cut-offs fold ~80% of the text and keep about half of the related
  // ones. A user's own words are folded only when Jev is quite sure.
  keepAt: { answer: 0.3, paste: 0.2, agent: 0.25, monitor: 0.35, task: 0.35 },
  // A progress event's gist is in its first line; a newer one usually repeats it.
  headChars: { answer: 300, paste: 300, agent: 300, monitor: 120, task: 160 },
  previewChars: 240,
  maxRequestTokens: 30_000,
};

export interface FoldCandidate {
  /** Question key suffix, `m<index>`. */
  id: string;
  /** Index in the messages the candidates were collected from. */
  index: number;
  role: Role;
  kind: FoldKind;
  chars: number;
  /** User prompts after this message. */
  turnsAgo: number;
  /** A notification's `<summary>`. */
  label?: string;
  /** A newer notification of the same task id. */
  supersededBy?: number;
}

export interface FoldDecision extends FoldCandidate {
  /** Jev's probability that the message must stay verbatim. */
  keep: number;
  fold: boolean;
}

/** Starts every folded text, so a later compaction leaves it alone. */
export const FOLD_MARK = '[jev-governor folded';

/** What a fold must take away beyond the head it leaves, or the pointer is not worth it. */
const MIN_SAVING = 250;

const NOTICE = '<task-notification>';
/** User-side text the engine writes, not a prompt the person typed. */
const ENGINE_TEXT = /^<(task-notification|system-reminder|local-command-|command-|bash-)/;

/** Text the person typed (not a notification, reminder or command echo the engine wrote). */
export function isTypedText(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.length > 0 && !ENGINE_TEXT.test(trimmed);
}

/** A prompt the person wrote: starts a turn. */
export function isPrompt(message: Message): boolean {
  if (message.role !== 'user' || (message.toolResults ?? []).length > 0) return false;
  return isTypedText(message.text);
}

/** A file name for a folded text: the same text always gets the same name (FNV-1a and length). */
export function foldFileName(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, '0')}-${text.length}.md`;
}

function noticeKind(text: string): FoldKind | undefined {
  if (!text.trimStart().startsWith(NOTICE)) return undefined;
  if (text.includes('<result>')) return 'agent';
  if (text.includes('<event>')) return 'monitor';
  return 'task';
}

function tag(text: string, name: string): string | undefined {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();
}

/** The part a fold shortens: a notification's result or event, any other message's whole text. */
function foldableChars(text: string, kind: FoldKind): number {
  if (kind === 'answer' || kind === 'paste') return text.length;
  return (tag(text, 'result') ?? tag(text, 'event') ?? text).length;
}

/**
 * The messages Jev is asked about: older than the newest `keepTurns` prompts
 * (a notification a newer one of the same task supersedes: anywhere), outside
 * the pinned first and newest messages, long enough to matter, not folded yet.
 */
export function collectFoldCandidates(
  messages: readonly Message[],
  options: Pick<FoldOptions, 'keepTurns' | 'preserveRecentMessages' | 'minChars' | 'headChars'>,
): FoldCandidate[] {
  const prompts: number[] = [];
  const lastOfTask = new Map<string, number>();
  messages.forEach((message, index) => {
    if (isPrompt(message)) prompts.push(index);
    else if (message.role === 'user' && noticeKind(message.text)) {
      const id = tag(message.text, 'task-id');
      if (id) lastOfTask.set(id, index);
    }
  });
  const keepTurns = Math.max(0, Math.floor(options.keepTurns));
  const cutoff = keepTurns === 0 ? messages.length : prompts.length > keepTurns ? prompts[prompts.length - keepTurns]! : 0;
  const candidates: FoldCandidate[] = [];
  let seen = 0;
  messages.forEach((message, index) => {
    while (seen < prompts.length && prompts[seen]! <= index) seen++;
    if (isPinned(index, messages.length, options.preserveRecentMessages)) return;
    const text = message.text;
    if (!text || text.includes(FOLD_MARK)) return;
    let kind: FoldKind | undefined;
    let label: string | undefined;
    let supersededBy: number | undefined;
    if (message.role === 'assistant') kind = 'answer';
    else {
      kind = noticeKind(text);
      if (kind) {
        label = tag(text, 'summary');
        const id = tag(text, 'task-id');
        const last = id === undefined ? undefined : lastOfTask.get(id);
        if (last !== undefined && last > index) supersededBy = last;
      } else if (isPrompt(message)) kind = 'paste';
    }
    if (!kind) return;
    const foldable = foldableChars(text, kind);
    if (foldable < options.minChars[kind] || foldable < options.headChars[kind] + MIN_SAVING) return;
    if (index >= cutoff && supersededBy === undefined) return;
    candidates.push({
      id: `m${index}`,
      index,
      role: message.role,
      kind,
      chars: text.length,
      turnsAgo: prompts.length - seen,
      ...(label ? { label: label.slice(0, 160) } : {}),
      ...(supersededBy !== undefined ? { supersededBy } : {}),
    });
  });
  return candidates;
}

const KIND_TEXT: Record<FoldKind, string> = {
  answer: 'an earlier message of the assistant',
  paste: 'a long earlier message of the user',
  agent: 'the result of a background agent',
  monitor: 'an event of a background monitor',
  task: 'a background task notification',
};

function preview(text: string, chars: number, filter?: (text: string) => string): string {
  const flat = (part: string): string => (filter ? filter(part) : part).replace(/\s+/g, ' ').trim();
  const tail = Math.floor(chars / 2);
  if (text.length <= chars + tail + 40) return `«${flat(text)}»`;
  // The filter sees a margin past each cut: a secret across the cut is whole when it is replaced.
  return `«${flat(text.slice(0, chars + 80)).slice(0, chars)} […] ${flat(text.slice(-(tail + 80))).slice(-tail)}»`;
}

/** The one `noul` question asked about a candidate: must it stay verbatim. */
export function foldQuestion(
  candidate: FoldCandidate,
  text: string,
  options: Pick<FoldOptions, 'previewChars' | 'previewFilter'>,
): JevQuestions {
  const what = [
    KIND_TEXT[candidate.kind],
    candidate.label ? `"${candidate.label}"` : '',
    `${candidate.chars} chars`,
    candidate.turnsAgo > 0 ? `${candidate.turnsAgo} user prompt(s) ago` : 'in the current turn',
  ]
    .filter(Boolean)
    .join(', ');
  const later =
    candidate.supersededBy === undefined ? '' : ` A newer notification of the same task follows at i=${candidate.supersededBy}.`;
  return {
    [`keep_${candidate.id}`]: {
      type: 'noul',
      instructions: `Message i=${candidate.index} (${what}) should stay in the history verbatim: what the assistant does next still depends on its exact wording or details. Otherwise it is folded to its first lines and a pointer to a file with the full text, which the assistant can read back at any time.${later} It reads: ${preview(text, options.previewChars, options.previewFilter)}`,
    },
  };
}

/** Splits candidates into batches whose questions fit one request next to the state. */
export function batchFolds(
  candidates: readonly FoldCandidate[],
  messages: readonly Message[],
  stateTokens: number,
  options: Pick<FoldOptions, 'previewChars' | 'previewFilter' | 'maxRequestTokens'>,
): FoldCandidate[][] {
  const budget = options.maxRequestTokens - stateTokens - 20;
  const batches: FoldCandidate[][] = [];
  let current: FoldCandidate[] = [];
  let used = 0;
  for (const candidate of candidates) {
    const tokens = estimateTokens(JSON.stringify(foldQuestion(candidate, messages[candidate.index]?.text ?? '', options)));
    if (tokens > budget) throw new Error(`state leaves no room for fold questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`);
    if (current.length > 0 && used + tokens > budget) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(candidate);
    used += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Asks Jev about every candidate (batches in parallel). Throws when Jev fails. */
export async function askFolds(
  asker: JevAsker,
  state: CompactionState,
  stateTokens: number,
  candidates: readonly FoldCandidate[],
  messages: readonly Message[],
  options: FoldOptions,
): Promise<{ decisions: FoldDecision[]; requests: number }> {
  if (candidates.length === 0) return { decisions: [], requests: 0 };
  const batches = batchFolds(candidates, messages, stateTokens, options);
  const answered = await Promise.all(
    batches.map(async (batch) => {
      const questions: JevQuestions = Object.assign(
        {},
        ...batch.map((candidate) => foldQuestion(candidate, messages[candidate.index]?.text ?? '', options)),
      );
      const { answers } = await asker.ask(state, questions);
      return batch.map((candidate): FoldDecision => {
        const keep = noulAnswer(answers, `keep_${candidate.id}`);
        return { ...candidate, keep, fold: keep < options.keepAt[candidate.kind] };
      });
    }),
  );
  return { decisions: answered.flat(), requests: batches.length };
}

/** The first `chars` of a text, cut at a line or sentence end where one is near. */
export function headOf(text: string, chars: number): string {
  const trimmed = text.trim();
  if (chars <= 0) return '';
  if (trimmed.length <= chars) return trimmed;
  const cut = trimmed.slice(0, chars);
  const floor = Math.floor(chars * 0.6);
  const line = cut.lastIndexOf('\n');
  if (line >= floor) return `${cut.slice(0, line).trimEnd()}\n…`;
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence >= floor) return `${cut.slice(0, sentence + 1)} …`;
  return `${cut.trimEnd()}…`;
}

/** What a folded message reads: the pointer, then its first lines (a notification keeps its envelope). */
export function foldedText(text: string, candidate: Pick<FoldCandidate, 'kind' | 'chars'>, path: string, headChars: number): string {
  const note = `${FOLD_MARK} ${candidate.chars} chars to save context; the full text is in ${path} — read it there if you need it]`;
  if (candidate.kind !== 'answer' && candidate.kind !== 'paste') {
    // Task id, output file, status and summary stay; the boilerplate note goes; the body folds.
    const envelope = text.replace(/\n?<note>[\s\S]*?<\/note>/, '');
    for (const name of ['result', 'event']) {
      const body = tag(envelope, name);
      if (body === undefined) continue;
      const head = headOf(body, headChars);
      return envelope.replace(new RegExp(`<${name}>[\\s\\S]*?</${name}>`), () => `<${name}>${note}${head ? `\n${head}` : ''}</${name}>`);
    }
  }
  const head = headOf(text, headChars);
  return `${note}${head ? `\n${head}` : ''}`;
}

/** What the archive file of a folded message holds. */
export function foldArchiveText(text: string, candidate: Pick<FoldCandidate, 'kind' | 'role' | 'label'>): string {
  return `# Folded ${candidate.role} message (${KIND_TEXT[candidate.kind]}${candidate.label ? `: ${candidate.label}` : ''})\n\n${text}\n`;
}

/**
 * The messages with every folded candidate that has an archive path replaced
 * by a copy holding its folded text (when that is shorter by a margin); all
 * other messages are the same objects.
 */
export function applyFolds(
  messages: readonly Message[],
  decisions: readonly FoldDecision[],
  paths: ReadonlyMap<number, string>,
  headChars: Record<FoldKind, number>,
): Message[] {
  const byIndex = new Map(decisions.filter((d) => d.fold && paths.has(d.index)).map((d) => [d.index, d]));
  return messages.map((message, index) => {
    const decision = byIndex.get(index);
    if (!decision) return message;
    const text = foldedText(message.text, decision, paths.get(index)!, headChars[decision.kind]);
    if (text.length > message.text.length - 100) return message;
    const folded: Message = { role: message.role, text, toolUses: message.toolUses };
    if (message.toolResults) folded.toolResults = message.toolResults;
    return folded;
  });
}

/** Counts for the ledger: candidates, folded, and characters folded away, per kind. */
export function foldStats(
  decisions: readonly FoldDecision[],
  before: readonly Message[],
  after: readonly Message[],
): { candidates: number; folded: number; charsSaved: number; byKind: Partial<Record<FoldKind, number>> } {
  const byKind: Partial<Record<FoldKind, number>> = {};
  let folded = 0;
  let charsSaved = 0;
  for (const decision of decisions) {
    const was = before[decision.index];
    const now = after[decision.index];
    if (!was || !now || was === now) continue;
    folded++;
    byKind[decision.kind] = (byKind[decision.kind] ?? 0) + 1;
    charsSaved += was.text.length - now.text.length;
  }
  return { candidates: decisions.length, folded, charsSaved, byKind };
}
