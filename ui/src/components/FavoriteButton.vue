<script setup lang="ts">
// The star that adds a project or a command to «Избранное».
import { computed } from 'vue';

import { t } from '../i18n/index.ts';

const props = defineProps<{ active: boolean; what: 'project' | 'command' }>();
const emit = defineEmits<{ toggle: [] }>();

const label = computed(() => {
  if (props.what === 'project') return props.active ? t('Remove project from favorites') : t('Add project to favorites');
  return props.active ? t('Remove command from favorites') : t('Add command to favorites');
});
</script>

<template>
  <button
    type="button"
    class="btn btn-sm px-1.5"
    :class="active ? 'border-amber-400 text-amber-600 dark:border-amber-500 dark:text-amber-400' : ''"
    :aria-pressed="active"
    :aria-label="label"
    :title="active ? t('Remove from favorites') : t('Add to favorites')"
    @click.prevent.stop="emit('toggle')"
  >
    <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">
      <path
        d="M8 1.8l1.85 3.86 4.23.55-3.1 2.93.78 4.2L8 11.3l-3.76 2.04.78-4.2-3.1-2.93 4.23-.55z"
        :fill="active ? 'currentColor' : 'none'"
      />
    </svg>
  </button>
</template>
