<script setup lang="ts">
type Segment = { value: number; class: string; label: string };
defineProps<{ segments: Segment[]; height?: string }>();
</script>

<template>
  <div
    class="flex w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
    :class="height ?? 'h-2.5'"
    role="img"
    :aria-label="segments.map((s) => `${s.label}: ${s.value}`).join(', ')"
  >
    <div
      v-for="segment in segments.filter((s) => s.value > 0)"
      :key="segment.label"
      :class="segment.class"
      :style="{ flexGrow: segment.value, flexBasis: 0 }"
      :title="`${segment.label}: ${segment.value}`"
    />
  </div>
</template>
