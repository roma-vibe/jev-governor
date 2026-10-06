<script setup lang="ts">
import { computed } from 'vue';

import type { ProjectCommandRecord } from '../api.ts';
import { t } from '../i18n/index.ts';
import FavoriteButton from './FavoriteButton.vue';

const props = defineProps<{
  command: ProjectCommandRecord;
  /** A hidden command shows only «Показать». */
  hiddenRow?: boolean;
  /** The project folder is gone: nothing can run. */
  canRun: boolean;
}>();

const emit = defineEmits<{
  copy: [];
  run: [];
  pin: [];
  hide: [];
  edit: [];
  favorite: [];
}>();

const c = computed(() => props.command);

const sourceLabel = computed(() => {
  switch (c.value.source) {
    case 'Cargo.toml':
      return 'Cargo';
    case 'docs':
      return c.value.sourceDetail ?? 'docs';
    case 'claude':
      return `Claude ×${c.value.uses ?? c.value.successes ?? 1}`;
    case 'manual':
      return t('manual');
    default:
      return c.value.source;
  }
});

const sourceTitle = computed(() => {
  const detail = c.value.sourceDetail ? `${c.value.source} · ${c.value.sourceDetail}` : c.value.source;
  if (c.value.source === 'claude') return t('Claude ran this command; successful: {ok} of {uses}', { ok: c.value.successes ?? 0, uses: c.value.uses ?? 0 });
  if (c.value.source === 'manual') return t('Added manually');
  return t('Found in: {detail}', { detail });
});

/** Learned runs shown next to a discovered command's own source. */
const claudeRuns = computed(() => (c.value.source !== 'claude' && (c.value.uses ?? 0) > 0 ? (c.value.uses ?? 0) : 0));
</script>

<template>
  <li class="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:gap-3" :class="hiddenRow ? 'opacity-75' : ''">
    <div class="min-w-0 flex-1">
      <p v-if="c.description" class="text-sm">{{ c.description }}</p>
      <p v-else-if="c.hint" class="text-sm text-zinc-500 italic dark:text-zinc-400">
        {{ c.hint }}
        <span class="badge badge-gray align-middle not-italic" :title="t('No description yet: showing text from the project file')">{{ t('draft') }}</span>
      </p>
      <p v-else class="text-sm text-zinc-400 dark:text-zinc-500">—</p>

      <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <code class="mono min-w-0 break-all text-zinc-700 dark:text-zinc-300">{{ c.command }}</code>
        <span v-if="c.dir" class="badge badge-gray mono" :title="t('Runs in folder {dir}', { dir: c.dir })">{{ c.dir }}</span>
        <span class="badge" :class="c.source === 'claude' ? 'badge-indigo' : 'badge-gray'" :title="sourceTitle">{{ sourceLabel }}</span>
        <span
          v-if="claudeRuns"
          class="text-xs text-indigo-700 dark:text-indigo-300"
          :title="t('How many times Claude ran this command')"
        >
          Claude ×{{ claudeRuns }}
        </span>
        <span v-if="c.stale" class="badge badge-amber" :title="t('The scan did not find this command; it is kept because it is pinned or described manually')">
          {{ t('not found in scan') }}
        </span>
      </div>
    </div>

    <div class="flex shrink-0 flex-wrap items-center gap-1.5">
      <template v-if="hiddenRow">
        <button type="button" class="btn btn-sm" @click="emit('hide')">{{ t('Show') }}</button>
      </template>
      <template v-else>
        <button type="button" class="btn btn-sm" @click="emit('copy')">{{ t('Copy') }}</button>
        <button
          type="button"
          class="btn btn-sm"
          :disabled="!canRun"
          :title="canRun ? t('Opens a new Terminal.app window and runs the command') : t('Project folder not found')"
          @click="emit('run')"
        >
          ▶ {{ t('In terminal') }}
        </button>
        <FavoriteButton :active="c.favorite === true" what="command" @toggle="emit('favorite')" />
        <button
          type="button"
          class="btn btn-sm px-1.5"
          :class="c.pinned ? 'border-indigo-400 text-indigo-700 dark:border-indigo-500 dark:text-indigo-300' : ''"
          :aria-pressed="c.pinned === true"
          :aria-label="c.pinned ? t('Unpin') : t('Pin')"
          :title="c.pinned ? t('Unpin') : t('Pin to top of group')"
          @click="emit('pin')"
        >
          <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 2.5h8v11l-4-3-4 3z" :fill="c.pinned ? 'currentColor' : 'none'" />
          </svg>
        </button>
        <button type="button" class="btn btn-sm px-1.5" :aria-label="t('Hide')" :title="t('Hide command')" @click="emit('hide')">
          <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M1.5 8s2.3-4.5 6.5-4.5S14.5 8 14.5 8 12.2 12.5 8 12.5 1.5 8 1.5 8z" />
            <circle cx="8" cy="8" r="1.8" />
          </svg>
        </button>
        <button type="button" class="btn btn-sm px-1.5" :aria-label="t('Edit')" :title="t('Edit')" @click="emit('edit')">
          <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2.5 13.5l.7-3L10.6 3.1a1.4 1.4 0 012 2L5.2 12.5z" />
            <path d="M9.5 4.2l2.3 2.3" />
          </svg>
        </button>
      </template>
    </div>
  </li>
</template>
