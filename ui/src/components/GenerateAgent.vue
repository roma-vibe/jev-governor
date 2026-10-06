<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

import { api, type DraftRecord } from '../api.ts';
import { t } from '../i18n/index.ts';
import Modal from './Modal.vue';

const props = defineProps<{ resumeId?: string }>();
const emit = defineEmits<{ done: [draft: DraftRecord]; close: [] }>();

const STORAGE_KEY = 'jev-governor.draft';
const description = ref('');
const draft = ref<DraftRecord | null>(null);
const gone = ref(false);
const busy = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

function remember(id: string | null): void {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage may be unavailable
  }
}

async function poll(id: string): Promise<void> {
  try {
    const next = await api.draft(id);
    draft.value = next;
    if (next.status === 'done' && next.result) {
      stop();
      emit('done', next);
    } else if (next.status === 'error') {
      stop();
    }
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 404) {
      stop();
      gone.value = true;
      remember(null);
    }
    // other errors (server restarting): keep polling
  }
}

function watchDraft(id: string): void {
  stop();
  void poll(id);
  timer = setInterval(() => void poll(id), 2000);
}

function stop(): void {
  clearInterval(timer);
  timer = undefined;
}

async function start(): Promise<void> {
  busy.value = true;
  gone.value = false;
  try {
    const created = await api.createDraft(description.value.trim());
    draft.value = created;
    remember(created.id);
    watchDraft(created.id);
  } catch {
    // shown as a toast
  } finally {
    busy.value = false;
  }
}

/** Drops the draft (the mod may still be writing it; the file is just removed) and closes. */
async function cancel(): Promise<void> {
  stop();
  const id = draft.value?.id;
  remember(null);
  if (id) await api.deleteDraft(id).catch(() => undefined);
  emit('close');
}

async function retry(): Promise<void> {
  const id = draft.value?.id;
  remember(null);
  if (id) await api.deleteDraft(id).catch(() => undefined);
  draft.value = null;
}

onMounted(() => {
  if (props.resumeId) watchDraft(props.resumeId);
});
onUnmounted(stop);

const valid = computed(() => description.value.trim().length >= 10 && description.value.trim().length <= 2000);
const status = computed(() => draft.value?.status);
</script>

<template>
  <Modal :title="t('Generate an agent from a description')" @close="cancel">
    <div v-if="gone" class="space-y-3 text-sm">
      <p>{{ t('The draft is gone (it was deleted or never saved). Try again.') }}</p>
      <button type="button" class="btn" @click="gone = false; draft = null">{{ t('New request') }}</button>
    </div>

    <form v-else-if="!draft" class="space-y-3" @submit.prevent="start">
      <label class="label" for="gen-desc">{{ t('What the agent should be able to do') }}</label>
      <textarea
        id="gen-desc"
        v-model="description"
        class="input min-h-32"
        rows="6"
        maxlength="2000"
        :placeholder="t('An agent that fixes failing tests in Rust projects: finds the cause, fixes the code and reruns cargo test…')"
      />
      <p class="help">
        {{
          t(
            'Describe a class of tasks in one paragraph (10–2000 characters), not one specific task. Claude will write a short prompt in English and, if needed, skills; you can edit everything before saving.',
          )
        }}
        <span class="tabular-nums">{{ description.trim().length }} / 2000</span>
      </p>
      <p class="help">
        {{
          t(
            'The draft is created by an open Claude Code session with the mod (it checks the queue about every 8 seconds). If there is no such session, the request will wait.',
          )
        }}
      </p>
    </form>

    <div v-else class="space-y-3 text-sm" aria-live="polite">
      <p v-if="status === 'pending'" class="flex items-start gap-2">
        <span class="mt-1 inline-block size-2.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
        <span>
          {{
            t(
              'Waiting for an open Claude Code session with the mod: the draft is created there about every 8 seconds. Open Claude Code if it is closed.',
            )
          }}
        </span>
      </p>
      <p v-else-if="status === 'working'" class="flex items-start gap-2">
        <span class="mt-1 inline-block size-2.5 shrink-0 animate-pulse rounded-full bg-indigo-500" />
        <span>{{ t('Claude is writing the draft… It usually takes up to half a minute.') }}</span>
      </p>
      <p v-else-if="status === 'done'" class="text-emerald-700 dark:text-emerald-400">{{ t('Done, opening the editor…') }}</p>
      <div v-else-if="status === 'error'" class="space-y-2">
        <p class="text-red-700 dark:text-red-400">{{ t('Failed: {error}', { error: draft.error ?? t('unknown error') }) }}</p>
        <button type="button" class="btn" @click="retry">{{ t('Edit the request') }}</button>
      </div>
      <blockquote class="border-l-2 border-zinc-300 pl-3 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
        {{ draft.request.description }}
      </blockquote>
    </div>

    <template #footer>
      <button type="button" class="btn" @click="cancel">{{ t('Cancel') }}</button>
      <button
        v-if="!draft && !gone"
        type="button"
        class="btn btn-primary"
        :disabled="!valid || busy"
        @click="start"
      >
        {{ t('Generate') }}
      </button>
    </template>
  </Modal>
</template>
