<script setup lang="ts">
import { computed, reactive } from 'vue';

import { LIMITS, NAME_RE } from '../../../hooks/lib/registry.ts';
import type { SkillInput, SkillView } from '../api.ts';
import { t } from '../i18n/index.ts';
import Modal from './Modal.vue';

const props = defineProps<{ skill: SkillView | null; title: string; busy?: boolean }>();
const emit = defineEmits<{ save: [skill: SkillInput]; cancel: [] }>();

const s = props.skill;
const form = reactive({ name: s?.name ?? '', description: s?.description ?? '', body: s?.body ?? '' });

const nameError = computed(() => {
  if (!form.name) return t('Enter a name.');
  return NAME_RE.test(form.name) ? '' : t('Name: a-z, 0-9 and hyphen, 2–40 characters, starts with a letter.');
});
const valid = computed(() => !nameError.value && form.description.trim() !== '' && form.body.trim() !== '');
const renaming = computed(() => s !== null && s.name !== form.name && s.usedBy.length > 0);

function submit(): void {
  if (!valid.value) return;
  emit('save', { name: form.name, description: form.description.trim(), body: form.body.trim() });
}
</script>

<template>
  <Modal :title="title" @close="emit('cancel')">
    <form class="space-y-4" @submit.prevent="submit">
      <div>
        <label class="label" for="se-name">{{ t('Name') }}</label>
        <input id="se-name" v-model.trim="form.name" class="input mono" maxlength="40" autocomplete="off" spellcheck="false" />
        <p class="help" :class="nameError && form.name ? 'text-red-600 dark:text-red-400' : ''">
          {{ nameError || t('Latin letters, digits and hyphen.') }}
        </p>
        <p v-if="renaming" class="help text-amber-700 dark:text-amber-400">
          {{ t('When renamed, the references in these agents will be updated: {agents}.', { agents: s?.usedBy.join(', ') ?? '' }) }}
        </p>
      </div>

      <div>
        <div class="flex items-baseline justify-between gap-2">
          <label class="label" for="se-desc">{{ t('Description') }}</label>
          <span class="text-xs text-zinc-500 tabular-nums">{{ form.description.length }} / {{ LIMITS.description }}</span>
        </div>
        <input id="se-desc" v-model="form.description" class="input" :maxlength="LIMITS.description" />
        <p class="help">{{ t('One line: what this skill is about and when it is useful.') }}</p>
      </div>

      <div>
        <div class="flex items-baseline justify-between gap-2">
          <label class="label" for="se-body">{{ t('Skill text') }}</label>
          <span class="text-xs text-zinc-500 tabular-nums">{{ form.body.length }} / {{ LIMITS.skillBody }}</span>
        </div>
        <textarea
          id="se-body"
          v-model="form.body"
          class="input mono min-h-48"
          rows="10"
          :maxlength="LIMITS.skillBody"
          spellcheck="false"
        />
        <p class="help">
          {{
            t(
              'Concrete knowledge: exact commands, project conventions, pitfalls. Short and in English. It is added to the prompt of every agent that uses the skill.',
            )
          }}
        </p>
      </div>
      <button type="submit" class="hidden" aria-hidden="true" tabindex="-1" />
    </form>

    <template #footer>
      <button type="button" class="btn" :disabled="busy" @click="emit('cancel')">{{ t('Cancel') }}</button>
      <button type="button" class="btn btn-primary" :disabled="!valid || busy" @click="submit">{{ t('Save') }}</button>
    </template>
  </Modal>
</template>
