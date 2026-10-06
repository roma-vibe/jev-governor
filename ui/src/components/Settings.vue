<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';

import { api, notify, type GovernorConfig } from '../api.ts';
import { t } from '../i18n/index.ts';
import { go, segments } from '../router.ts';
import { effortOptions, getGroups, getSections, type FieldDef } from '../settingsSchema.ts';
import { refreshKey, store } from '../store.ts';
import KeyBlock from './KeyBlock.vue';
import Toggle from './Toggle.vue';

const form = ref<GovernorConfig | null>(null);
/** Text of the list-like fields, kept apart so typing a comma or newline is not rewritten. */
const text = reactive<Record<string, string>>({});
const baseline = ref('');
const saving = ref(false);

/** Rebuilt when the language changes, so titles, labels and help follow it. */
const sections = computed(() => getSections());
const allFields = computed(() => sections.value.flatMap((s) => s.fields));

/** `#/settings` shows the tiles, `#/settings/<group>` the sections of one tile. */
const groups = computed(() => getGroups());
const group = computed(() => groups.value.find((g) => g.id === segments.value[1]));
const shown = computed(() => {
  const ids = group.value?.sectionIds ?? [];
  return ids.flatMap((id) => sections.value.filter((s) => s.id === id));
});
const countFields = (ids: string[]): number => sections.value.filter((s) => ids.includes(s.id)).reduce((n, s) => n + s.fields.length, 0);

function getAt(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}

function setAt(obj: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], obj) as Record<string, unknown>;
  target[last] = value;
}

function sync(config: GovernorConfig): void {
  const copy = JSON.parse(JSON.stringify(config)) as GovernorConfig;
  form.value = copy;
  baseline.value = JSON.stringify(copy);
  for (const field of allFields.value) {
    const value = getAt(copy, field.path);
    if (field.kind === 'list') text[field.path] = (value as string[]).join(', ');
    if (field.kind === 'lines') text[field.path] = (value as string[]).join('\n');
  }
}

const dirty = computed(() => form.value !== null && JSON.stringify(form.value) !== baseline.value);

onMounted(() => {
  void refreshKey().catch(() => undefined);
});

// Adopt config changes (header switch, first load) unless there are unsaved edits.
watch(
  () => store.config,
  (config) => {
    if (config && !dirty.value) sync(config);
  },
  { immediate: true },
);

function get(field: FieldDef): unknown {
  return getAt(form.value, field.path);
}

function set(field: FieldDef, value: unknown): void {
  setAt(form.value, field.path, value);
}

function onNumber(field: FieldDef, event: Event): void {
  const value = (event.target as HTMLInputElement).valueAsNumber;
  if (!Number.isNaN(value)) set(field, value);
}

function restoreNumber(field: FieldDef, event: Event): void {
  (event.target as HTMLInputElement).value = String(get(field));
}

function onList(field: FieldDef, event: Event): void {
  const raw = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  text[field.path] = raw;
  const separator = field.kind === 'lines' ? /\n/ : /,/;
  set(
    field,
    raw
      .split(separator)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

async function save(): Promise<void> {
  if (!form.value) return;
  saving.value = true;
  try {
    const previousPort = store.config?.ui.port;
    const saved = await api.saveConfig(form.value);
    store.config = saved;
    sync(saved);
    notify(t('Settings saved. The mod will pick them up on the next turn.'));
    if (previousPort !== undefined && previousPort !== saved.ui.port) {
      notify(t('Port {port} will take effect after the interface server restarts.', { port: saved.ui.port }));
    }
    void refreshKey().catch(() => undefined);
  } catch {
    // shown as a toast
  } finally {
    saving.value = false;
  }
}

async function reset(): Promise<void> {
  if (!window.confirm(t('Reset all settings to their defaults? The key and the agents are not affected.'))) return;
  try {
    const saved = await api.resetConfig();
    store.config = saved;
    sync(saved);
    notify(t('Settings reset to defaults.'));
    void refreshKey().catch(() => undefined);
  } catch {
    // shown as a toast
  }
}

function discard(): void {
  if (store.config) sync(store.config);
}

/** Options of a select; a value stored by hand that is not offered stays visible and selectable. */
function optionsOf(field: FieldDef): { value: string; label: string }[] {
  const options = field.kind === 'effort' ? effortOptions : (field.options ?? []);
  const current = get(field);
  return typeof current === 'string' && current !== '' && !options.some((o) => o.value === current)
    ? [{ value: current, label: current }, ...options]
    : options;
}

const stacked = (field: FieldDef): boolean => field.kind === 'text' || field.kind === 'list' || field.kind === 'lines';
</script>

<template>
  <div v-if="!form" class="text-sm text-zinc-500">{{ t('Loading…') }}</div>
  <form v-else class="space-y-5" novalidate @submit.prevent="save">
    <div v-if="!group" class="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <a
        v-for="(g, i) in groups"
        :key="g.id"
        :href="`#/settings/${g.id}`"
        class="card group flex aspect-square flex-col !p-5 transition hover:border-indigo-400 hover:shadow-md dark:hover:border-indigo-500"
        @click.prevent="go(`/settings/${g.id}`)"
      >
        <svg class="size-9 text-indigo-600 dark:text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <template v-if="i === 0"><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></template>
          <template v-else-if="i === 1"><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></template>
          <template v-else-if="i === 2"><path d="M12 3 3 8l9 5 9-5-9-5Z" /><path d="m3 13 9 5 9-5" /></template>
          <template v-else><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></template>
        </svg>
        <h2 class="mt-3 text-lg font-semibold">{{ g.title }}</h2>
        <p class="help mt-1">{{ g.description }}</p>
        <p class="mt-auto pt-3 text-xs text-zinc-500 dark:text-zinc-400">
          {{ t('{n} {n#section|sections}', { n: g.sectionIds.length }) }} ·
          {{ t('{n} {n#setting|settings}', { n: countFields(g.sectionIds) }) }}
        </p>
      </a>
    </div>

    <template v-else>
      <div class="flex flex-wrap items-baseline gap-x-3">
        <a href="#/settings" class="text-sm text-indigo-600 hover:underline dark:text-indigo-400" @click.prevent="go('/settings')">
          ← {{ t('Settings') }}
        </a>
        <h2 class="text-lg font-semibold">{{ group.title }}</h2>
      </div>
    <section v-for="section in shown" :id="`s-${section.id}`" :key="section.id" class="card">
      <h2 class="text-base font-semibold">{{ section.title }}</h2>
      <p v-if="section.intro" class="help mb-1">{{ section.intro }}</p>

      <div class="divide-y divide-zinc-200 dark:divide-zinc-800">
        <div
          v-for="field in section.fields"
          :key="field.path"
          class="py-3"
          :class="stacked(field) ? '' : 'md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,17rem)] md:items-start md:gap-6'"
        >
          <div>
            <label class="label" :for="`f-${field.path}`">{{ field.label }}</label>
            <p class="help">{{ field.help }}</p>
          </div>

          <div :class="stacked(field) ? 'mt-2' : 'mt-2 md:mt-0'">
            <Toggle
              v-if="field.kind === 'bool'"
              :model-value="get(field) as boolean"
              :disabled="field.disabled"
              :label="field.label"
              @update:model-value="set(field, $event)"
            />

            <div v-else-if="field.kind === 'number'" class="flex items-center gap-2">
              <input
                :id="`f-${field.path}`"
                type="number"
                class="input tabular-nums"
                :step="field.step"
                :min="field.min"
                :max="field.max"
                :value="get(field) as number"
                @input="onNumber(field, $event)"
                @blur="restoreNumber(field, $event)"
              />
              <span v-if="field.unit" class="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{{ field.unit }}</span>
            </div>

            <select
              v-else-if="field.kind === 'effort' || field.kind === 'select'"
              :id="`f-${field.path}`"
              class="input"
              :disabled="field.disabled"
              :value="get(field) as string"
              @change="set(field, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="o in optionsOf(field)" :key="o.value" :value="o.value">
                {{ o.label }}
              </option>
            </select>

            <input
              v-else-if="field.kind === 'text'"
              :id="`f-${field.path}`"
              type="text"
              class="input"
              :class="field.mono ? 'mono' : ''"
              :value="get(field) as string"
              :placeholder="field.placeholder"
              autocomplete="off"
              spellcheck="false"
              @input="set(field, ($event.target as HTMLInputElement).value)"
            />

            <input
              v-else-if="field.kind === 'list'"
              :id="`f-${field.path}`"
              type="text"
              class="input"
              :class="field.mono ? 'mono' : ''"
              :value="text[field.path]"
              :placeholder="field.placeholder"
              autocomplete="off"
              spellcheck="false"
              @input="onList(field, $event)"
            />

            <textarea
              v-else-if="field.kind === 'lines'"
              :id="`f-${field.path}`"
              class="input mono min-h-20"
              rows="3"
              :value="text[field.path]"
              :placeholder="field.placeholder"
              spellcheck="false"
              @input="onList(field, $event)"
            />
          </div>
        </div>
      </div>

      <KeyBlock v-if="section.id === 'jev'" />
    </section>
    </template>

    <div
      v-if="group || dirty"
      class="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-2 border-t border-zinc-200 bg-zinc-50/90 px-4 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90"
    >
      <button type="submit" class="btn btn-primary" :disabled="!dirty || saving">{{ t('Save') }}</button>
      <button type="button" class="btn" :disabled="!dirty || saving" @click="discard">{{ t('Discard changes') }}</button>
      <button type="button" class="btn btn-danger ml-auto" :disabled="saving" @click="reset">
        {{ t('Reset to defaults') }}
      </button>
      <span v-if="dirty" class="w-full text-xs text-amber-700 sm:w-auto dark:text-amber-400">{{ t('Unsaved changes') }}</span>
    </div>
  </form>
</template>
