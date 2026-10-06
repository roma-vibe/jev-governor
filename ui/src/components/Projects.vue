<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { api, notify, type ProjectSummary } from '../api.ts';
import { fmtAgo, midTruncate } from '../format.ts';
import { t } from '../i18n/index.ts';
import { segments } from '../router.ts';
import { store } from '../store.ts';
import FavoriteButton from './FavoriteButton.vue';
import ProjectPage from './ProjectPage.vue';

const projects = ref<ProjectSummary[]>([]);
const loaded = ref(false);
const search = ref('');
const showWorktrees = ref(false);
const onlyFavorites = ref(false);
let touched = false;

const projectId = computed(() => segments.value[1]);

async function load(): Promise<void> {
  try {
    projects.value = await api.projects();
    loaded.value = true;
  } catch {
    // shown as a toast
  }
}

onMounted(() => {
  void load();
});
// The list is reloaded when coming back from a project page (its command count changed).
watch(projectId, (id) => {
  if (!id) void load();
});

// The initial state of the toggle follows the setting until the person flips it.
watch(
  () => store.config?.projects.showWorktrees,
  (value) => {
    if (!touched && value !== undefined) showWorktrees.value = value;
  },
  { immediate: true },
);

function toggleWorktrees(event: Event): void {
  touched = true;
  showWorktrees.value = (event.target as HTMLInputElement).checked;
}

const visible = computed(() => {
  const q = search.value.trim().toLowerCase();
  return projects.value.filter(
    (p) =>
      (onlyFavorites.value ? p.favorite : showWorktrees.value || !p.isWorktree) &&
      (!q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)),
  );
});

const favoriteCount = computed(() => projects.value.filter((p) => p.favorite).length);

const worktreeCount = computed(() => projects.value.filter((p) => p.isWorktree).length);

async function toggleFavorite(p: ProjectSummary): Promise<void> {
  try {
    p.favorite = (await api.setProjectFavorite(p.id, !p.favorite)).favorite;
    notify(p.favorite ? t('Project added to favorites') : t('Project removed from favorites'));
  } catch {
    // shown as a toast
  }
}

const activity = (p: ProjectSummary): string => (p.lastActivity ? t('activity: {ago}', { ago: fmtAgo(p.lastActivity) }) : t('no activity'));
</script>

<template>
  <ProjectPage v-if="projectId" :id="projectId" />

  <div v-else class="space-y-4">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div class="inline-flex rounded-lg border border-zinc-200 p-0.5 text-sm dark:border-zinc-800" role="group" :aria-label="t('Which projects to show')">
        <button
          type="button"
          class="rounded-md px-3 py-1"
          :class="!onlyFavorites ? 'bg-zinc-100 font-medium dark:bg-zinc-800' : 'text-zinc-500 dark:text-zinc-400'"
          :aria-pressed="!onlyFavorites"
          @click="onlyFavorites = false"
        >
          {{ t('All') }}
        </button>
        <button
          type="button"
          class="rounded-md px-3 py-1"
          :class="onlyFavorites ? 'bg-zinc-100 font-medium dark:bg-zinc-800' : 'text-zinc-500 dark:text-zinc-400'"
          :aria-pressed="onlyFavorites"
          @click="onlyFavorites = true"
        >
          {{ t('Favorites') }}<span v-if="favoriteCount" class="ml-1 tabular-nums text-zinc-500 dark:text-zinc-400">{{ favoriteCount }}</span>
        </button>
      </div>
      <input
        v-model="search"
        type="search"
        class="input max-w-xs"
        :placeholder="t('Search by name or path')"
        :aria-label="t('Search projects')"
        autocomplete="off"
        spellcheck="false"
      />
      <label v-if="!onlyFavorites" class="flex items-center gap-2 text-sm">
        <input type="checkbox" class="size-4 accent-indigo-600" :checked="showWorktrees" @change="toggleWorktrees" />
        {{ t('Show worktrees') }}
        <span v-if="worktreeCount" class="text-xs text-zinc-500 dark:text-zinc-400">({{ worktreeCount }})</span>
      </label>
      <span v-if="loaded" class="text-sm text-zinc-500 dark:text-zinc-400">{{ t('Projects: {n}', { n: visible.length }) }}</span>
    </div>

    <p v-if="!loaded" class="text-sm text-zinc-500">{{ t('Loading…') }}</p>

    <div v-else-if="projects.length === 0" class="card text-sm text-zinc-600 dark:text-zinc-300">
      <p class="font-medium">{{ t('No projects yet.') }}</p>
      <p class="mt-1">
        {{ t('Projects are taken from the Claude Code session history (the folder') }}
        <code class="mono">~/.claude/projects</code>{{
          t('): start Claude Code in your project folder and it will appear here. Project folders are only read: the server writes nothing to them.')
        }}
      </p>
    </div>

    <p v-else-if="onlyFavorites && favoriteCount === 0" class="card text-sm text-zinc-600 dark:text-zinc-300">
      {{ t('No favorite projects yet. Star a project on its card or page.') }}
    </p>

    <p v-else-if="visible.length === 0" class="card text-sm text-zinc-600 dark:text-zinc-300">
      {{ t('Nothing found')
      }}<template v-if="!showWorktrees && worktreeCount">{{ t('; worktrees are hidden: turn on “Show worktrees”') }}</template>.
    </p>

    <ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <li v-for="p in visible" :key="p.id">
        <a
          :href="`#/projects/${encodeURIComponent(p.id)}`"
          class="card block h-full transition hover:border-indigo-400 focus-visible:ring-2 focus-visible:ring-indigo-500/40 focus-visible:outline-none dark:hover:border-indigo-500"
          :class="p.exists ? '' : 'opacity-60'"
        >
          <div class="flex flex-wrap items-center gap-1.5">
            <h3 class="min-w-0 truncate text-sm font-semibold" :title="p.name">{{ p.name }}</h3>
            <span v-if="p.isWorktree" class="badge badge-indigo">worktree</span>
            <span v-if="!p.exists" class="badge badge-amber">{{ t('folder not found') }}</span>
            <span class="ml-auto"><FavoriteButton :active="p.favorite" what="project" @toggle="toggleFavorite(p)" /></span>
          </div>
          <p class="mono mt-1 text-zinc-500 dark:text-zinc-400" :title="p.path">{{ midTruncate(p.path, 44) }}</p>
          <p class="mt-3 text-xs text-zinc-600 dark:text-zinc-300">{{ activity(p) }}</p>
          <p class="mt-0.5 text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
            {{ t('{n} {n#session|sessions}', { n: p.sessions }) }} ·
            <template v-if="p.scannedAt">
              {{ t('{n} {n#command|commands}', { n: p.commandCount }) }}
            </template>
            <template v-else>{{ t('commands not scanned yet') }}</template>
          </p>
        </a>
      </li>
    </ul>
  </div>
</template>
