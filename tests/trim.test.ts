import { describe, expect, it } from 'vitest';

import {
  commandSegments,
  detectOutcome,
  isClaudeSavedOutput,
  isListingCommand,
  isLogCandidate,
  isRunnerCommand,
  isTestOrBuildCommand,
  LOG_KEY_LINES,
  looksSuccessful,
  persistedOutputPath,
  planTrim,
  renderTrim,
  shouldTrim,
  trimKind,
  worthTrimming,
  type TrimSettings,
} from '../hooks/lib/trim.ts';

const S: TrimSettings = { minChars: 6000, hugeChars: 40000, headLines: 30, tailLines: 100, contextLines: 3, maxChars: 16000 };

const compiling = Array.from({ length: 300 }, (_, i) => `   Compiling crate-${i} v0.${i}.0`);
const testsOk = Array.from({ length: 120 }, (_, i) => `test util::tests::case_${i} ... ok`);

const cargoPass = [
  ...compiling,
  '    Finished `test` profile [unoptimized + debuginfo] target(s) in 41.20s',
  '     Running unittests src/lib.rs (target/debug/deps/fastdev_core-1a2b3c)',
  '',
  'running 120 tests',
  ...testsOk,
  '',
  'test result: ok. 120 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.31s',
  '',
  '   Doc-tests fastdev_core',
  'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
].join('\n');

const cargoFail = [
  ...compiling,
  '     Running unittests src/lib.rs (target/debug/deps/fastdev_core-1a2b3c)',
  'running 121 tests',
  ...testsOk,
  'test envfile::tests::quoted_with_comment ... FAILED',
  '',
  'failures:',
  '',
  '---- envfile::tests::quoted_with_comment stdout ----',
  "thread 'envfile::tests::quoted_with_comment' panicked at crates/fastdev-core/src/envfile.rs:214:9:",
  'assertion `left == right` failed',
  '  left: "\\"${APP_NAME}\\""',
  ' right: "${APP_NAME}"',
  'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace',
  '',
  'failures:',
  '    envfile::tests::quoted_with_comment',
  '',
  'test result: FAILED. 120 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.40s',
  '',
  'error: test failed, to rerun pass `-p fastdev-core --lib`',
].join('\n');

describe('command kinds', () => {
  it('finds a run at the start of a segment only, not in file names or quotes', () => {
    // The 6 October file dumps: tool names inside file lists.
    expect(isRunnerCommand('cd files; for f in .editorconfig .prettierignore .prettierrc.json eslint.config.js; do echo "== $f"; cat $f; done')).toBe(false);
    expect(isRunnerCommand('cd files && for f in Dockerfile docker-compose.yml.tmpl _gitignore; do cat -n $f; done')).toBe(false);
    expect(isRunnerCommand('grep -n "make test" Makefile')).toBe(false);
    expect(isRunnerCommand('echo "npm test"; cat notes.md')).toBe(false);
    expect(isRunnerCommand('cat build.log | grep error')).toBe(false);
    expect(isRunnerCommand('cd crates && npm run test')).toBe(true);
    expect(isRunnerCommand('npm --prefix ui run build')).toBe(true);
    expect(isRunnerCommand('RUST_LOG=debug cargo test -p core 2>&1 | tail -60')).toBe(true);
    expect(isRunnerCommand('timeout 600 npx vitest run')).toBe(true);
    expect(isRunnerCommand('(cd app && make -j4)')).toBe(true);
    expect(isRunnerCommand('./gradlew assemble')).toBe(true);
    expect(isRunnerCommand('flutter build web')).toBe(true);
  });

  it('splits a shell line into simple commands, marking piped ones', () => {
    expect(commandSegments('cd a && FOO=1 time cargo test | tail -5; echo "a;b"')).toEqual([
      { head: 'cd a', piped: false },
      { head: 'cargo test', piped: false },
      { head: 'tail -5', piped: true },
      { head: 'echo Q', piped: false },
    ]);
  });

  it('a listing lists and filters, nothing else', () => {
    expect(isListingCommand('ls data; ls data/* -d; du -sh data/* | sort -h | tail -20')).toBe(true);
    expect(isListingCommand('cd repo && find . -path ./.git -prune -o -type f -print | sort')).toBe(true);
    expect(isListingCommand('ps aux | grep -E "train_" | grep -v grep')).toBe(true);
    expect(isListingCommand('find . -name "*.rs" | xargs cat')).toBe(false);
    expect(isListingCommand('find . -name "*.rs" -exec cat {} +')).toBe(false);
    expect(isListingCommand('ls src && cat src/main.rs')).toBe(false);
    expect(isListingCommand('cat files.txt | sort')).toBe(false);
  });

  it('trimKind: run from minChars, listing from listChars, anything from hugeChars', () => {
    const s = { ...S, listChars: 6000 };
    const rows = 'r\n'.repeat(4000);
    expect(trimKind('Bash', 'ls -la', rows, s)).toBe('list');
    expect(trimKind('Bash', 'ls -la', rows, { ...s, listChars: 0 })).toBeUndefined();
    expect(trimKind('Bash', 'cargo test', cargoPass, s)).toBe('run');
    expect(trimKind('Bash', 'cat big.log', 'x\n'.repeat(30000), s)).toBe('huge');
    expect(trimKind('Bash', 'sed -n 1,400p src/lib.rs', rows, s)).toBeUndefined();
  });

  it('worthTrimming wants at least 15% off', () => {
    expect(worthTrimming(10_000, 8_400)).toBe(true);
    expect(worthTrimming(10_000, 8_600)).toBe(false);
    expect(worthTrimming(8_049, 8_722)).toBe(false);
  });
});

describe('shouldTrim', () => {
  it('trims large runner output, never deliberate reads or file tools', () => {
    expect(shouldTrim('Bash', 'cargo test --offline -p fastdev-core', cargoPass, S)).toBe(true);
    expect(shouldTrim('Bash', 'cd crates && npm run test', cargoPass, S)).toBe(true);
    expect(shouldTrim('Bash', 'cat target/log.txt', cargoPass, S)).toBe(false);
    expect(shouldTrim('Bash', 'git diff HEAD', cargoPass, S)).toBe(false);
    expect(shouldTrim('Read', undefined, 'x'.repeat(100000), S)).toBe(false);
    expect(shouldTrim('Bash', 'cargo test', 'short output', S)).toBe(false);
  });

  it('trims any output once it is huge', () => {
    expect(shouldTrim('Bash', 'cat big.log', 'x\n'.repeat(30000), S)).toBe(true);
    expect(shouldTrim('mcp__srv__dump', undefined, 'x\n'.repeat(30000), S)).toBe(true);
  });
});

describe('outcome', () => {
  it('reads cargo, vitest and compile results', () => {
    expect(detectOutcome(cargoPass.split('\n'), false)).toEqual({
      status: 'passed',
      detail: 'tests passed (120 passed, 0 failed)',
    });
    const failed = detectOutcome(cargoFail.split('\n'), true);
    expect(failed.status).toBe('failed');
    expect(failed.detail).toContain('121 passed'.replace('121', '120'));
    expect(failed.detail).toContain('envfile::tests::quoted_with_comment');
    expect(detectOutcome([' Test Files  1 failed | 3 passed (4)', '      Tests  2 failed | 28 passed (30)'], true).detail).toContain(
      '28 passed, 2 failed',
    );
    expect(detectOutcome([' Tests  30 passed (30)'], false).status).toBe('passed');
    expect(
      detectOutcome(['error[E0425]: cannot find value `x` in this scope', 'error: could not compile `fastdev-core`'], true).status,
    ).toBe('build-error');
    expect(detectOutcome(['done'], true).status).toBe('error');
  });
});

describe('trim', () => {
  it('collapses a passing cargo run to a few lines and states the outcome', () => {
    const plan = planTrim(cargoPass, false, S);
    const out = renderTrim(plan, { settings: S, originalChars: cargoPass.length, fullPath: '/tmp/full.txt' });
    expect(out.charsAfter).toBeLessThan(cargoPass.length / 5);
    expect(out.text).toContain('Outcome: tests passed (120 passed, 0 failed).');
    expect(out.text).toContain('test result: ok. 120 passed');
    expect(out.text).toContain("'compile'");
    expect(out.text).toContain("'test ok'");
    expect(out.text).toContain('search /tmp/full.txt for those lines with grep');
    expect(out.text).toContain('do not read it whole');
    expect(out.text).not.toContain('Compiling crate-150');
  });

  it('keeps every line needed to understand a failure', () => {
    const plan = planTrim(cargoFail, true, S);
    const out = renderTrim(plan, { settings: S, originalChars: cargoFail.length });
    for (const needed of [
      'test envfile::tests::quoted_with_comment ... FAILED',
      "panicked at crates/fastdev-core/src/envfile.rs:214:9:",
      'assertion `left == right` failed',
      '  left: "\\"${APP_NAME}\\""',
      ' right: "${APP_NAME}"',
      'test result: FAILED. 120 passed; 1 failed',
      'error: test failed, to rerun pass `-p fastdev-core --lib`',
    ]) {
      expect(out.text).toContain(needed);
    }
    expect(out.text).toContain('Outcome: tests FAILED (120 passed, 1 failed)');
    expect(out.text).toContain('re-run the command only if');
  });

  it('collapses npm noise but keeps the totals', () => {
    const log = [
      ...Array.from({ length: 200 }, (_, i) => `npm warn deprecated pkg-${i}@1.0.0: no longer supported`),
      'added 450 packages, and audited 451 packages in 12s',
      'found 0 vulnerabilities',
    ].join('\n');
    const out = renderTrim(planTrim(log, false, S), { settings: S, originalChars: log.length });
    expect(out.text).toContain("200 'npm warn'");
    expect(out.text).toContain('found 0 vulnerabilities');
  });

  it('offers omitted real content to Jev and re-inserts approved chunks', () => {
    const middle = Array.from({ length: 200 }, (_, i) => `value[${i}] = ${i * 7}`);
    const log = ['start', ...Array.from({ length: 40 }, (_, i) => `step ${i}`), ...middle, ...Array.from({ length: 120 }, (_, i) => `tail ${i}`)].join('\n');
    const plan = planTrim(log, false, S);
    expect(plan.candidates.length).toBeGreaterThan(0);
    const target = plan.candidates.find((c) => c.text.includes('value[150]'))!;
    const out = renderTrim(plan, { settings: S, originalChars: log.length, approved: new Set([target.id]) });
    expect(out.text).toContain('value[150] = 1050');
    expect(out.jevChunks).toBe(1);
    expect(out.text).toContain("other");
  });

  it('shows only the last state of carriage-return progress lines', () => {
    const plan = planTrim('Downloading 10%\r50%\r100%\nresult: ok', false, S);
    expect(plan.lines[0]).toBe('100%');
  });
});

describe('Claude Code persisted output', () => {
  it('finds the saved file of a preview and nothing else', () => {
    const preview = '<persisted-output>\nOutput too large (1004.8KB). Full output saved to: /Users/r/.claude/projects/p/s/tool-results/x.txt\n\nPreview (first 2KB):\nline 1';
    expect(persistedOutputPath(preview)).toBe('/Users/r/.claude/projects/p/s/tool-results/x.txt');
    expect(persistedOutputPath('Full output saved to: /x')).toBeUndefined();
    const spaced = '<persisted-output>\nOutput too large (1.2MB). Full output saved to: /Users/John Smith/.claude/projects/p/s/tool-results/x.txt\n';
    expect(persistedOutputPath(spaced)).toBe('/Users/John Smith/.claude/projects/p/s/tool-results/x.txt');
  });

  it('reads a named file only in Claude Code\'s own tool-results folder', () => {
    expect(isClaudeSavedOutput('/Users/r/.claude/projects/p/s/tool-results/x.txt', '/Users/r')).toBe(true);
    expect(isClaudeSavedOutput('/Users/r/.ssh/id_ed25519', '/Users/r')).toBe(false);
    expect(isClaudeSavedOutput('/Users/r/.claude/projects/p/s/tool-results/../../../../.ssh/id_ed25519', '/Users/r')).toBe(false);
    expect(isClaudeSavedOutput('/Users/r/.claude/projects/p/s/notes.txt', '/Users/r')).toBe(false);
    expect(isClaudeSavedOutput('/etc/passwd', '')).toBe(false);
  });

  it('tells test and build runs from reads', () => {
    expect(isRunnerCommand('npm test 2>&1')).toBe(true);
    expect(isRunnerCommand('cargo build --release')).toBe(true);
    expect(isRunnerCommand('cat build.log')).toBe(false);
    expect(isRunnerCommand(undefined)).toBe(false);
  });

  it('offers to Jev as a possible log only what was not run to read or print data', () => {
    // Runs whose output may be a log.
    expect(isLogCandidate('git push -u origin main')).toBe(true);
    expect(isLogCandidate('./scripts/deploy.sh prod')).toBe(true);
    expect(isLogCandidate('docker compose up -d && docker compose logs --tail=200')).toBe(true);
    expect(isLogCandidate('cd app && echo "== start"; node server.js')).toBe(true);
    // Reads, inline scripts, queries, listings: what the assistant asked to see.
    expect(isLogCandidate('cat /tmp/dev.log')).toBe(false);
    expect(isLogCandidate('sed -n 1,200p src/main.ts')).toBe(false);
    expect(isLogCandidate('git diff HEAD~1')).toBe(false);
    expect(isLogCandidate("python3 -c 'import json; print(json.load(open(\"a.json\")))'")).toBe(false);
    expect(isLogCandidate("python3 - <<'EOF'\nprint(1)\nEOF")).toBe(false);
    expect(isLogCandidate('for f in a b; do cat $f; done')).toBe(false);
    expect(isLogCandidate('ls -la')).toBe(false);
    // Cut down through a pipe: the assistant already chose what to see.
    expect(isLogCandidate('node bench.js | tail -40')).toBe(false);
    expect(isLogCandidate('curl -s https://x | jq .items')).toBe(false);
    expect(isLogCandidate('cd x; mkdir -p y')).toBe(false);
    expect(isLogCandidate(undefined)).toBe(false);
  });

  it('cuts short only an unfiltered successful test or build run', () => {
    expect(isTestOrBuildCommand('npm test')).toBe(true);
    expect(isTestOrBuildCommand('cd crates && cargo test -p core')).toBe(true);
    expect(isTestOrBuildCommand('npm run build')).toBe(true);
    expect(isTestOrBuildCommand('npm run report')).toBe(false);
    expect(isTestOrBuildCommand('cargo run --example talk')).toBe(false);
    expect(isTestOrBuildCommand('npm test 2>&1 | tail -80')).toBe(false);
    const pass = ['', '> app@1.0.0 test', '> vitest run', '', ...Array.from({ length: 80 }, (_, i) => ` ✓ tests/case${i}.test.ts (4 tests) 3ms`), '', ' Test Files  80 passed (80)', '      Tests  320 passed (320)', '   Duration  1.2s'].join('\n');
    expect(looksSuccessful(pass)).toBe(true);
    expect(trimKind('Bash', 'npm test', pass, { ...S, briefChars: 2000 })).toBe('brief');
    expect(trimKind('Bash', 'npm test', pass, { ...S, briefChars: 2000 }, true)).toBeUndefined();
    expect(trimKind('Bash', 'npm test', pass, { ...S, briefChars: 0 })).toBeUndefined();
    // Exit 0 can hide a failure (`npm test; echo done`): its lines decide.
    const hidden = pass.replace(' ✓ tests/case3.test.ts (4 tests) 3ms', ' × tests/case3.test.ts > keeps totals\nAssertionError: expected 3 to be 4');
    expect(looksSuccessful(hidden)).toBe(false);
    expect(trimKind('Bash', 'npm test; echo done', hidden, { ...S, briefChars: 2000 })).toBeUndefined();
    expect(looksSuccessful('test result: ok. 12 passed; 0 failed; 0 ignored')).toBe(true);
  });

  it('a log keeps its key lines and collapses repeats that differ only in numbers', () => {
    const lines = [
      'Enumerating objects: 214, done.',
      ...Array.from({ length: 101 }, (_, i) => `Writing objects: ${i}% (${i}/150), ${i * 12} KiB | 2.1 MiB/s`),
      ...Array.from({ length: 40 }, (_, i) => `db-1 | LOG: checkpoint starting ${i}`),
      'api-1 | Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)',
      ...Array.from({ length: 40 }, (_, i) => `db-1 | LOG: checkpoint starting ${i + 40}`),
      'warning: something odd 1',
      'warning: something odd 2',
      'warning: something odd 3',
      'warning: something odd 4',
      'To github.com:me/app.git',
      ' * [new branch]      main -> main',
    ];
    const settings = { ...S, headLines: 10, tailLines: 30, contextLines: 2, maxChars: 5000, keepLines: LOG_KEY_LINES, collapseSimilar: true };
    const plan = planTrim(lines.join('\n'), false, settings);
    const out = renderTrim(plan, { settings, originalChars: lines.join('\n').length, fullPath: '/saved.txt', reason: 'Jev judged this output a log.' });
    expect(out.text).toContain('Jev judged this output a log.');
    expect(out.text).toContain('Uvicorn running on http://0.0.0.0:8000');
    expect(out.text).toContain('Writing objects: 0%');
    expect(out.text).toContain('Writing objects: 100%');
    expect(out.text).not.toContain('Writing objects: 50%');
    expect(out.text).toMatch(/repeats of the line before \(other numbers\)/);
    // Signal lines are never collapsed.
    for (let i = 1; i <= 4; i++) expect(out.text).toContain(`warning: something odd ${i}`);
    expect(out.text).toContain('[new branch]      main -> main');
    expect(out.charsAfter).toBeLessThan(lines.join('\n').length / 3);
  });
});
