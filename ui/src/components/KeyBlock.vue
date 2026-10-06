<script setup lang="ts">
import { computed, ref } from 'vue';

import { api, notify, type JevTest } from '../api.ts';
import { fmtUsd } from '../format.ts';
import { t } from '../i18n/index.ts';
import { refreshKey, store } from '../store.ts';

const newKey = ref('');
const saving = ref(false);
const testing = ref(false);
const result = ref<JevTest | null>(null);

const source = computed(() => {
  const key = store.key;
  if (!key?.found) return '';
  if (key.source === 'env') return t('environment variable OPENROUTER_API_KEY');
  if (key.source === 'pluginRoot') return t('file in the project folder: {path}', { path: key.path ?? '' });
  return t('file: {path}', { path: key.path ?? '' });
});

const valid = computed(() => newKey.value.trim().startsWith('sk-or-') && newKey.value.trim().length > 12);

async function save(): Promise<void> {
  saving.value = true;
  try {
    const saved = await api.saveKey(newKey.value.trim());
    newKey.value = '';
    result.value = null;
    await refreshKey();
    if (saved.activeSource !== 'keyFile') {
      notify(t('Key saved to {path}, but the key from another source is currently in effect ({source}).', { path: saved.path, source: saved.activeSource ?? '' }));
    } else {
      notify(t('Key saved.'));
    }
  } catch {
    // shown as a toast
  } finally {
    saving.value = false;
  }
}

async function test(): Promise<void> {
  testing.value = true;
  result.value = null;
  try {
    result.value = await api.testJev();
  } catch {
    // shown as a toast
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <div class="mt-4 rounded-lg border border-zinc-200 p-3 sm:p-4 dark:border-zinc-800">
    <h4 class="mb-2 text-sm font-semibold">{{ t('OpenRouter key') }}</h4>

    <p v-if="!store.key" class="text-sm text-zinc-500">{{ t('Checking…') }}</p>
    <template v-else>
      <p class="flex flex-wrap items-center gap-2 text-sm">
        <span class="badge" :class="store.key.found ? 'badge-green' : 'badge-amber'">
          {{ store.key.found ? t('Key found') : t('Key not found') }}
        </span>
        <span v-if="store.key.found" class="mono min-w-0 break-all text-zinc-600 dark:text-zinc-400">{{ source }}</span>
      </p>
      <p v-if="!store.key.found" class="help">
        {{ t('Without a key Jev decides nothing, and the mod does not change Claude Code settings. Paste the key below.') }}
      </p>
    </template>

    <form class="mt-3 flex flex-col gap-2 sm:flex-row" @submit.prevent="save">
      <input
        v-model="newKey"
        type="password"
        class="input mono flex-1"
        autocomplete="off"
        spellcheck="false"
        placeholder="sk-or-…"
        :aria-label="t('New OpenRouter key')"
      />
      <button type="submit" class="btn btn-primary" :disabled="!valid || saving">{{ t('Save key') }}</button>
    </form>
    <p class="help">
      {{ t('The key is never shown in the interface. It will be saved to') }}
      <span class="mono break-all">{{ store.key?.keyFile ?? '…' }}</span> {{ t('with permissions for you only (0600).') }}
    </p>

    <div class="mt-3 flex flex-wrap items-center gap-3">
      <button type="button" class="btn" :disabled="testing" @click="test">
        {{ testing ? t('Checking…') : t('Test Jev') }}
      </button>
      <span v-if="result?.ok" class="text-sm text-emerald-700 dark:text-emerald-400">
        {{ t('Jev responds: {ms} ms, noul {noul}', { ms: result.ms, noul: result.noul.toFixed(2) })
        }}<template v-if="result.cost !== null">, {{ fmtUsd(result.cost) }}</template>
      </span>
      <span v-else-if="result" class="text-sm text-red-700 dark:text-red-400">{{ t('Error: {error}', { error: result.error }) }}</span>
    </div>
    <p class="help">{{ t('Sends one tiny request to Jev (costs a fraction of a cent).') }}</p>
  </div>
</template>
