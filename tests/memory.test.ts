import { describe, expect, it } from 'vitest';
import { criticQuestions, extractPrompt, keptByJev, parseCandidates, parseSessionNote, type Candidate } from '../hooks/lib/autosave.ts';
import { isMemoryTool, looksDown, memoryBlock, personalNotes, projectNotes, recallTask, sessionNotes, type Layers } from '../hooks/lib/memory.ts';
import { findProject, link, memoryIds, mentioned, mergeProjects, noteProject, readRegistry, relatedOf, syncMemories, unlink } from '../hooks/lib/memreg.ts';
import {
  chatTag,
  factType,
  kindFor,
  memoryName,
  mnema,
  MnemaError,
  namedProject,
  normalizeRemote,
  personalId,
  projectId,
  readMcpConfig,
  remoteFromGitConfig,
  sameFact,
  sanitize,
  sha1Hex,
  tagsFor,
  type MnemaFact,
} from '../hooks/lib/mnema.ts';

const fact = (id: string, text: string, tags: string[], more: Partial<MnemaFact> = {}): MnemaFact => ({
  id,
  text,
  kind: 'project',
  tags,
  status: 'active',
  pinned: false,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  ...more,
});

describe('memory ids (the same as the mnema-mcp server builds)', () => {
  it('hashes like sha1', () => {
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(sha1Hex('/work/app')).toBe('444ab9032ca47eded27d0fc9e20a79f3935830b6');
    expect(sha1Hex('абв/проект ü')).toBe('e6f088e459e73e6cd508abd6e9ec942850e79750');
    expect(sha1Hex('x'.repeat(200)).length).toBe(40);
  });

  it('names a project by its git remote, whatever the URL form', () => {
    for (const url of ['git@GitHub.com:Roma-Vibe/jev-governor.git', 'https://github.com/roma-vibe/jev-governor', 'https://token@github.com/roma-vibe/jev-governor.git/', 'ssh://git@github.com:22/roma-vibe/jev-governor.git']) {
      expect([url, normalizeRemote(url)]).toEqual([url, 'github.com/roma-vibe/jev-governor']);
    }
    expect(normalizeRemote('/local/path/repo.git')).toBeUndefined();
    expect(normalizeRemote('file:///srv/repo.git')).toBeUndefined();
    expect(projectId({ root: '/x/governor-src', remote: 'https://github.com/roma-vibe/jev-governor.git' })).toEqual({ id: 'repo.github.com.roma-vibe.jev-governor', source: 'remote' });
  });

  it('names a project without a remote by its folder and a hash of the path (as the stored memories are named)', () => {
    expect(projectId({ root: '/home/dev/projects/shop' })).toEqual({ id: 'repo.local.shop-95c6cc7c', source: 'local' });
    expect(projectId({ root: '/home/dev/projects/billing/' }).id).toBe('repo.local.billing-78b88745');
    expect(projectId({ root: '/a/My Project', named: 'shop' })).toEqual({ id: 'repo.shop', source: 'file' });
  });

  it('names the person by the login, and reads the names people use', () => {
    expect(personalId('anna')).toBe('dev.anna');
    expect(personalId('Anna K', 'kim')).toBe('dev.kim');
    expect(sanitize('  My Project!! ')).toBe('my-project');
    expect(memoryName('repo.github.com.roma-vibe.jev-governor')).toBe('jev-governor');
    expect(memoryName('repo.local.shop-95c6cc7c')).toBe('shop');
    expect(memoryName('dev.anna')).toBe('anna');
  });

  it('reads the files it needs', () => {
    expect(remoteFromGitConfig('[core]\n\tbare = false\n[remote "upstream"]\n\turl = a:b/c\n[remote "origin"]\n\turl = git@github.com:acme/app.git\n[branch "main"]\n\tremote = origin\n')).toBe('git@github.com:acme/app.git');
    expect(remoteFromGitConfig('[core]\n\tbare = false\n')).toBeUndefined();
    expect(namedProject('project = "shop"\n')).toBe('shop');
    expect(namedProject('base_url = "http://evil"\n')).toBeUndefined();
    expect(readMcpConfig('api_key = "mn_live_abc"\nbase_url = "http://127.0.0.1:8787"\n')).toEqual({ key: 'mn_live_abc', base: 'http://127.0.0.1:8787' });
    expect(readMcpConfig('')).toEqual({ key: undefined, base: undefined });
  });

  it('types a fact the way mnema-mcp does (the type is the first tag)', () => {
    expect(tagsFor('decision', ['auto', 'Auto', ' my tag '])).toEqual(['decision', 'auto', 'my-tag']);
    expect(kindFor('workflow')).toBe('preference');
    expect(kindFor('gotcha')).toBe('project');
    expect(factType(fact('1', 'x', ['auto', 'gotcha']))).toBe('gotcha');
    expect(factType(fact('1', 'x', ['misc']))).toBeUndefined();
    expect(chatTag('A7637EE6-232a-436b')).toBe('chat-a7637ee6232a');
    expect(sameFact('Mod tests run with npm test (vitest).', 'The mod tests run with npm test, vitest')).toBe(true);
    expect(sameFact('Payments retry through the queue', 'Ports never clash by design')).toBe(false);
  });
});

describe('the service over HTTP', () => {
  const calls: { url: string; method?: string; headers?: Record<string, string>; body?: string }[] = [];
  const api = (reply: (url: string) => { status: number; text: string }) =>
    mnema(
      async (url, init) => {
        calls.push({ url, ...init });
        const r = reply(url);
        return { status: r.status, ok: r.status < 300, text: r.text };
      },
      { base: 'http://127.0.0.1:8787/', key: 'k' },
    );

  it('asks with the key as a bearer and reads facts back', async () => {
    calls.length = 0;
    const m = api(() => ({ status: 200, text: JSON.stringify({ facts: [{ id: 'f1', text: 'A fact', tags: ['decision'], status: 'active', importance: { level: 'high' } }, { nope: 1 }], total: 1 }) }));
    const recalled = await m.recall('repo.x', 'the task');
    expect(recalled).toEqual([expect.objectContaining({ id: 'f1', text: 'A fact', tags: ['decision'], importance: { level: 'high' }, pinned: false })]);
    expect(calls[0]).toMatchObject({ url: 'http://127.0.0.1:8787/v1/users/repo.x/recall', method: 'POST' });
    expect(calls[0]!.headers!.authorization).toBe('Bearer k');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ message: 'the task', mode: 'economy', instructions: false });
    expect((await m.facts('dev.me', { limit: 10 })).total).toBe(1);
    expect(calls[1]!.url).toBe('http://127.0.0.1:8787/v1/users/dev.me/facts?status=active&limit=10&offset=0');
  });

  it('saves a fact with its type as the first tag, clipped to the service limit', async () => {
    calls.length = 0;
    const m = api(() => ({ status: 201, text: JSON.stringify({ id: 'n1', text: 'saved', tags: ['workflow', 'auto'] }) }));
    await m.addFact('repo.x', { text: `  ${'word '.repeat(100)}`, type: 'workflow', tags: ['auto'], importance: 'high' });
    const body = JSON.parse(calls[0]!.body!);
    expect(body).toMatchObject({ kind: 'preference', tags: ['workflow', 'auto'], importance: 'high', pinned: false });
    expect(body.text.length).toBeLessThanOrEqual(300);
  });

  it('says what the service said when it refuses', async () => {
    const m = api(() => ({ status: 401, text: JSON.stringify({ error: { message: 'bad key' } }) }));
    await expect(m.users()).rejects.toThrow('memory service 401: bad key');
    await expect(m.users()).rejects.toBeInstanceOf(MnemaError);
  });
});

describe('the notes a prompt gets', () => {
  const OPTS = { maxChars: 3_000, maxFacts: 14, withIds: false, hint: false };
  const layers = (over: Partial<Layers> = {}): Layers => ({ personal: [], project: [], projectName: 'app', sessions: [], related: [], ...over });

  it('puts the person first, then the project, the last chats and related projects', () => {
    const block = memoryBlock(
      layers({
        personal: [{ text: 'Answers in Russian.', type: 'preference', id: 'p1' }],
        project: [{ text: 'Payments retry through the queue.', type: 'decision', id: 'f1' }],
        sessions: [{ text: 'Moved the schedule into config; backoff is open.', date: '2026-11-01', id: 's1' }],
        related: [{ name: 'billing', notes: [{ text: 'Webhooks are signed with the vault key.', type: 'reference' }] }],
      }),
      OPTS,
    )!;
    expect(block).toMatchObject({ facts: 4, personal: 1, project: 1, sessions: 1, related: 1 });
    const order = ['About the user', '- [preference] Answers in Russian.', 'This project (app):', '- [decision] Payments retry', 'Earlier chats on this project', '- 2026-11-01: Moved the schedule', 'Related project billing', '- [reference] Webhooks'];
    let at = -1;
    for (const piece of order) {
      const next = block.text.indexOf(piece);
      expect([piece, next > at]).toEqual([piece, true]);
      at = next;
    }
    expect(block.text).not.toContain('(id ');
    expect(memoryBlock(layers({ project: [{ text: 'A fact.', id: 'f1' }] }), { ...OPTS, withIds: true })!.text).toContain('(id f1)');
  });

  it('says nothing when nothing was found, or one line for the main chat with the tools on', () => {
    expect(memoryBlock(layers(), OPTS)).toBeUndefined();
    const hinted = memoryBlock(layers(), { ...OPTS, hint: true })!;
    expect(hinted.facts).toBe(0);
    expect(hinted.text).toContain('Nothing relevant to this task is stored');
    expect(hinted.text).toContain('do not call recall');
  });

  it('keeps to the limits: the person cannot crowd the project out', () => {
    const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ text: `${prefix} fact number ${i} with some words in it.` }));
    const block = memoryBlock(layers({ personal: many(20, 'Personal'), project: many(20, 'Project') }), { ...OPTS, maxFacts: 10 })!;
    expect(block).toMatchObject({ facts: 10, personal: 5, project: 5 });
    const tight = memoryBlock(layers({ project: many(20, 'Project') }), { ...OPTS, maxChars: 500 })!;
    expect(tight.text.length).toBeLessThanOrEqual(500);
    expect(tight.facts).toBeGreaterThan(0);
  });

  it('picks the person\'s notes: what is marked important, then what the task brought up, then newer preferences', () => {
    const all = [
      fact('a', 'Old preference.', ['preference'], { updatedAt: '2026-10-01T00:00:00Z' }),
      fact('b', 'New preference.', ['preference'], { updatedAt: '2026-11-05T00:00:00Z' }),
      fact('c', 'Pinned rule.', ['preference'], { pinned: true }),
      fact('d', 'High context.', ['context'], { importance: { level: 'high' } }),
      fact('e', 'A gotcha about one codebase.', ['gotcha'], { importance: { level: 'high' } }),
      fact('f', 'A note of a chat.', ['context', 'session']),
      fact('g', 'Retired.', ['preference'], { status: 'superseded' }),
    ];
    const recalled = [all[4]!, all[0]!];
    // The gotcha about one codebase is not about the person, whatever the recall ranked it.
    expect(personalNotes(all, recalled, 10).map((n) => n.id)).toEqual(['c', 'd', 'a', 'b']);
    expect(personalNotes(all, recalled, 2).map((n) => n.id)).toEqual(['c', 'd']);
    expect(personalNotes(all, [], 0)).toEqual([]);
  });

  it('keeps the chats\' notes out of the project facts and shows the last ones apart, never this chat\'s own', () => {
    const all = [
      fact('1', 'A decision.', ['decision']),
      fact('2', 'Older chat.', ['context', 'session', 'chat-aaa'], { updatedAt: '2026-10-20T10:00:00Z' }),
      fact('3', 'Newer chat.', ['context', 'session', 'chat-bbb'], { updatedAt: '2026-11-02T10:00:00Z' }),
      fact('4', 'This chat.', ['context', 'session', 'chat-own'], { updatedAt: '2026-11-09T10:00:00Z' }),
    ];
    expect(projectNotes([...all, all[0]!]).map((n) => n.id)).toEqual(['1']);
    expect(sessionNotes(all, 'chat-own', 3)).toEqual([
      { text: 'Newer chat.', type: 'context', id: '3', date: '2026-11-02' },
      { text: 'Older chat.', type: 'context', id: '2', date: '2026-10-20' },
    ]);
  });

  it('asks about a real task only, and knows the memory server\'s tools and a service that is down', () => {
    expect(recallTask('да')).toBeUndefined();
    expect(recallTask('почини падающий тест ```code``` в модуле оплаты')).toBe('почини падающий тест в модуле оплаты');
    expect(isMemoryTool('mcp__mnema-memory__recall', 'mnema-memory')).toBe(true);
    expect(isMemoryTool('mcp__mnema_memory__save_fact', 'mnema-memory')).toBe(true);
    expect(isMemoryTool('mcp__other__recall', 'mnema-memory')).toBe(false);
    expect(looksDown('fetch failed: connect ECONNREFUSED 127.0.0.1:8787')).toBe(true);
    expect(looksDown('timeout after 4000 ms')).toBe(true);
    expect(looksDown('memory service 400: text too long')).toBe(false);
  });
});

describe('the projects the memory knows', () => {
  const GH = 'repo.github.com.acme.app';
  const LOCAL = 'repo.local.app-444ab903';

  it('keeps a folder\'s older memory as an alias when the project gets a remote', () => {
    const reg = readRegistry(undefined);
    expect(noteProject(reg, { id: LOCAL, root: '/work/app', at: 't1' })).toBe(true);
    expect(noteProject(reg, { id: LOCAL, root: '/work/app', at: 't1' })).toBe(false);
    noteProject(reg, { id: 'repo.github.com.acme.billing', root: '/work/billing', at: 't1' });
    link(reg, LOCAL, 'repo.github.com.acme.billing');
    noteProject(reg, { id: GH, root: '/work/app', at: 't2' });
    expect(reg.projects.map((p) => p.id)).toEqual(['repo.github.com.acme.billing', GH]);
    const app = findProject(reg, GH)!;
    expect(app).toMatchObject({ name: 'app', aliases: [LOCAL], roots: ['/work/app'], related: ['repo.github.com.acme.billing'] });
    expect(findProject(reg, LOCAL)).toBe(app);
    expect(memoryIds(reg, GH)).toEqual([GH, LOCAL]);
    // The other side of the relation follows the new id.
    expect(findProject(reg, 'repo.github.com.acme.billing')!.related).toEqual([GH]);
  });

  it('keeps the folder name beside the repository name', () => {
    const reg = readRegistry(undefined);
    noteProject(reg, { id: 'repo.github.com.roma-vibe.jev-governor', root: '/home/dev/governor-src', at: 't' });
    expect(reg.projects[0]).toMatchObject({ name: 'jev-governor', names: ['governor-src'] });
  });

  it('learns the service\'s memories, folding a local one into the project of the same name', () => {
    const reg = readRegistry(undefined);
    noteProject(reg, { id: 'repo.local.ledger-7a7aa100', root: '/home/dev/ledger', at: 't' });
    expect(syncMemories(reg, ['dev.anna', 'repo.github.com.acme.storefront', 'repo.local.storefront-1385e504', 'repo.local.ledger-7a7aa100', 'repo.local.mailer-61aae6bc'])).toBe(true);
    expect(reg.projects.map((p) => p.id).sort()).toEqual(['repo.github.com.acme.storefront', 'repo.local.ledger-7a7aa100', 'repo.local.mailer-61aae6bc']);
    expect(findProject(reg, 'repo.github.com.acme.storefront')!.aliases).toEqual(['repo.local.storefront-1385e504']);
    expect(syncMemories(reg, ['repo.github.com.acme.storefront', 'repo.local.storefront-1385e504'])).toBe(false);
  });

  it('spots another project named in a task, by repository or folder name, in any spelling', () => {
    const reg = readRegistry({
      projects: [
        { id: 'repo.github.com.roma-vibe.jev-governor', names: ['governor-src'] },
        { id: 'repo.github.com.acme.my-dev-shell' },
        { id: 'repo.github.com.acme.shopfront' },
        { id: 'repo.local.app-444ab903' },
      ],
    });
    const self = 'repo.github.com.acme.shopfront';
    const names = (text: string): string[] => mentioned(reg, text, self).map((p) => p.name);
    expect(names('сделай порты как в My Dev Shell и проверь governor src')).toEqual(['jev-governor', 'my-dev-shell']);
    expect(names('как в my_dev_shell?')).toEqual(['my-dev-shell']);
    expect(names('поправь shopfront и приложение app')).toEqual([]);
    expect(names('governor без префикса не считается')).toEqual([]);
  });

  it('relates, unrelates and merges projects', () => {
    const reg = readRegistry({ projects: [{ id: 'repo.a.x.one' }, { id: 'repo.a.x.two' }, { id: 'repo.local.one-00000000', roots: ['/r/one'] }] });
    expect(link(reg, 'repo.a.x.one', 'repo.a.x.two')).toBe(true);
    expect(link(reg, 'repo.a.x.one', 'repo.a.x.two')).toBe(false);
    expect(relatedOf(reg, 'repo.a.x.two').map((p) => p.id)).toEqual(['repo.a.x.one']);
    expect(mergeProjects(reg, 'repo.local.one-00000000', 'repo.a.x.one')).toBe(true);
    expect(findProject(reg, 'repo.a.x.one')).toMatchObject({ aliases: ['repo.local.one-00000000'], roots: ['/r/one'] });
    expect(unlink(reg, 'repo.a.x.one', 'repo.a.x.two')).toBe(true);
    expect(relatedOf(reg, 'repo.a.x.one')).toEqual([]);
    expect(readRegistry({ projects: [{ id: 'dev.me' }, { id: 5 }, 'x'] }).projects).toEqual([]);
  });
});

describe('what a chat saves', () => {
  const clean = (t: string): string => t;

  it('shows the model both layers, the other projects and the chat\'s note so far', () => {
    const built = extractPrompt({
      project: 'app',
      turns: [{ n: 1, user: 'почему состояние на чат?', answer: 'Потому что возобновлённый чат не должен терять план.', edited: [] } as never],
      known: [
        { id: 'p1', text: 'Answers in Russian.', scope: 'personal' },
        { id: 'f1', text: 'Payments retry through the queue.', scope: 'project' },
      ],
      projects: ['billing', 'app'],
      session: 'Settled the router state.',
      maxFacts: 3,
      clean,
    });
    expect(built.prompt).toContain('Project the conversation is in: app');
    expect(built.prompt).toContain('Other known projects: billing');
    expect(built.prompt).toContain('- (id p1) [personal] Answers in Russian.');
    expect(built.prompt).toContain("This chat's note so far");
    expect(built.used).toHaveLength(1);
  });

  it('reads a fact\'s layer and another project only by a name that was offered', () => {
    const reply = JSON.stringify({
      facts: [
        { text: 'The developer wants answers in Russian and no questions before committing.', type: 'preference', scope: 'personal', project: 'billing' },
        { text: 'The billing service signs webhooks with the key kept in the vault, not in env.', type: 'reference', scope: 'project', project: 'Billing' },
        { text: 'The mailer retries a failed send three times before it gives the message up.', type: 'gotcha', scope: 'project', project: 'mailer' },
      ],
    });
    const got = parseCandidates(reply, [], 5, clean, ['billing']);
    expect(got.map((c) => [c.scope, c.project])).toEqual([
      ['personal', undefined],
      ['project', 'billing'],
      ['project', undefined],
    ]);
  });

  it('reads the chat\'s note, clipped; none when empty, too short or holding a secret', () => {
    expect(parseSessionNote('{"facts":[],"session":"  The chat moved the retry schedule into config and left the backoff open. "}', clean)).toBe('The chat moved the retry schedule into config and left the backoff open.');
    expect(parseSessionNote('{"facts":[],"session":""}', clean)).toBeUndefined();
    expect(parseSessionNote('{"facts":[],"session":"too short"}', clean)).toBeUndefined();
    expect(parseSessionNote('{"facts":[]}', clean)).toBeUndefined();
    expect(parseSessionNote('not json', clean)).toBeUndefined();
    expect(parseSessionNote('{"session":"The chat rotated the key and wrote the new one down for later use."}', (t) => t.replace('key', '[secret]'))).toBeUndefined();
    const long = parseSessionNote(JSON.stringify({ session: 'word '.repeat(120) }), clean)!;
    expect(long.length).toBeLessThanOrEqual(290);
    expect(long.endsWith('…')).toBe(true);
  });

  it('lets Jev keep only the candidates it is sure of', () => {
    const candidates: Candidate[] = [
      { text: 'A project fact that is long enough to be one.', type: 'decision', scope: 'project', importance: 'normal' },
      { text: 'A personal fact that is long enough to be one.', type: 'preference', scope: 'personal', importance: 'normal' },
      { text: 'Another project fact that is long enough.', type: 'gotcha', scope: 'project', importance: 'normal' },
    ];
    const questions = criticQuestions(candidates);
    expect(Object.keys(questions)).toEqual(['fact_0', 'fact_1', 'fact_2']);
    expect(questions.fact_1!.instructions).toContain('about themselves');
    expect(questions.fact_0!.instructions).toContain('not session progress');
    expect(keptByJev(candidates, { fact_0: { noul: 0.9 }, fact_1: { noul: 0.59 } } as never, 0.6)).toEqual([candidates[0]]);
  });
});
