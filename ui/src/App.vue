<script setup lang="ts">
import { computed, onMounted } from 'vue';

import { connection } from './api.ts';
import Agents from './components/Agents.vue';
import Journal from './components/Journal.vue';
import Overview from './components/Overview.vue';
import Projects from './components/Projects.vue';
import Savings from './components/Savings.vue';
import Settings from './components/Settings.vue';
import Skills from './components/Skills.vue';
import Toasts from './components/Toasts.vue';
import { t } from './i18n/index.ts';
import { go, segments } from './router.ts';
import { refreshConfig, refreshKey, store, toggleEnabled } from './store.ts';

const tabs = [
  { id: 'overview', view: Overview },
  { id: 'savings', view: Savings },
  { id: 'projects', view: Projects },
  { id: 'settings', view: Settings },
  { id: 'agents', view: Agents },
  { id: 'skills', view: Skills },
  { id: 'journal', view: Journal },
] as const;

type TabId = (typeof tabs)[number]['id'];

function tabLabel(id: TabId): string {
  switch (id) {
    case 'overview':
      return t('Overview');
    case 'savings':
      return t('Savings');
    case 'projects':
      return t('Projects');
    case 'settings':
      return t('Settings');
    case 'agents':
      return t('Agents');
    case 'skills':
      return t('Skills');
    case 'journal':
      return t('Journal');
  }
}

/** The project panel is optional (projects.enabled). */
const shown = computed(() => tabs.filter((item) => item.id !== 'projects' || store.config?.projects.enabled !== false));
const tab = computed<TabId>(() => shown.value.find((item) => item.id === segments.value[0])?.id ?? 'overview');


const current = computed(() => tabs.find((item) => item.id === tab.value)!.view);

function select(id: TabId): void {
  go(`/${id}`);
}

const keyLabel = computed(() => {
  const key = store.key;
  if (!key) return '…';
  if (!key.found) return t('OpenRouter Key not found');
  return {
    env: t('OpenRouter Key: environment variable'),
    keyFile: t('OpenRouter Key: file'),
    pluginRoot: t('OpenRouter Key: project folder'),
  }[key.source ?? 'keyFile'];
});

onMounted(() => {
  void refreshConfig().catch(() => undefined);
  void refreshKey().catch(() => undefined);
});
</script>

<template>
  <div class="mx-auto max-w-6xl px-4 pb-24">
    <header class="flex flex-wrap items-center gap-x-4 gap-y-2 py-4">
      <h1 class="text-lg font-semibold tracking-tight">jev-governor</h1>
      <button
        type="button"
        class="badge text-sm"
        :class="store.config === null ? 'badge-gray' : store.config.enabled ? 'badge-green' : 'badge-red'"
        :disabled="store.config === null"
        :title="store.config?.enabled ? t('Click to turn the mod off') : t('Click to turn the mod on')"
        @click="toggleEnabled().catch(() => undefined)"
      >
        <span
          class="mr-1.5 inline-block size-2 rounded-full"
          :class="store.config?.enabled ? 'bg-emerald-500' : 'bg-red-500'"
        />
        {{ store.config === null ? '…' : store.config.enabled ? t('On') : t('Off') }}
      </button>
      <span
        v-if="store.config?.mode === 'shadow'"
        class="badge badge-amber"
        :title="t('The mod only records decisions and changes nothing')"
      >
        {{ t('shadow mode') }}
      </span>
      <a
        href="#/settings/basics"
        class="badge"
        :class="store.key?.found ? 'badge-gray' : 'badge-amber'"
        :title="store.key?.path ?? t('The OpenRouter key is set in Settings')"
        @click.prevent="go('/settings/basics')"
      >
        {{ keyLabel }}
      </a>
    </header>

    <nav
      class="-mx-4 mb-5 flex gap-1 overflow-x-auto border-b border-zinc-200 px-4 [scrollbar-width:none] dark:border-zinc-800"
      :aria-label="t('Sections')"
    >
      <button
        v-for="item in shown"
        :key="item.id"
        type="button"
        class="-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition"
        :class="
          tab === item.id
            ? 'border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300'
            : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
        "
        :aria-current="tab === item.id ? 'page' : undefined"
        @click="select(item.id)"
      >
        {{ tabLabel(item.id) }}
      </button>
    </nav>

    <div
      v-if="!connection.ok"
      class="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
    >
      {{ t('No connection to the server. Check that it is running:') }} <code class="mono">npm run ui</code>.
    </div>

    <main>
      <component :is="current" />
    </main>
    <Toasts />
  </div>
</template>
