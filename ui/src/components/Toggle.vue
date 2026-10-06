<script setup lang="ts">
defineProps<{ modelValue: boolean; disabled?: boolean; label?: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label"
    :disabled="disabled"
    class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition focus:ring-2 focus:ring-indigo-500/40 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
    :class="modelValue ? 'bg-indigo-600' : 'bg-zinc-300 dark:bg-zinc-700'"
    @click="emit('update:modelValue', !modelValue)"
  >
    <span
      class="inline-block size-5 rounded-full bg-white shadow transition-transform"
      :class="modelValue ? 'translate-x-5.5' : 'translate-x-0.5'"
    />
  </button>
</template>
