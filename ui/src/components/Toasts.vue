<script setup lang="ts">
import { dismiss, toasts } from '../api.ts';
import { t } from '../i18n/index.ts';
</script>

<template>
  <div class="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end">
    <div
      v-for="toast in toasts"
      :key="toast.id"
      role="status"
      class="pointer-events-auto flex max-w-md items-start gap-3 rounded-lg px-4 py-2.5 text-sm shadow-lg"
      :class="
        toast.kind === 'error'
          ? 'bg-red-600 text-white'
          : 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
      "
    >
      <span class="min-w-0 flex-1 break-words">{{ toast.message }}</span>
      <button type="button" class="opacity-70 hover:opacity-100" :aria-label="t('Close')" @click="dismiss(toast.id)">✕</button>
    </div>
  </div>
</template>
