// Jev (TypeSafe System One) over a TypeSafe-compatible endpoint, OpenRouter's
// /api/v1/systemone by default. The transport is injected so this file stays
// free of the engine interface and can be unit-tested. Every request goes out
// with its secrets replaced (./redact.ts).

import { redactDeep } from './redact.ts';

export type NoulQuestion = { type: 'noul'; instructions: string };
export type ChoiceQuestion = {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
};
export type ScoreQuestion = { type: 'score'; instructions: string; criteria: string[] };
export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export type JevNoul = { type?: 'noul'; noul: number };
export type JevChoice = {
  type?: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};
export type JevScore = {
  type?: 'score';
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
};
export type JevAnswer = JevNoul | JevChoice | JevScore;

export type JevResponse = {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
};

export type HttpLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; ok: boolean; text: string }>;

/** What a hook needs to ask Jev: `ask(state, questions)`. */
export type JevAsker = {
  ask(state: string | object, questions: JevQuestions): Promise<JevResponse>;
};

export function buildJevBody(model: string, state: string | object, questions: JevQuestions): string {
  return JSON.stringify({ model, state, questions });
}

export function parseJevResponse(status: number, ok: boolean, text: string): JevResponse {
  if (!ok) throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    typeof (parsed as { answers: unknown }).answers !== 'object' ||
    (parsed as { answers: unknown }).answers === null
  ) {
    throw new Error('Jev response is missing answers');
  }
  return parsed as JevResponse;
}

/**
 * State and question texts with secrets replaced. Question names and choice
 * keys are left alone: Jev's answers are matched to them.
 */
export function redactRequest(
  state: string | object,
  questions: JevQuestions,
): { state: string | object; questions: JevQuestions; count: number } {
  const s = redactDeep(state);
  let count = s.count;
  const out: JevQuestions = {};
  for (const [name, question] of Object.entries(questions)) {
    const q = redactDeep(question);
    count += q.count;
    out[name] = q.value;
  }
  return { state: s.value, questions: out, count };
}

export function jevAsker(options: {
  http: HttpLike;
  endpoint: string;
  apiKey: string;
  model: string;
  /** Told how many secrets a request had replaced (only when there were any). */
  onRedacted?: (count: number) => void;
}): JevAsker {
  return {
    async ask(rawState, rawQuestions) {
      const { state, questions, count } = redactRequest(rawState, rawQuestions);
      if (count > 0) options.onRedacted?.(count);
      const response = await options.http(options.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
          'x-title': 'jev-governor',
        },
        body: buildJevBody(options.model, state, questions),
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function noul(answers: Record<string, JevAnswer>, name: string): number | undefined {
  const answer = answers[name] as Partial<JevNoul> | undefined;
  return answer && finite(answer.noul) ? Math.min(1, Math.max(0, answer.noul)) : undefined;
}

export function choice(
  answers: Record<string, JevAnswer>,
  name: string,
): JevChoice | undefined {
  const answer = answers[name] as Partial<JevChoice> | undefined;
  if (!answer || typeof answer.choice !== 'string' || typeof answer.probabilities !== 'object') {
    return undefined;
  }
  return {
    choice: answer.choice,
    confidence: finite(answer.confidence) ? answer.confidence : 0,
    probabilities: answer.probabilities ?? {},
  };
}

/**
 * A score answer as the expected level index (Σ i·p_i over the legend's
 * indices), with Jev's confidence; undefined when malformed.
 */
export function score(
  answers: Record<string, JevAnswer>,
  name: string,
): { expected: number; argmax: number; confidence: number } | undefined {
  const answer = answers[name] as Partial<JevScore> | undefined;
  if (!answer || !finite(answer.score)) return undefined;
  const probabilities = answer.probabilities ?? {};
  let total = 0;
  let weighted = 0;
  for (const [key, p] of Object.entries(probabilities)) {
    const index = Number(key);
    if (!Number.isInteger(index) || !finite(p)) continue;
    total += p;
    weighted += index * p;
  }
  const expected = total > 0 ? weighted / total : answer.score;
  return {
    expected,
    argmax: Math.round(answer.score),
    confidence: finite(answer.confidence) ? answer.confidence : 0,
  };
}

/** Rejects with `timeout` when `promise` has not settled within `ms`. */
export function withTimeout<T>(
  promise: Promise<T>,
  sleep: (ms: number) => Promise<void>,
  ms: number,
): Promise<T> {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`timeout after ${ms} ms`);
    }),
  ]);
}
