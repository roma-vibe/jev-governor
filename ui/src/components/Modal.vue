<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';

import { t } from '../i18n/index.ts';

defineProps<{ title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}

onMounted(() => {
  window.addEventListener('keydown', onKey);
  document.body.style.overflow = 'hidden';
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  document.body.style.overflow = '';
});
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/50 sm:p-6"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
    >
      <div
        class="flex min-h-full w-full flex-col bg-white shadow-xl sm:my-0 sm:min-h-0 sm:rounded-2xl dark:bg-zinc-900 dark:ring-1 dark:ring-zinc-800"
        :class="wide ? 'max-w-4xl' : 'max-w-xl'"
      >
        <header class="flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 class="text-base font-semibold">{{ title }}</h2>
          <button type="button" class="btn btn-sm" :aria-label="t('Close')" @click="emit('close')">✕</button>
        </header>
        <div class="flex-1 p-4 sm:p-5"><slot /></div>
        <footer
          v-if="$slots.footer"
          class="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200 bg-white px-4 py-3 sm:rounded-b-2xl dark:border-zinc-800 dark:bg-zinc-900"
        >
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>
