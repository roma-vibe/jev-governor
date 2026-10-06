import { describe, expect, it } from 'vitest';

import { redactRequest } from '../hooks/lib/jev.ts';
import { looksRandom, redact, redactDeep, SECRET_MARK } from '../hooks/lib/redact.ts';

// Built from parts so this file does not itself look like it leaks keys.
const k = (...parts: string[]): string => parts.join('');

const SECRETS: Record<string, string> = {
  anthropic: k('sk-ant-api03-', 'Zx8Qp2Lm4Nv6Bc1Df3Gh5Jk7Lm9Qr0St2Uv4Wx6Yz8Ab'),
  openrouter: k('sk-or-v1-', '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a6978'),
  openai: k('sk-', 'proj-AbCdEf0123456789GhIjKlMnOpQrStUv'),
  github: k('ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
  githubPat: k('github_pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123'),
  slack: k('xoxb-', '123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'),
  aws: k('AKIA', 'IOSFODNN7EXAMPLE'),
  jwt: k('eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
};

describe('redact', () => {
  for (const [name, secret] of Object.entries(SECRETS)) {
    it(`catches a ${name} key`, () => {
      const r = redact(`curl -s https://api.example.com --data x # key ${secret} end`);
      expect(r.text).not.toContain(secret);
      expect(r.text).toContain(SECRET_MARK);
      expect(r.count).toBeGreaterThan(0);
    });
  }

  it('catches a private key block', () => {
    const pem = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ', '-----END OPENSSH PRIVATE KEY-----'].join('\n');
    const r = redact(`cat ~/.ssh/id_ed25519\n${pem}\nok`);
    expect(r.text).toBe(`cat ~/.ssh/id_ed25519\n${SECRET_MARK}\nok`);
  });

  it('catches .env assignments, inline env and quoted config values', () => {
    const env = redact('DATABASE_URL=postgres://app:hunter22@db:5432/app\nSTRIPE_SECRET_KEY=rk_live_51abc\nOPENROUTER_API_KEY="abc123def"\nDEBUG=1');
    expect(env.text).not.toContain('hunter22');
    expect(env.text).not.toContain('rk_live_51abc');
    expect(env.text).not.toContain('abc123def');
    expect(env.text).toContain('DEBUG=1');
    expect(redact('GITHUB_TOKEN=abc12345 gh pr list').text).toBe(`GITHUB_TOKEN=${SECRET_MARK} gh pr list`);
    expect(redact('{"apiKey": "my-very-private-value"}').text).toBe(`{"apiKey": "${SECRET_MARK}"}`);
    expect(redact("password: 'correct horse'").text).toBe(`password: '${SECRET_MARK}'`);
    expect(redact('mysql --password=s3cr3tpw -u root').text).toBe(`mysql --password=${SECRET_MARK} -u root`);
    expect(redact('Authorization: Bearer abcdefghijklmnop12345').text).toBe(`Authorization: Bearer ${SECRET_MARK}`);
  });

  it('catches quoted values inside JSON text (tool inputs reach Jev serialized)', () => {
    const cases: [unknown, string][] = [
      [{ command: 'export DB_PASSWORD="S3cr3tP@ss!" && run' }, 'S3cr3tP@ss!'],
      [{ command: "API_TOKEN='tok en 42' make deploy" }, 'tok en 42'],
      [{ file_path: 'config.json', content: '{"password": "hunter2xyz", "port": 5432}' }, 'hunter2xyz'],
      [{ command: 'mysql --password "pa ss word" -u root' }, 'pa ss word'],
    ];
    for (const [input, secret] of cases) {
      const r = redact(JSON.stringify(input));
      expect(r.text, r.text).not.toContain(secret);
      expect(r.count).toBeGreaterThan(0);
      // Still valid JSON, the rest intact.
      expect(() => JSON.parse(r.text)).not.toThrow();
    }
    const json = redact(JSON.stringify({ content: 'A_TOKEN=abc123xyz\nnext line' })).text;
    expect(JSON.parse(json)).toEqual({ content: `A_TOKEN=${SECRET_MARK}\nnext line` });
  });

  it('stays linear on a long unbroken run of name characters', () => {
    const run = 'a'.repeat(60_000);
    const t = performance.now();
    redact(`${run} token`);
    redact(`x=${'ab-'.repeat(20_000)}`);
    redact('a.'.repeat(30_000));
    expect(performance.now() - t).toBeLessThan(300);
  });

  it('catches a long random token without a known prefix', () => {
    const token = 'q8ZtR2vN5kLw0pXc7bHj3mYs9dFg1aQe6uTo4iUy';
    expect(redact(`export X=1; deploy --with ${token}`).text).not.toContain(token);
  });

  it('leaves git hashes, uuids, paths, identifiers and references alone', () => {
    const plain = [
      'git show 55b0e8c4f2a1d9e7b3c6a8f0d2e4b6c8a0e2f4d6',
      'sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      'session 68f3c4bd-72c6-459f-b0c0-d1d54a600849',
      'Read /Users/me/Documents/app/hooks/lib/compaction/state.ts',
      'npm run typecheck && npm test',
      'const estimateContextTokensFromTranscript = 1',
      'export OPENROUTER_API_KEY=$OPENROUTER_API_KEY',
      'API_KEY=${API_KEY:-}',
      'maxTokens=3500 input_tokens=12',
      'token: string;',
      'bypass=1',
      'it-is-a-very-long-kebab-case-identifier-for-tests-2024',
    ];
    for (const text of plain) expect(redact(text)).toEqual({ text, count: 0 });
  });

  it('looksRandom: entropy, not length alone', () => {
    expect(looksRandom('a'.repeat(40))).toBe(false);
    expect(looksRandom('abcdefabcdefabcdefabcdefabcdefabcdef12')).toBe(false);
    expect(looksRandom('Zx8Qp2Lm4Nv6Bc1Df3Gh5Jk7Lm9Qr0St2Uv4')).toBe(true);
  });

  it('redactDeep keeps keys and counts every replacement', () => {
    const secret = SECRETS.github!;
    const r = redactDeep({ a: [`x ${secret}`, 3, null], [`k`]: { nested: `y ${secret}` } });
    expect(r.count).toBe(2);
    expect(JSON.stringify(r.value)).not.toContain(secret);
    expect(Object.keys(r.value)).toEqual(['a', 'k']);
  });

  it('redactRequest keeps question names and choice keys', () => {
    const secret = SECRETS.anthropic!;
    const r = redactRequest(
      { recent: [`Bash(export KEY=${secret})`] },
      { agent: { type: 'choice', instructions: `pick for ${secret}`, criteria: { 'db-expert': 'databases', none: 'none' } } },
    );
    expect(r.count).toBe(2);
    expect(Object.keys(r.questions)).toEqual(['agent']);
    expect(Object.keys((r.questions.agent as { criteria: object }).criteria)).toEqual(['db-expert', 'none']);
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  it('leaves tool call ids alone: compaction questions name calls by them', () => {
    expect(redact('Tool call srvtoolu_011NQsnmKYmnJ2NA6sX434em (WebSearch)').count).toBe(0);
    expect(redact('Tool call toolu_01JzKqB8hXcV3n5Y6T7u8W9aBcDeFgHi (Bash)').count).toBe(0);
  });
});
