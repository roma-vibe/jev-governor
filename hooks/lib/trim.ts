// Trimming of large tool outputs before they enter the conversation. Every
// later step re-reads the whole history, so a 3000-line test log costs on
// every step after it. What is kept is chosen so the assistant should not
// need to re-run the command:
// - an outcome line (tests passed / failed with counts, build error),
// - every error / warning / failure line with context around it,
// - summary lines (test result, totals, durations),
// - the first and last lines,
// - optionally, middle chunks Jev judges still needed for the task,
// and the full output is saved to a file the header points at, so anything
// omitted is one Read away. Repetitive progress lines (Compiling…, test … ok)
// are collapsed into counts rather than dropped silently. Pure: no engine
// interface, no I/O.

export type TrimSettings = {
  /** Runner output (tests, builds, installs) shorter than this stays whole. */
  minChars: number;
  /** Any other output longer than this is trimmed too. */
  hugeChars: number;
  headLines: number;
  tailLines: number;
  /** Lines kept around each error / warning / failure line. */
  contextLines: number;
  /** Soft budget for the kept text; signal and summary lines are never dropped for it. */
  maxChars: number;
  /** A listing (ls, du, ps, find…) longer than this is shortened too; 0 = never. */
  listChars?: number;
};

/** A trim that removes less than this share keeps the output whole: it would only add a header. */
export const MIN_TRIM_GAIN = 0.15;

/** Whether a trim from `before` to `after` characters is worth it. */
export function worthTrimming(before: number, after: number): boolean {
  return after <= before * (1 - MIN_TRIM_GAIN);
}

/**
 * A test / build / install run, matched at the start of a command segment
 * (after `cd …;`, `&&`, `|`, `(`, an env assignment, `time` or `timeout N`),
 * and ending there: `eslint.config.js` or `.prettierrc.json` in a file list
 * is not a run. On 6 October such lists (`for f in … eslint.config.js …;
 * cat`) were taken for runs, so whole files were "trimmed" and grew.
 */
const RUNNER_HEAD =
  /^(cargo\s+(\+\S+\s+)?(test|build|check|clippy|run|bench|doc|nextest|fmt|tauri\s+build)|(npm|pnpm|yarn|bun)\s+(--?\S+\s+(\S+\s+)?)?(install|ci|i|test|t|run|build|exec|x|add)|npx|bunx|vitest|jest|pytest|python3?\s+-m\s+(pytest|unittest|pip)|go\s+(test|build|vet|mod)|make|gradle|(\.\/)?gradlew|mvn|docker\s+(build|compose)|docker-compose|pip3?\s+install|tsc|eslint|vue-tsc|prettier|swift\s+(build|test)|xcodebuild|dotnet\s+(build|test|restore)|rspec|bundle\s+(exec|install)|mix\s+(test|compile)|ruff|mypy|deno\s+(test|task)|playwright|cypress|tauri\s+build|flutter\s+(build|test|pub))(?=\s|$)/;

/** Commands run to read something: their output is the point, never trimmed below hugeChars. */
const DELIBERATE_READ =
  /^(cat|head|tail|sed|awk|less|more|bat|nl|grep|rg|ag|jq|yq|git\s+(diff|show|log|blame|grep)|diff|cut|sort|uniq|wc|curl|wget|xxd|hexdump|od|strings|base64|find|ls|tree)(?=\s|$)/;

/** Commands that list things: a long listing is mostly rows the task does not need. */
const LISTING_HEAD = /^(ls|du|ps|find|tree|lsof|df|top|pstree|git\s+ls-files)(?=\s|$)/;
/** What may filter a listing after a pipe and keep it a listing. */
const LIST_FILTER = /^(sort|uniq|head|tail|grep|rg|wc|cut|column|awk|sed|tr)(?=\s|$)/;

/** Tools whose results are content the assistant asked for, or already short. */
const NEVER = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'TodoWrite', 'Agent', 'Task', 'Glob', 'Grep']);

type Segment = { head: string; piped: boolean };

/**
 * The simple commands of a shell line, each with its leading noise removed
 * (`(`, `{`, env assignments, `time`, `timeout N`, `sudo`) and whether it
 * reads a pipe. Quoted text is blanked first, so a `;` or a tool name inside
 * quotes splits or matches nothing. A heuristic, not a shell parser.
 */
export function commandSegments(command: string): Segment[] {
  const plain = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, 'Q');
  const out: Segment[] = [];
  const re = /(\|\||&&|[;|&\n]|\$\(|`)/g;
  let last = 0;
  let sep = '';
  const push = (raw: string, before: string): void => {
    let head = raw.trim();
    for (;;) {
      const next = head
        .replace(/^[({!]\s*/, '')
        .replace(/^\w+=\S*\s+/, '')
        .replace(/^(time|sudo|nice|nohup|exec)\s+/, '')
        .replace(/^timeout\s+\S+\s+/, '');
      if (next === head) break;
      head = next;
    }
    if (head) out.push({ head, piped: before === '|' });
  };
  for (let m = re.exec(plain); m; m = re.exec(plain)) {
    push(plain.slice(last, m.index), sep);
    sep = m[1]!;
    last = m.index + m[1]!.length;
  }
  push(plain.slice(last), sep);
  return out;
}

/** The first segment that does something (not `cd`, `echo` or `set`). */
function firstWork(segments: readonly Segment[]): Segment | undefined {
  return segments.find((s) => !/^(cd|pushd|echo|printf|set|export|source|\.)(?=\s|$)/.test(s.head));
}

/** A test / build / install run (not a command run to read something). */
export function isRunnerCommand(command: string | undefined): boolean {
  if (command === undefined) return false;
  const segments = commandSegments(command);
  const first = firstWork(segments);
  if (!first || DELIBERATE_READ.test(first.head)) return false;
  return segments.some((s) => !s.piped && RUNNER_HEAD.test(s.head));
}

/**
 * A command that only lists (ls, du, ps, find… optionally filtered through
 * sort, grep, head…): every unpiped segment lists or is `cd`/`echo`, every
 * piped one filters. `find … -exec cat` and `| xargs cat` are reads, not
 * listings.
 */
export function isListingCommand(command: string | undefined): boolean {
  if (command === undefined || /-exec\b|xargs/.test(command)) return false;
  const segments = commandSegments(command);
  let listing = false;
  for (const s of segments) {
    if (s.piped) {
      if (!LIST_FILTER.test(s.head)) return false;
    } else if (LISTING_HEAD.test(s.head)) {
      listing = true;
    } else if (!/^(cd|pushd|echo|printf)(?=\s|$)/.test(s.head)) {
      return false;
    }
  }
  return listing;
}
/**
 * Claude Code's own stand-in for a Bash output over ~30k characters: the file
 * it saved the output to, and a ~2KB preview of its start, so the error
 * lines and the summary at the end are not in it. Undefined for anything else.
 */
export function persistedOutputPath(text: string): string | undefined {
  if (!text.trimStart().startsWith('<persisted-output>')) return undefined;
  return /Full output saved to: (.+?)\s*$/m.exec(text)?.[1];
}

/**
 * Whether `path` is where Claude Code keeps a session's saved tool outputs
 * (`~/.claude/projects/<project>/<session>/tool-results/…`). The preview's
 * text is the command's output, which a command can forge: a path named
 * there is read only when it is one of these.
 */
export function isClaudeSavedOutput(path: string, home: string): boolean {
  return (
    home.length > 0 &&
    path.startsWith(`${home}/.claude/projects/`) &&
    /\/tool-results\/[^/]+$/.test(path) &&
    !path.split('/').some((part) => part === '..' || part === '.')
  );
}

/** Why an output is trimmed: a test or build run, a long listing, or any output past `hugeChars`. */
export type TrimKind = 'run' | 'list' | 'huge';

export function trimKind(
  tool: string,
  command: string | undefined,
  text: string,
  settings: TrimSettings,
): TrimKind | undefined {
  if (NEVER.has(tool)) return undefined;
  if (text.length >= settings.hugeChars) return 'huge';
  if (tool !== 'Bash' || !command) return undefined;
  if (text.length >= settings.minChars && isRunnerCommand(command)) return 'run';
  if (settings.listChars && text.length >= settings.listChars && isListingCommand(command)) return 'list';
  return undefined;
}

export function shouldTrim(tool: string, command: string | undefined, text: string, settings: TrimSettings): boolean {
  return trimKind(tool, command, text, settings) !== undefined;
}

const SIGNAL =
  /\berror(\[E\d+\])?\b|\bwarning\b|\bWARN(ING)?\b|\bfail(s|ed|ure|ures|ing)?\b|\bFAIL(ED|URE)?\b|\bpanic(ked)?\b|\bexception\b|\bTraceback\b|\bassert(ion|ions)?\b|\bexpected\b|\bactual\b|^\s*(left|right)\s*[:=]|^\s*-->\s|\bnot ok\b|[✗✘×❌]|\bERR!|\bdenied\b|\bNo such file\b|\bcannot (find|open|resolve)\b|\bnot found\b|\bundefined (reference|symbol|is not)|\bSegmentation fault\b|\bKilled\b|\btimed? ?out\b|^E\s{2,}|^\s+\^+\s*$|^\s*(note|help):|\bat .+:\d+:\d+|\bunresolved\b|\bmismatch(ed)?\b/i;

const SUMMARY =
  /test result:|^\s*Tests?:?\s+\d|^\s*Test (Files|Suites):?\s|\b\d+\s+(passed|failed|skipped|ignored|pending|todo|errors?|warnings?|tests?)\b|^(ok|FAIL|PASS)\s|^={3,}|^\s*Finished\b|\bDone in\b|^\s*Duration\b|^Ran \d+ tests?|\bBuild (succeeded|failed|complete)|exit (code|status)|Exit code|added \d+ packages?|up to date|found \d+ vulnerabilit|^\s*Running\s.+\(.+\)$|^\s*Doc-tests\s/i;

/** Repetitive progress lines: collapsed into counts, never kept by position alone. */
const NOISE: readonly (readonly [string, RegExp])[] = [
  ['compile', /^\s*(Compiling|Checking|Fresh|Building|Linking|Downloaded|Downloading|Updating|Locking|Adding|Blocking waiting|Documenting|Packaging|Installing|Unpacking|Resolving)\s/],
  ['test ok', /^test\s.+\s\.\.\.\s(ok|ignored)\s*$|^\s*[✓√✔]\s|^\s*PASS\s|^ok\s+\d+\s|^\s*passed\s/],
  ['npm warn', /^npm (warn|WARN) (deprecated|ERESOLVE overriding)|^\s*(added|removed|changed|audited) \d+ packages? in/],
  ['progress', /^\s*\[?\s*\d+\s*\/\s*\d+\s*\]?\s|^\s*\d+%\s|^#\d+\s/],
];

function noiseKind(line: string): string | undefined {
  for (const [kind, re] of NOISE) if (re.test(line)) return kind;
  return undefined;
}

/** A progress line rewritten in place (`\r`) shows only its last state. */
function lastCarriageSegment(line: string): string {
  const parts = line.split('\r').filter((p) => p.length > 0);
  return parts.length > 0 ? parts[parts.length - 1]! : '';
}

export type Outcome = { status: 'passed' | 'failed' | 'build-error' | 'error' | 'unknown'; detail: string };

/** Reads the result off common test runners and compilers; `isError` is the exit status. */
export function detectOutcome(lines: readonly string[], isError: boolean): Outcome {
  let passed = 0;
  let failed = 0;
  let ignored = 0;
  let found = false;
  let compileError = false;
  const failing: string[] = [];
  for (const line of lines) {
    let m = /test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/.exec(line);
    if (m) {
      found = true;
      passed += Number(m[2]);
      failed += Number(m[3]);
      ignored += Number(m[4]);
      continue;
    }
    m = /^\s*Tests?:?\s+(?:(\d+) failed\s*[|,]\s*)?(?:(\d+) skipped\s*[|,]\s*)?(\d+) passed/.exec(line);
    if (m) {
      found = true;
      failed += Number(m[1] ?? 0);
      passed += Number(m[3]);
      continue;
    }
    m = /^\s*Tests?:?\s+(\d+) failed\s*\((\d+)\)/.exec(line);
    if (m) {
      found = true;
      failed += Number(m[1]);
      continue;
    }
    m = /^=+.*?(?:(\d+) failed)?(?:,\s*)?(?:(\d+) passed)?.* in [\d.]+s/.exec(line);
    if (m && (m[1] || m[2])) {
      found = true;
      failed += Number(m[1] ?? 0);
      passed += Number(m[2] ?? 0);
      continue;
    }
    if (/^error(\[E\d+\])?: could not compile|^error\[E\d+\]|error TS\d+:|^\s*error: aborting/.test(line)) compileError = true;
    m = /^---- (\S+) stdout ----/.exec(line) ?? /^\s*(?:FAIL|[×✗])\s+(.+?)\s*(?:\(|$)/.exec(line);
    if (m && failing.length < 12 && !failing.includes(m[1]!)) failing.push(m[1]!);
  }
  const names = failing.length > 0 ? `; failing: ${failing.join(', ')}` : '';
  if (compileError && !found) return { status: 'build-error', detail: `build failed (compile errors below)${names}` };
  if (found) {
    const counts = `${passed} passed, ${failed} failed${ignored ? `, ${ignored} ignored` : ''}`;
    if (failed > 0 || isError) return { status: 'failed', detail: `tests FAILED (${counts})${names}` };
    return { status: 'passed', detail: `tests passed (${counts})` };
  }
  if (isError) return { status: 'error', detail: `command exited with an error${names}` };
  return { status: 'unknown', detail: 'finished (no test summary found)' };
}

export type Chunk = { id: string; start: number; end: number; text: string };

export type TrimPlan = {
  lines: string[];
  /** Line indexes kept deterministically. */
  keep: boolean[];
  /** Omitted stretches with real content, offered to Jev. */
  candidates: Chunk[];
  outcome: Outcome;
};

const CHUNK_LINES = 40;
const CHUNK_CHARS = 2500;

export function planTrim(text: string, isError: boolean, settings: TrimSettings): TrimPlan {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map(lastCarriageSegment);
  const n = lines.length;
  const keep = new Array<boolean>(n).fill(false);
  const noise = lines.map(noiseKind);
  const mark = (i: number): void => {
    if (i >= 0 && i < n && noise[i] === undefined) keep[i] = true;
  };
  for (let i = 0; i < n; i++) {
    const line = lines[i]!;
    if (i < settings.headLines || i >= n - settings.tailLines) mark(i);
    if (SUMMARY.test(line)) keep[i] = true;
    if (noise[i] === undefined && SIGNAL.test(line)) {
      for (let j = i - settings.contextLines; j <= i + settings.contextLines; j++) mark(j);
    }
  }
  // Omitted stretches that are not pure noise become Jev candidates.
  const candidates: Chunk[] = [];
  let i = 0;
  while (i < n) {
    if (keep[i] || noise[i] !== undefined || lines[i]!.trim() === '') {
      i++;
      continue;
    }
    const start = i;
    let chars = 0;
    while (i < n && !keep[i] && i - start < CHUNK_LINES && chars < CHUNK_CHARS) {
      chars += lines[i]!.length + 1;
      i++;
    }
    candidates.push({ id: `c${candidates.length + 1}`, start, end: i, text: lines.slice(start, i).join('\n') });
  }
  return { lines, keep, candidates, outcome: detectOutcome(lines, isError) };
}

function describeGap(kinds: Map<string, number>): string {
  const parts = [...kinds.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${count} ${kind === 'other' ? 'other' : `'${kind}'`}`);
  const total = [...kinds.values()].reduce((s, c) => s + c, 0);
  return `[… ${total} line${total === 1 ? '' : 's'} omitted: ${parts.join(', ')} …]`;
}

export type TrimResult = {
  text: string;
  linesBefore: number;
  linesAfter: number;
  charsBefore: number;
  charsAfter: number;
  outcome: Outcome;
  jevChunks: number;
};

/**
 * Renders the kept lines (plus the Jev-approved chunks) with a header that
 * states the outcome, what was kept and where the full output is.
 */
export function renderTrim(
  plan: TrimPlan,
  options: { approved?: ReadonlySet<string>; fullPath?: string; settings: TrimSettings; originalChars: number },
): TrimResult {
  const keep = [...plan.keep];
  let jevChunks = 0;
  for (const chunk of plan.candidates) {
    if (!options.approved?.has(chunk.id)) continue;
    jevChunks++;
    for (let i = chunk.start; i < chunk.end; i++) keep[i] = true;
  }
  const build = (kept: boolean[]): string[] => {
    const out: string[] = [];
    let gap = new Map<string, number>();
    const flush = (): void => {
      if (gap.size > 0) out.push(describeGap(gap));
      gap = new Map();
    };
    let blank = false;
    plan.lines.forEach((line, i) => {
      if (kept[i]) {
        flush();
        if (line.trim() === '') {
          if (blank) return;
          blank = true;
        } else blank = false;
        out.push(line);
      } else if (line.trim() !== '') {
        const kind = noiseKind(line) ?? 'other';
        gap.set(kind, (gap.get(kind) ?? 0) + 1);
      }
    });
    flush();
    return out;
  };
  let body = build(keep);
  // Over budget: shrink head and tail first; signal and summary lines stay.
  if (body.join('\n').length > options.settings.maxChars) {
    const n = plan.lines.length;
    const tight = keep.map((k, i) => {
      if (!k) return false;
      const line = plan.lines[i]!;
      const edge = i < 10 || i >= n - 40;
      return edge || SUMMARY.test(line) || SIGNAL.test(line) || (options.approved !== undefined && plan.candidates.some((c) => options.approved!.has(c.id) && i >= c.start && i < c.end));
    });
    body = build(tight);
  }
  const keptText = body.join('\n');
  const header = [
    `[jev-governor trimmed this output: ${plan.lines.length} → ${body.length} lines (${options.originalChars} → ${keptText.length} chars).`,
    `Outcome: ${plan.outcome.detail}.`,
    `Kept: the outcome and summary lines, every error/warning/failure line with ±${options.settings.contextLines} lines of context, the first and last lines${jevChunks > 0 ? `, and ${jevChunks} more part(s) judged relevant to the task` : ''}; repetitive progress lines are counted, not shown.`,
    options.fullPath
      ? `The outcome and every error above are complete; you normally need nothing more. Only if a specific omitted part is truly required, search ${options.fullPath} for those lines with grep (do not read it whole, do not re-run the command for it).]`
      : 'The full output was not saved; re-run the command only if a specific omitted part is truly required.]',
  ].join(' ');
  const text = `${header}\n${keptText}`;
  return {
    text,
    linesBefore: plan.lines.length,
    linesAfter: body.length,
    charsBefore: options.originalChars,
    charsAfter: text.length,
    outcome: plan.outcome,
    jevChunks,
  };
}

/** One Noul per candidate chunk: is it still needed for the task? */
export function chunkQuestions(chunks: readonly Chunk[]): Record<string, { type: 'noul'; instructions: string }> {
  const questions: Record<string, { type: 'noul'; instructions: string }> = {};
  for (const chunk of chunks) {
    questions[`need_${chunk.id}`] = {
      type: 'noul',
      instructions: `Chunk ${chunk.id} of omitted_chunks holds information the assistant still needs for \`task\` that kept_output does not already show: a specific error or failing assertion with its values, a stack frame or path in the project's own code, or a value the command was run to obtain. Routine progress, passing checks and repeated content do not count.`,
    };
  }
  return questions;
}
