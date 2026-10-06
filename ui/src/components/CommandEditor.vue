<script setup lang="ts">
import { computed, reactive } from 'vue';

import type { CommandGroup, ProjectCommandRecord } from '../api.ts';
import { getGroups, type EditorResult } from '../groups.ts';
import { t } from '../i18n/index.ts';
import Modal from './Modal.vue';

const props = defineProps<{
  /** The command to edit, or null to add a new one. */
  command: ProjectCommandRecord | null;
  busy?: boolean;
  /** `projects.describeWithClaude`: an empty description is then written again by Claude. */
  autoDescribe?: boolean;
}>();
const emit = defineEmits<{ save: [result: EditorResult]; remove: []; cancel: [] }>();

const c = props.command;
/** Only manual commands (and a new one) can change their text and folder. */
const textEditable = c === null || c.source === 'manual';
const form = reactive({
  command: c?.command ?? '',
  dir: c?.dir ?? '',
  group: (c?.group ?? 'run') as CommandGroup,
  description: c?.description ?? '',
});

const commandError = computed(() => {
  const text = form.command.trim();
  if (!text) return t('Enter a command.');
  if (text.length > 300) return t('No longer than 300 characters.');
  return '';
});
const dirError = computed(() => {
  const text = form.dir.trim();
  if (!text) return '';
  if (text.startsWith('/') || text.startsWith('~')) return t('The folder is relative to the project, without a leading “/” or “~”.');
  if (text.split('/').includes('..')) return t('Using “..” is not allowed.');
  return '';
});
const groups = computed(getGroups);
const foundSource = computed(() => `${c?.source ?? ''}${c?.sourceDetail ? ` · ${c.sourceDetail}` : ''}`);
const valid = computed(() => !textEditable || (!commandError.value && !dirError.value));

function submit(): void {
  if (!valid.value || props.busy) return;
  emit('save', {
    command: form.command.trim(),
    dir: form.dir.trim(),
    group: form.group,
    description: form.description.trim(),
  });
}
</script>

<template>
  <Modal :title="c === null ? t('Add command') : t('Edit command')" @close="emit('cancel')">
    <form class="space-y-4" @submit.prevent="submit">
      <div>
        <label class="label" for="ce-command">{{ t('Command') }}</label>
        <input
          v-if="textEditable"
          id="ce-command"
          v-model="form.command"
          class="input mono"
          maxlength="300"
          placeholder="make dev"
          autocomplete="off"
          spellcheck="false"
        />
        <code v-else class="mono mt-1 block rounded-lg bg-zinc-100 px-3 py-2 break-all dark:bg-zinc-800">{{ c?.command }}</code>
        <p v-if="textEditable" class="help" :class="commandError && form.command ? 'text-red-600 dark:text-red-400' : ''">
          {{ commandError && form.command ? commandError : t('A single line. Commands containing tokens, passwords or keys are not saved.') }}
        </p>
        <p v-else class="help">
          {{ t('The command was found automatically ({source}): you can edit the description and group, or hide a command you do not need.', { source: foundSource }) }}
        </p>
      </div>

      <div v-if="textEditable">
        <label class="label" for="ce-dir">{{ t('Folder inside the project') }}</label>
        <input id="ce-dir" v-model="form.dir" class="input mono" maxlength="200" :placeholder="t('empty means the project root')" autocomplete="off" spellcheck="false" />
        <p class="help" :class="dirError ? 'text-red-600 dark:text-red-400' : ''">
          {{ dirError || t('For example, web or crates/core. The command runs as “cd folder && command”.') }}
        </p>
      </div>
      <p v-else-if="c?.dir" class="help">{{ t('Folder') }}: <code class="mono">{{ c.dir }}</code></p>

      <div>
        <label class="label" for="ce-group">{{ t('Group') }}</label>
        <select id="ce-group" v-model="form.group" class="input">
          <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.title }}</option>
        </select>
      </div>

      <div>
        <div class="flex items-baseline justify-between gap-2">
          <label class="label" for="ce-desc">{{ t('Description') }}</label>
          <span class="text-xs text-zinc-500 tabular-nums">{{ form.description.length }} / 300</span>
        </div>
        <input id="ce-desc" v-model="form.description" class="input" maxlength="300" autocomplete="off" />
        <p class="help">
          {{ t('A single line: what the command does.') }}
          <template v-if="c !== null">
            {{ t('Claude will not rewrite a description you wrote.') }}
            <template v-if="autoDescribe">{{ t('Clear the field to let Claude write the description again.') }}</template>
            <template v-else>{{ t('Clear the field to restore the draft from the project files.') }}</template>
          </template>
        </p>
      </div>
      <button type="submit" class="hidden" aria-hidden="true" tabindex="-1" />
    </form>

    <template #footer>
      <button v-if="c !== null && c.source === 'manual'" type="button" class="btn btn-danger mr-auto" :disabled="busy" @click="emit('remove')">
        {{ t('Delete') }}
      </button>
      <button type="button" class="btn" :disabled="busy" @click="emit('cancel')">{{ t('Cancel') }}</button>
      <button type="button" class="btn btn-primary" :disabled="!valid || busy" @click="submit">
        {{ c === null ? t('Add') : t('Save') }}
      </button>
    </template>
  </Modal>
</template>
