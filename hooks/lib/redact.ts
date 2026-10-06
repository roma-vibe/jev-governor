// Secrets out of everything sent to Jev. Jev sees parts of the work: the
// recent conversation, tool inputs, trimmed output, the compaction history;
// a key that slipped into a command or its output would go to OpenRouter and
// Jev's provider with it. Every request passes through `redactDeep` (in
// jevAsker), which replaces what looks like a secret with `[secret]`. Pure.
//
// Caught: known key formats, private key blocks, JWTs, bearer tokens,
// credentials in URLs, `NAME_TOKEN=value` assignments (.env, inline env),
// quoted values of secret-named keys, `--password value` flags, and long
// high-entropy strings. Not caught on purpose: pure hex (git hashes, digests)
// and UUIDs, paths, identifiers.

export const SECRET_MARK = '[secret]';

/** Names that hold a secret (the `SECRET` pattern of commands.ts, as a name). */
const SECRET_NAME = 'token|secret|passw(?:or)?d|passphrase|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|auth[_-]?key';

/**
 * A quoted value. Tool inputs reach Jev as JSON text, where the quotes of
 * `PASSWORD="…"` arrive as `\"`: those count as quotes too. A `\n` escape ends it.
 */
const QUOTED = String.raw`\\?"(?:[^"\\\n]|\\(?![n"]))*\\?"|\\?'(?:[^'\\\n]|\\(?![n']))*\\?'`;
/** An unquoted value; a backslash ends it (a JSON escape, or the `\"` of a quoted one). */
const BARE = String.raw`[^\s"'$\\][^\s"'\\]*`;

type Rule = { re: RegExp; replace: string | ((match: string, ...groups: string[]) => string) };

const RULES: Rule[] = [
  // PEM private key blocks (an unterminated one up to the end of the text).
  {
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replace: SECRET_MARK,
  },
  // Anthropic, OpenRouter, OpenAI and similar `sk-` keys.
  { re: /\bsk-(?:ant-|or-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, replace: SECRET_MARK },
  // GitHub tokens.
  { re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, replace: SECRET_MARK },
  // Slack tokens.
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: SECRET_MARK },
  // AWS access key ids.
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: SECRET_MARK },
  // Google API keys.
  { re: /\bAIza[0-9A-Za-z_-]{30,}/g, replace: SECRET_MARK },
  // JWTs.
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: SECRET_MARK },
  // Authorization headers: `Bearer <token>`, `Basic <b64>`.
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{12,}=*/g, replace: (_m, kind) => `${kind} ${SECRET_MARK}` },
  // user:password@ in URLs. The scheme starts after a non-scheme character: with `\b`, a long
  // `a.b.c…` run was rescanned from every dot (quadratic).
  { re: /((?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, replace: (_m, head) => `${head}${SECRET_MARK}@` },
  // NAME_TOKEN=value: .env lines and inline env (`API_KEY=… npm run`); `$VAR` references stay.
  {
    re: new RegExp(String.raw`\b([A-Za-z0-9_]*(?:${SECRET_NAME}|PASS|PWD|AUTH)[A-Za-z0-9_]*)=(${QUOTED}|${BARE})`, 'gi'),
    // Short markers (PASS, PWD, AUTH) count only in UPPER_CASE names: `bypass=1` is not a secret.
    replace: (match, name, value) =>
      isPlaceholder(value) || (!/^[A-Z0-9_]+$/.test(name) && !SECRET_NAME_RE.test(name)) ? match : `${name}=${SECRET_MARK}`,
  },
  // "apiKey": "value", password: 'value', token = "value": quoted values of secret-named keys.
  {
    // The lookbehind starts a match only where a name can start: unanchored, a long run of
    // name characters was rescanned from every position (quadratic).
    re: new RegExp(
      String.raw`((?<![A-Za-z0-9_.-])\\?["']?[A-Za-z0-9_.-]*(?:${SECRET_NAME})[A-Za-z0-9_.-]*\\?["']?\s*[:=]\s*)(\\?["'])([^"'\n]{6,})\2`,
      'gi',
    ),
    replace: (match, head, quote, value) => (isPlaceholder(value) ? match : `${head}${quote}${SECRET_MARK}${quote}`),
  },
  // --password value, --token=value
  {
    re: new RegExp(String.raw`(--?(?:${SECRET_NAME})(?:=|\s+))(${QUOTED}|(?!-)${BARE})`, 'gi'),
    replace: (match, head, value) => (isPlaceholder(value) ? match : `${head}${SECRET_MARK}`),
  },
];

const SECRET_NAME_RE = new RegExp(`(?:${SECRET_NAME})`, 'i');

/** A value that names a secret rather than holding one: `$TOKEN`, `${…}`, `<your-key>`, `***`, `[secret]`. */
function isPlaceholder(value: string): boolean {
  const v = value.replace(/^\\?["']|\\?["']$/g, '').trim();
  return (
    v.length === 0 ||
    v.startsWith('$') ||
    v.startsWith('<') ||
    v.startsWith('{{') ||
    v.includes(SECRET_MARK) ||
    /^\d+(?:\.\d+)?$/.test(v) ||
    /^(?:\*+|x+|\.+|null|none|undefined|true|false|changeme|your[_-].*|process\.env\..*|env\(.*)$/i.test(v)
  );
}

/** Bits per character. */
function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const CANDIDATE = /[A-Za-z0-9+/_=-]{32,}/g;

/**
 * A long token that reads like random key material: letters and digits mixed,
 * high entropy. Pure hex (git hashes, sha256), UUIDs, paths and word-like
 * identifiers (kebab, snake, camel case) are not.
 */
export function looksRandom(token: string): boolean {
  const core = token.replace(/=+$/, '');
  if (core.length < 32) return false;
  // Tool call ids (`toolu_…`, `srvtoolu_…`): Jev's compaction questions name calls by them.
  if (/^(?:srv)?toolu_[A-Za-z0-9]+$/.test(core)) return false;
  if (/^[0-9a-f-]+$/i.test(core)) return false;
  if (core.includes('/') && /\/[A-Za-z]/.test(core) && core.split('/').every((part) => part.length < 32)) return false;
  if (!/[0-9]/.test(core) || !/[A-Za-z]/.test(core)) return false;
  // Word-like: mostly runs of letters separated by - or _ (identifiers, slugs).
  const words = core.split(/[-_]/);
  if (words.length >= 3 && words.every((w) => /^[A-Za-z]*\d{0,4}$/.test(w))) return false;
  const upper = /[A-Z]/.test(core);
  const lower = /[a-z]/.test(core);
  const threshold = upper && lower ? 4.2 : 3.9;
  return entropy(core) >= threshold;
}

/** Replaces what looks like a secret with `[secret]`; `count` is how many were replaced. */
export function redact(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, (...args: unknown[]) => {
      const match = args[0] as string;
      const groups = args.slice(1, -2) as string[];
      const replaced = typeof rule.replace === 'string' ? rule.replace : rule.replace(match, ...groups);
      if (replaced !== match) count++;
      return replaced;
    });
  }
  out = out.replace(CANDIDATE, (token) => {
    if (!looksRandom(token)) return token;
    count++;
    return SECRET_MARK;
  });
  return { text: out, count };
}

/** `redact` over every string of a JSON-like value; object keys are left alone. */
export function redactDeep<T>(value: T): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redact(v);
      count += r.count;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  const out = walk(value) as T;
  return { value: out, count };
}
