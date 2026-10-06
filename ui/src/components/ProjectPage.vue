<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';

import {
  api,
  ApiError,
  notify,
  type CommandInput,
  type CommandPatch,
  type ProjectCommandRecord,
  type ProjectView,
  type SavingsView,
} from '../api.ts';
import { copyText, fmtAgo, fmtMoney, fmtTime, fmtUsd, moneyTone } from '../format.ts';
import { commandLine, confirmRun, getGroups, type EditorResult } from '../groups.ts';
import { t } from '../i18n/index.ts';
import CommandEditor from './CommandEditor.vue';
import CommandRow from './CommandRow.vue';
import FavoriteButton from './FavoriteButton.vue';

const props = defineProps<{ id: string }>();

const view = ref<ProjectView | null>(null);
const savings = ref<SavingsView | null>(null);
/** null: no error; '' : the generic one (translated when shown). */
const failed = ref<string | null>(null);
const scanning = ref(false);
const busy = ref(false);
const editor = ref<{ command: ProjectCommandRecord | null } | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;

async function load(): Promise<void> {
  try {
    view.value = await api.project(props.id, true);
    failed.value = null;
  } catch (error) {
    if (!view.value) failed.value = error instanceof ApiError ? error.message : '';
  }
}

const SAVINGS_DAYS = 30;

async function loadSavings(): Promise<void> {
  const id = props.id;
  try {
    const next = await api.savings(SAVINGS_DAYS, id);
    if (id === props.id) savings.value = next;
  } catch {
    // the strip is optional: leave it out
  }
}

watch(
  () => props.id,
  () => {
    view.value = null;
    savings.value = null;
    failed.value = null;
    void load();
    void loadSavings();
  },
  { immediate: true },
);

// While the describing session works, pick up its answer.
watch(
  () => (view.value?.describe.enabled ? view.value.describe.status : 'idle'),
  (status) => {
    clearInterval(timer);
    timer = undefined;
    if (status === 'pending' || status === 'working') timer = setInterval(() => void load(), 5000);
  },
  { immediate: true },
);
onUnmounted(() => clearInterval(timer));

const project = computed(() => view.value?.project);
const commands = computed(() => project.value?.commands ?? []);
const hiddenCommands = computed(() => commands.value.filter((c) => c.hidden));
const groups = computed(() =>
  getGroups().map((g) => ({
    ...g,
    items: commands.value
      .filter((c) => !c.hidden && c.group === g.id)
      .sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true)),
  })).filter((g) => g.items.length > 0),
);
const favoriteCommands = computed(() => commands.value.filter((c) => c.favorite && !c.hidden));
const visibleCount = computed(() => commands.value.length - hiddenCommands.value.length);

const gitChanged = computed(() => {
  const n = view.value?.git?.changed;
  if (n === null || n === undefined) return '';
  return n === 0 ? t('clean') : t('{n} {n#changed file|changed files}', { n });
});

const tiles = computed(() => {
  const s = view.value?.stats;
  if (!s) return [];
  const seen = s.entries > 0;
  const dash = (v: string): string => (seen ? v : '—');
  const last = s.lastActivity ?? project.value?.lastActivity ?? null;
  return [
    {
      label: t('Sessions in {days} d', { days: s.days }),
      value: dash(String(s.sessions)),
      sub: t('total in history: {n}', { n: project.value?.sessions ?? 0 }),
    },
    {
      label: t('Sonnet / Opus turns'),
      value: dash(`${s.turns.sonnet} / ${s.turns.opus}`),
      sub: s.turns.shadow > 0 ? t('in shadow mode: {n}', { n: s.turns.shadow }) : seen ? t('applied decisions') : '',
    },
    {
      label: t('Subagents'),
      value: dash(String(s.subagents.count)),
      sub: s.subagents.shadow > 0 ? t('in shadow mode: {n}', { n: s.subagents.shadow }) : '',
    },
    { label: t('Jev cost'), value: dash(fmtUsd(s.jevCost)), sub: t('over {days} d', { days: s.days }) },
    { label: t('Last activity'), value: last ? fmtAgo(last) : '—', sub: last ? fmtTime(last) : '' },
  ];
});

/** The savings strip: the mod's gain in this project over the last 30 days. */
const savingsTiles = computed(() => {
  const totals = savings.value?.totals;
  if (!totals) return [];
  return [
    { label: t('Exact'), value: fmtMoney(totals.exact), tone: moneyTone(totals.exact) },
    { label: t('Plus estimated'), value: `≈ ${fmtMoney(totals.estimated)}`, tone: moneyTone(totals.estimated) },
    { label: 'Jev', value: fmtMoney(totals.jev), tone: '' },
    { label: t('Net gain'), value: fmtMoney(totals.net), tone: moneyTone(totals.net) },
  ];
});
const savingsEmpty = computed(() => !!savings.value && savings.value.totals.turns === 0 && savings.value.eventCount === 0);

// ---- helpers

function replaceCommand(oldId: string, next: ProjectCommandRecord): void {
  const list = view.value?.project.commands;
  if (!list) return;
  const i = list.findIndex((c) => c.id === oldId);
  if (i >= 0) list[i] = next;
  else list.push(next);
}

async function patch(c: ProjectCommandRecord, change: CommandPatch): Promise<boolean> {
  try {
    const { command } = await api.updateCommand(props.id, c.id, change);
    replaceCommand(c.id, command);
    return true;
  } catch {
    return false; // shown as a toast
  }
}

// ---- actions

async function copy(c: ProjectCommandRecord): Promise<void> {
  if (await copyText(commandLine(c))) notify(t('Copied'));
  else notify(t('Could not copy: allow clipboard access.'), 'error');
}

async function copyPath(): Promise<void> {
  if (project.value && (await copyText(project.value.path))) notify(t('Copied'));
  else notify(t('Could not copy.'), 'error');
}

async function run(c: ProjectCommandRecord): Promise<void> {
  if (!confirmRun(c)) return;
  try {
    await api.runCommand(props.id, c.id);
    notify(t('Started in Terminal.app'));
  } catch {
    // shown as a toast
  }
}

async function open(target: 'finder' | 'terminal'): Promise<void> {
  try {
    await api.openProject(props.id, target);
  } catch {
    // shown as a toast
  }
}

async function scan(): Promise<void> {
  scanning.value = true;
  try {
    view.value = await api.scanProject(props.id);
    notify(t('Commands updated.'));
  } catch {
    // shown as a toast
  } finally {
    scanning.value = false;
  }
}

const togglePin = (c: ProjectCommandRecord): Promise<boolean> => patch(c, { pinned: !c.pinned });
const toggleFavorite = (c: ProjectCommandRecord): Promise<boolean> => patch(c, { favorite: !c.favorite });

async function toggleProjectFavorite(): Promise<void> {
  const p = view.value?.project;
  if (!p) return;
  try {
    const { favorite } = await api.setProjectFavorite(props.id, !p.favorite);
    p.favorite = favorite;
    notify(favorite ? t('Project added to favorites') : t('Project removed from favorites'));
  } catch {
    // shown as a toast
  }
}
const setHidden = (c: ProjectCommandRecord, hidden: boolean): Promise<boolean> => patch(c, { hidden });

async function save(result: EditorResult): Promise<void> {
  const current = editor.value?.command ?? null;
  busy.value = true;
  try {
    if (current === null) {
      const input: CommandInput = { command: result.command, group: result.group };
      if (result.dir) input.dir = result.dir;
      if (result.description) input.description = result.description;
      const { command } = await api.addCommand(props.id, input);
      replaceCommand(command.id, command);
      notify(t('Command added.'));
    } else {
      const change: CommandPatch = {};
      if (result.group !== current.group) change.group = result.group;
      if (result.description !== (current.description ?? '')) change.description = result.description;
      if (current.source === 'manual') {
        if (result.command !== current.command) change.command = result.command;
        if (result.dir !== (current.dir ?? '')) change.dir = result.dir;
      }
      if (Object.keys(change).length > 0 && !(await patch(current, change))) return;
      notify(t('Saved.'));
    }
    editor.value = null;
  } catch {
    // shown as a toast: the editor stays open
  } finally {
    busy.value = false;
  }
}

async function removeManual(): Promise<void> {
  const current = editor.value?.command;
  if (!current || !window.confirm(t('Delete the command “{command}”?', { command: current.command }))) return;
  busy.value = true;
  try {
    await api.deleteCommand(props.id, current.id);
    const list = view.value?.project.commands;
    const i = list?.findIndex((c) => c.id === current.id) ?? -1;
    if (list && i >= 0) list.splice(i, 1);
    editor.value = null;
    notify(t('Command deleted.'));
  } catch {
    // shown as a toast
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="failed !== null" class="card space-y-2 text-sm">
    <p>{{ failed || t('Could not load the project.') }}</p>
    <a href="#/projects" class="text-indigo-700 hover:underline dark:text-indigo-300">{{ t('← Back to projects') }}</a>
  </div>
  <p v-else-if="!view || !project" class="text-sm text-zinc-500">{{ t('Loading…') }}</p>

  <div v-else class="space-y-4">
    <a href="#/projects" class="inline-block text-sm text-indigo-700 hover:underline dark:text-indigo-300">{{ t('← Projects') }}</a>

    <section class="card">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="min-w-0 text-lg font-semibold break-words">{{ project.name }}</h2>
        <FavoriteButton :active="project.favorite === true" what="project" @toggle="toggleProjectFavorite" />
        <span v-if="project.isWorktree" class="badge badge-indigo">worktree</span>
        <span v-if="!project.exists" class="badge badge-amber">{{ t('folder not found') }}</span>
      </div>
      <p class="mono mt-1 break-all text-zinc-500 dark:text-zinc-400">{{ project.path }}</p>

      <div class="mt-3 flex flex-wrap gap-2">
        <button type="button" class="btn btn-sm" @click="copyPath">{{ t('Copy path') }}</button>
        <button type="button" class="btn btn-sm" :disabled="!project.exists" @click="open('finder')">{{ t('Open in Finder') }}</button>
        <button type="button" class="btn btn-sm" :disabled="!project.exists" @click="open('terminal')">{{ t('Terminal here') }}</button>
        <button type="button" class="btn btn-sm btn-primary" :disabled="!project.exists || scanning" @click="scan">
          {{ scanning ? t('Updating…') : t('Update commands') }}
        </button>
      </div>

      <p v-if="!project.exists" class="mt-3 text-sm text-amber-700 dark:text-amber-400">
        {{ t('This folder no longer exists on disk, so commands are not scanned or run. The session history is kept.') }}
      </p>
      <p v-else-if="view.git" class="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span v-if="view.git.branch">
          <span class="text-zinc-500 dark:text-zinc-400">{{ t('branch') }}</span> <code class="mono">{{ view.git.branch }}</code>
        </span>
        <span v-if="gitChanged" :class="view.git.changed === 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'">
          {{ gitChanged }}
        </span>
        <span v-if="view.git.lastCommit" class="min-w-0 break-words" :title="view.git.lastCommit.subject">
          {{ view.git.lastCommit.subject }}
          <span class="text-zinc-500 dark:text-zinc-400">
            · {{ view.git.lastCommit.at ? fmtAgo(view.git.lastCommit.at) : view.git.lastCommit.ago }}
          </span>
        </span>
      </p>
      <p v-else class="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{{ t('Not a git repository.') }}</p>
    </section>

    <ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" :aria-label="t('Project statistics')">
      <li v-for="tile in tiles" :key="tile.label" class="card p-3!">
        <p class="text-xs text-zinc-500 dark:text-zinc-400">{{ tile.label }}</p>
        <p class="mt-1 text-lg font-semibold tabular-nums">{{ tile.value }}</p>
        <p v-if="tile.sub" class="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{{ tile.sub }}</p>
      </li>
    </ul>
    <p v-if="view.stats.entries === 0" class="-mt-2 text-xs text-zinc-500 dark:text-zinc-400">
      {{
        t(
          'The mod has not recorded any decisions for this project yet (last {days} d): sessions and costs will appear once Claude Code works here with the mod on.',
          { days: view.stats.days },
        )
      }}
    </p>

    <section v-if="savings" class="card" :aria-label="t('Project savings')">
      <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 class="card-title mb-0">{{ t('Savings over {days} d', { days: savings.days }) }}</h3>
        <a href="#/savings" class="text-xs text-indigo-700 hover:underline dark:text-indigo-300">{{ t('All projects →') }}</a>
      </div>
      <p v-if="savingsEmpty" class="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        {{ t('Nothing to count yet: the mod has not driven any turns in this project (shadow mode gives no savings).') }}
      </p>
      <ul v-else class="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <li v-for="tile in savingsTiles" :key="tile.label">
          <p class="text-xs text-zinc-500 dark:text-zinc-400">{{ tile.label }}</p>
          <p class="text-lg font-semibold tabular-nums" :class="tile.tone">{{ tile.value }}</p>
        </li>
      </ul>
    </section>

    <div
      v-if="view.describe.enabled && (view.describe.status === 'pending' || view.describe.status === 'working')"
      class="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm text-indigo-900 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-200"
      role="status"
    >
      {{ t('Command descriptions are being written by an open Claude Code session with the mod (usually within a minute).') }}
      <span v-if="view.describe.pendingCount" class="text-indigo-700 dark:text-indigo-300">
        {{ t('In progress: {n} {n#command|commands}.', { n: view.describe.pendingCount }) }}
      </span>
    </div>
    <div
      v-else-if="view.describe.enabled && view.describe.status === 'error'"
      class="flex flex-wrap items-center gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
      role="alert"
    >
      <span class="min-w-0 flex-1 break-words">{{ t('Could not get descriptions: {error}', { error: view.describe.error ?? '' }) }}</span>
      <button type="button" class="btn btn-sm" :disabled="scanning" @click="scan">{{ t('Retry') }}</button>
    </div>

    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <button type="button" class="btn btn-primary" @click="editor = { command: null }">{{ t('Add command') }}</button>
      <span class="text-sm text-zinc-500 dark:text-zinc-400">
        {{ t('{n} {n#command|commands}', { n: visibleCount }) }}
        <template v-if="view.stats.learnedCommands"> · {{ t('learned from Claude: {n}', { n: view.stats.learnedCommands }) }}</template>
        <template v-if="project.scannedAt"> · {{ t('updated {ago}', { ago: fmtAgo(project.scannedAt) }) }}</template>
      </span>
    </div>

    <p v-if="project.scannedAt === undefined && commands.length === 0" class="card text-sm text-zinc-600 dark:text-zinc-300">
      {{ t('Commands have not been scanned yet. Click “Update commands”.') }}
    </p>
    <p v-else-if="groups.length === 0 && favoriteCommands.length === 0" class="card text-sm text-zinc-600 dark:text-zinc-300">
      {{
        t(
          'No commands found in the project files (package.json, Makefile, Cargo.toml, justfile, README and others). Add the ones you need manually or wait until Claude runs something here.',
        )
      }}
    </p>

    <section v-if="favoriteCommands.length > 0" class="card border-amber-300 dark:border-amber-800" :aria-label="t('Favorite commands')">
      <h3 class="card-title">{{ t('Favorite commands') }} <span class="font-normal normal-case">· {{ favoriteCommands.length }}</span></h3>
      <ul class="divide-y divide-zinc-200 dark:divide-zinc-800">
        <CommandRow
          v-for="c in favoriteCommands"
          :key="c.id"
          :command="c"
          :can-run="project.exists"
          @copy="copy(c)"
          @run="run(c)"
          @pin="togglePin(c)"
          @favorite="toggleFavorite(c)"
          @hide="setHidden(c, true)"
          @edit="editor = { command: c }"
        />
      </ul>
    </section>

    <section v-for="g in groups" :key="g.id" class="card" :aria-label="g.title">
      <h3 class="card-title">{{ g.title }} <span class="font-normal normal-case">· {{ g.items.length }}</span></h3>
      <ul class="divide-y divide-zinc-200 dark:divide-zinc-800">
        <CommandRow
          v-for="c in g.items"
          :key="c.id"
          :command="c"
          :can-run="project.exists"
          @copy="copy(c)"
          @run="run(c)"
          @pin="togglePin(c)"
          @favorite="toggleFavorite(c)"
          @hide="setHidden(c, true)"
          @edit="editor = { command: c }"
        />
      </ul>
    </section>

    <details v-if="hiddenCommands.length > 0" class="card">
      <summary class="cursor-pointer text-sm font-medium">{{ t('Hidden commands ({n})', { n: hiddenCommands.length }) }}</summary>
      <ul class="mt-2 divide-y divide-zinc-200 dark:divide-zinc-800">
        <CommandRow
          v-for="c in hiddenCommands"
          :key="c.id"
          :command="c"
          hidden-row
          :can-run="project.exists"
          @hide="setHidden(c, false)"
        />
      </ul>
    </details>

    <CommandEditor
      v-if="editor"
      :key="editor.command?.id ?? 'new'"
      :command="editor.command"
      :busy="busy"
      :auto-describe="view.describe.enabled"
      @save="save"
      @remove="removeManual"
      @cancel="editor = null"
    />
  </div>
</template>
