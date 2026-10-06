import { describe, expect, it } from 'vitest';

import {
  cargoCommands,
  commandDir,
  commandId,
  dedupe,
  detectPackageManager,
  expandMembers,
  extractDocCommands,
  groupOf,
  normalizeObserved,
  parseDescriptions,
  parseJustfile,
  parseLaunchJson,
  parseMakefile,
  parsePackageJson,
  readCargoToml,
} from '../hooks/lib/commands.ts';

describe('discovery', () => {
  it('reads package.json scripts with the right package manager, skipping lifecycle hooks', () => {
    const pkg = JSON.stringify({ scripts: { dev: 'vite', build: 'vite build', test: 'vitest run', postinstall: 'x', 'db:migrate': 'prisma migrate dev' } });
    const npm = parsePackageJson(pkg, detectPackageManager(['package-lock.json']));
    expect(npm.map((c) => c.command)).toEqual(['npm install', 'npm run dev', 'npm run build', 'npm test', 'npm run db:migrate']);
    expect(npm.find((c) => c.command === 'npm run db:migrate')?.group).toBe('db');
    expect(parsePackageJson(pkg, detectPackageManager(['pnpm-lock.yaml']))[1]!.command).toBe('pnpm dev');
  });

  it('reads Makefile targets with ## and preceding comments', () => {
    const mk = ['.PHONY: dev test clean', '# Start the app', 'dev:', '\tnpm run dev', 'test: build ## Run all tests', '\tcargo test', 'clean:', '\trm -rf target', '%.o: %.c', '\tcc $<'].join('\n');
    const targets = parseMakefile(mk);
    expect(targets.map((c) => [c.command, c.hint])).toEqual([
      ['make dev', 'Start the app'],
      ['make test', 'Run all tests'],
      ['make clean', undefined],
    ]);
  });

  it('builds per-crate cargo commands for a workspace', () => {
    const ws = readCargoToml('[workspace]\nmembers = ["app", "crates/*"]\n');
    expect(expandMembers(ws.members, () => ['core', 'cli'])).toEqual(['app', 'crates/core', 'crates/cli']);
    const cmds = cargoCommands([{ name: 'core', hasBin: false }], { workspace: true }).map((c) => c.command);
    expect(cmds).toContain('cargo test -p core');
    expect(cmds).not.toContain('cargo build -p core');
    expect(readCargoToml('[package]\nname = "solo"\nversion = "0.1.0"\n').name).toBe('solo');
  });

  it('reads justfile recipes, launch.json servers and commands in docs', () => {
    expect(parseJustfile('# Serve docs\nserve port="3000":\n  mkdocs serve\n')[0]).toMatchObject({ command: 'just serve', hint: 'Serve docs' });
    expect(parseLaunchJson(JSON.stringify({ configurations: [{ name: 'web', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 5173 }] }))[0]).toMatchObject({
      command: 'npm run dev',
      hint: 'web on port 5173',
      group: 'run',
    });
    const md = '## Run and build\n\n```bash\n$ make dev   # app with hot reload\nexport API_TOKEN=abc\nls -la\n```\n\nTo build a release, run:\n\n```sh\ncargo build --release\n```\n';
    const docs = extractDocCommands(md, 'README.md');
    expect(docs.map((c) => [c.command, c.hint, c.group])).toEqual([
      ['make dev', 'app with hot reload', 'run'],
      ['cargo build --release', 'To build a release, run', 'build'],
    ]);
  });

  it('dedupes by command and directory, preferring a readable hint', () => {
    const merged = dedupe([
      { command: 'npm run dev', group: 'run', hint: 'vite', source: 'package.json' },
      { command: 'npm  run dev', group: 'run', hint: 'UI alone in a browser with the mock backend', source: 'docs' },
      { command: 'npm run dev', dir: 'web', group: 'run', source: 'package.json' },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.hint).toBe('UI alone in a browser with the mock backend');
    expect(commandId('npm run dev')).toBe(commandId('npm  run  dev'));
  });

  it('groups by name before body', () => {
    expect(groupOf('vite', 'dev')).toBe('run');
    expect(groupOf('cargo build --release')).toBe('build');
    expect(groupOf('wrangler deploy')).toBe('deploy');
  });
});

describe('learning from Claude', () => {
  it('strips output plumbing and a leading cd, keeps the dir', () => {
    expect(normalizeObserved('cargo test --offline -p fastdev-core 2>&1 | tail -40')).toEqual({ command: 'cargo test --offline -p fastdev-core' });
    expect(normalizeObserved('cd crates/mcp && cargo test 2>&1 | grep -E "test result"')).toEqual({ command: 'cargo test', dir: 'crates/mcp' });
  });

  it('places a command run from a subfolder relative to the project root', () => {
    expect(commandDir('/w/app', '/w/app')).toBe('');
    expect(commandDir('/w/app', '/w/app/client/src', 'game')).toBe('client/src/game');
    expect(commandDir('/w/app/', '/w/app', 'crates/mcp')).toBe('crates/mcp');
    expect(commandDir('/w/app', '/w/application')).toBeUndefined();
    expect(commandDir('/w/app', '/tmp/scratch')).toBeUndefined();
  });

  it('rejects exploration, compound commands, escapes from the project and secrets', () => {
    for (const c of ['git status', 'ls -la', 'cat README.md', 'cargo build && cargo test', 'cd /tmp && make', 'cd ../x && make', 'curl -H "Authorization: Bearer x" u', 'export GITHUB_TOKEN=1', 'echo $(date)']) {
      expect(normalizeObserved(c)).toBeUndefined();
    }
  });
});

describe('descriptions', () => {
  it('keeps only asked ids from the reply', () => {
    const got = parseDescriptions('Sure:\n{"a1":"Запускает приложение","zz":"x","b2":""}', new Set(['a1', 'b2']));
    expect(got).toEqual({ a1: 'Запускает приложение' });
  });
});
