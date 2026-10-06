<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { api, notify, type SkillInput, type SkillView } from '../api.ts';
import { t } from '../i18n/index.ts';
import SkillEditor from './SkillEditor.vue';

const skills = ref<SkillView[]>([]);
const loaded = ref(false);
const busy = ref(false);
const editor = ref<{ skill: SkillView | null } | null>(null);

async function load(): Promise<void> {
  try {
    skills.value = await api.skills();
    loaded.value = true;
  } catch {
    // shown as a toast
  }
}

onMounted(load);

async function save(input: SkillInput): Promise<void> {
  busy.value = true;
  try {
    const current = editor.value?.skill;
    if (current) await api.updateSkill(current.name, input);
    else await api.createSkill(input);
    editor.value = null;
    notify(current ? t('Skill saved.') : t('Skill created.'));
    await load();
  } catch {
    // shown as a toast
  } finally {
    busy.value = false;
  }
}

async function remove(skill: SkillView): Promise<void> {
  const used =
    skill.usedBy.length > 0
      ? `\n\n${t('The skill is used by agents: {names}. It will be removed from their lists.', { names: skill.usedBy.join(', ') })}`
      : '';
  if (!window.confirm(`${t('Delete skill “{name}”?', { name: skill.name })}${used}`)) return;
  try {
    await api.deleteSkill(skill.name);
    notify(t('Skill deleted.'));
  } catch {
    // shown as a toast
  }
  await load();
}
</script>

<template>
  <div class="space-y-4">
    <p class="card text-sm text-zinc-600 dark:text-zinc-300">
      {{
        t(
          'A skill is a short piece of concrete knowledge (commands, conventions, pitfalls) that is added to the agent prompt. One skill can be used by several agents. An agent has at most 4 skills, and a skill text is at most 2000 characters long.',
        )
      }}
    </p>

    <div class="flex flex-wrap items-center gap-2">
      <button type="button" class="btn btn-primary" @click="editor = { skill: null }">{{ t('New skill') }}</button>
      <span class="text-sm text-zinc-500 dark:text-zinc-400">{{ t('Total: {n}', { n: skills.length }) }}</span>
    </div>

    <p v-if="!loaded" class="text-sm text-zinc-500">{{ t('Loading…') }}</p>
    <p v-else-if="skills.length === 0" class="card text-sm text-zinc-600 dark:text-zinc-300">{{ t('No skills yet.') }}</p>

    <ul class="grid gap-4 lg:grid-cols-2">
      <li v-for="skill in skills" :key="skill.name" class="card flex flex-col gap-3">
        <div>
          <h3 class="mono truncate text-sm font-semibold" :title="skill.name">{{ skill.name }}</h3>
          <div class="mt-1 flex flex-wrap gap-1.5">
            <span class="badge" :class="skill.origin === 'auto' ? 'badge-indigo' : 'badge-gray'">
              {{ skill.origin === 'auto' ? t('auto') : t('manual') }}
            </span>
            <span class="badge badge-gray tabular-nums">{{ t('{n} chars', { n: skill.body.length }) }}</span>
          </div>
        </div>
        <p class="text-sm">{{ skill.description }}</p>
        <div class="text-xs text-zinc-500 dark:text-zinc-400">
          <template v-if="skill.usedBy.length">
            {{ t('Used by:') }}
            <span v-for="a in skill.usedBy" :key="a" class="badge badge-gray mono mr-1">{{ a }}</span>
          </template>
          <template v-else>{{ t('Not used by any agent.') }}</template>
        </div>
        <div class="mt-auto flex gap-2">
          <button type="button" class="btn btn-sm" @click="editor = { skill }">{{ t('Edit') }}</button>
          <button type="button" class="btn btn-danger btn-sm" @click="remove(skill)">{{ t('Delete') }}</button>
        </div>
      </li>
    </ul>

    <SkillEditor
      v-if="editor"
      :skill="editor.skill"
      :title="editor.skill ? t('Skill {name}', { name: editor.skill.name }) : t('New skill')"
      :busy="busy"
      @save="save"
      @cancel="editor = null"
    />
  </div>
</template>
