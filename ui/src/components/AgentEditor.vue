<script setup lang="ts">
import { computed, reactive } from 'vue';

import { KNOWN_TOOLS, LIMITS, NAME_RE, composePrompt } from '../../../hooks/lib/registry.ts';
import { EFFORTS } from '../../../hooks/lib/types.ts';
import type { AgentInput, AgentRecord, SkillInput, SkillRecord } from '../api.ts';
import { t } from '../i18n/index.ts';
import Modal from './Modal.vue';
import Toggle from './Toggle.vue';

const props = defineProps<{
  /** The agent to edit; null for a new one. */
  agent: AgentRecord | null;
  /** Skills that already exist (selectable). */
  skills: SkillRecord[];
  /** Skills proposed together with a generated agent (editable, saved with it). */
  newSkills?: SkillRecord[];
  title: string;
  saveLabel?: string;
  busy?: boolean;
}>();

const emit = defineEmits<{
  save: [agent: AgentInput, newSkills: SkillInput[]];
  cancel: [];
}>();

const a = props.agent;
const form = reactive({
  name: a?.name ?? '',
  description: a?.description ?? '',
  prompt: a?.prompt ?? '',
  toolsAll: !a?.tools || a.tools.length === 0,
  tools: [...(a?.tools ?? [])],
  skills: [...(a?.skills ?? [])],
  tier: a?.tier ?? ('auto' as AgentRecord['tier']),
  effort: a?.effort ?? ('auto' as AgentRecord['effort']),
  enabled: a?.enabled ?? true,
});

const drafted = reactive(
  (props.newSkills ?? []).map((s) => ({ name: s.name, description: s.description, body: s.body })),
);

const toolChoices = computed(() => [
  ...KNOWN_TOOLS,
  ...form.tools.filter((tool) => !(KNOWN_TOOLS as readonly string[]).includes(tool)),
]);

const skillChoices = computed(() => [
  ...drafted.map((s) => ({ name: s.name, description: s.description, isNew: true })),
  ...props.skills.map((s) => ({ name: s.name, description: s.description, isNew: false })),
]);

const nameError = computed(() => {
  if (!form.name) return t('Enter a name.');
  return NAME_RE.test(form.name) ? '' : t('Name: a-z, 0-9 and hyphen, 2–40 characters, starts with a letter.');
});
const skillErrors = computed(() => drafted.some((s) => !s.description.trim() || !s.body.trim()));
const valid = computed(
  () => !nameError.value && form.description.trim() !== '' && form.prompt.trim() !== '' && !skillErrors.value,
);

function toggleTool(tool: string, on: boolean): void {
  form.tools = on ? [...new Set([...form.tools, tool])] : form.tools.filter((x) => x !== tool);
}

function toggleSkill(name: string, on: boolean): void {
  form.skills = on ? [...new Set([...form.skills, name])] : form.skills.filter((s) => s !== name);
}

function removeDrafted(name: string): void {
  const i = drafted.findIndex((s) => s.name === name);
  if (i >= 0) drafted.splice(i, 1);
  form.skills = form.skills.filter((s) => s !== name);
}

const preview = computed(() => {
  const map = new Map<string, SkillRecord>();
  for (const s of props.skills) map.set(s.name, s);
  for (const s of drafted) {
    map.set(s.name, { ...s, origin: 'manual', createdAt: '', updatedAt: '' });
  }
  const asAgent: AgentRecord = {
    name: form.name,
    description: form.description,
    prompt: form.prompt,
    skills: form.skills,
    tier: form.tier,
    effort: form.effort,
    enabled: form.enabled,
    origin: 'manual',
    createdAt: '',
    updatedAt: '',
  };
  return composePrompt(asAgent, map);
});

function submit(): void {
  if (!valid.value) return;
  const tools = form.toolsAll ? null : form.tools.length > 0 ? [...form.tools] : null;
  emit(
    'save',
    {
      name: form.name,
      description: form.description.trim(),
      prompt: form.prompt.trim(),
      tools,
      skills: [...form.skills],
      tier: form.tier,
      effort: form.effort,
      enabled: form.enabled,
    },
    drafted.map((s) => ({ name: s.name, description: s.description.trim(), body: s.body.trim() })),
  );
}

const counter = (n: number, max: number): string => `${n} / ${max}`;
</script>

<template>
  <Modal :title="title" wide @close="emit('cancel')">
    <form class="space-y-4" @submit.prevent="submit">
      <div>
        <label class="label" for="ae-name">{{ t('Name') }}</label>
        <input id="ae-name" v-model.trim="form.name" class="input mono" maxlength="40" autocomplete="off" spellcheck="false" />
        <p class="help" :class="nameError && form.name ? 'text-red-600 dark:text-red-400' : ''">
          {{ nameError || t('Registered in Claude Code as jev-governor:{name}', { name: form.name }) }}
        </p>
      </div>

      <div>
        <div class="flex items-baseline justify-between gap-2">
          <label class="label" for="ae-desc">{{ t('Description: when to use it') }}</label>
          <span class="text-xs text-zinc-500 tabular-nums">{{ counter(form.description.length, LIMITS.description) }}</span>
        </div>
        <input
          id="ae-desc"
          v-model="form.description"
          class="input"
          :maxlength="LIMITS.description"
          :placeholder="t('Fixes failing Rust tests: finds the cause, fixes the code, runs cargo test')"
        />
        <p class="help">
          {{
            t('One line. Jev uses it to decide whether the agent fits a task, so write what kind of work it is for.')
          }}
        </p>
      </div>

      <div>
        <div class="flex items-baseline justify-between gap-2">
          <label class="label" for="ae-prompt">{{ t('Prompt') }}</label>
          <span class="text-xs text-zinc-500 tabular-nums">{{ counter(form.prompt.length, LIMITS.prompt) }}</span>
        </div>
        <textarea
          id="ae-prompt"
          v-model="form.prompt"
          class="input mono min-h-40"
          rows="8"
          :maxlength="LIMITS.prompt"
          spellcheck="false"
        />
        <p class="help">
          {{ t('Short and in English: the role, the approach, what to return. No general programming advice.') }}
        </p>
      </div>

      <fieldset>
        <legend class="label">{{ t('Tools') }}</legend>
        <label class="mt-1 flex items-center gap-2 text-sm">
          <input v-model="form.toolsAll" type="checkbox" class="size-4 accent-indigo-600" />
          {{ t('All tools (same as the main session)') }}
        </label>
        <div class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3 md:grid-cols-4" :class="form.toolsAll ? 'opacity-50' : ''">
          <label v-for="tool in toolChoices" :key="tool" class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              class="size-4 accent-indigo-600"
              :disabled="form.toolsAll"
              :checked="form.tools.includes(tool)"
              @change="toggleTool(tool, ($event.target as HTMLInputElement).checked)"
            />
            <span class="mono">{{ tool }}</span>
          </label>
        </div>
        <p class="help">
          {{ t('Do not give researchers and reviewers Edit and Write: the agent will then only be able to read.') }}
        </p>
      </fieldset>

      <fieldset>
        <legend class="label">
          {{ t('Skills') }}
          <span class="font-normal text-zinc-500">({{ form.skills.length }} / {{ LIMITS.skillsPerAgent }})</span>
        </legend>
        <p v-if="skillChoices.length === 0" class="help">{{ t('No skills yet. Create them on the “Skills” tab.') }}</p>
        <ul v-else class="mt-1 space-y-1">
          <li v-for="skill in skillChoices" :key="skill.name">
            <label class="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                class="mt-0.5 size-4 accent-indigo-600"
                :checked="form.skills.includes(skill.name)"
                :disabled="!form.skills.includes(skill.name) && form.skills.length >= LIMITS.skillsPerAgent"
                @change="toggleSkill(skill.name, ($event.target as HTMLInputElement).checked)"
              />
              <span class="min-w-0">
                <span class="mono">{{ skill.name }}</span>
                <span v-if="skill.isNew" class="badge badge-indigo ml-1.5">{{ t('new') }}</span>
                <span class="block text-xs text-zinc-500 dark:text-zinc-400">{{ skill.description }}</span>
              </span>
            </label>
          </li>
        </ul>
      </fieldset>

      <div class="grid gap-4 sm:grid-cols-3">
        <div>
          <label class="label" for="ae-tier">{{ t('Model') }}</label>
          <select id="ae-tier" v-model="form.tier" class="input">
            <option value="auto">{{ t('Auto (Jev decides)') }}</option>
            <option value="standard">Sonnet 5.5</option>
            <option value="strong">Opus 5.5</option>
          </select>
        </div>
        <div>
          <label class="label" for="ae-effort">{{ t('Effort') }}</label>
          <select id="ae-effort" v-model="form.effort" class="input">
            <option value="auto">{{ t('Auto (Jev decides)') }}</option>
            <option v-for="e in EFFORTS" :key="e" :value="e">{{ e }}</option>
          </select>
        </div>
        <div>
          <span class="label">{{ t('Enabled') }}</span>
          <div class="mt-1.5"><Toggle v-model="form.enabled" :label="t('Enabled')" /></div>
        </div>
      </div>
      <p class="help -mt-2">
        {{
          t(
            'Pin the model or effort only if the agent always needs it; otherwise Jev will pick them for each task and save your limits.',
          )
        }}
      </p>

      <section v-if="drafted.length > 0" class="space-y-3">
        <h3 class="text-sm font-semibold">{{ t('New skills of this agent') }}</h3>
        <div
          v-for="(skill, i) in drafted"
          :key="skill.name"
          class="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="mono">{{ skill.name }}</span>
            <button type="button" class="btn btn-danger btn-sm" @click="removeDrafted(skill.name)">{{ t('Remove') }}</button>
          </div>
          <div>
            <div class="flex items-baseline justify-between">
              <label class="label" :for="`ns-desc-${i}`">{{ t('Description') }}</label>
              <span class="text-xs text-zinc-500 tabular-nums">{{ counter(skill.description.length, LIMITS.description) }}</span>
            </div>
            <input :id="`ns-desc-${i}`" v-model="skill.description" class="input" :maxlength="LIMITS.description" />
          </div>
          <div>
            <div class="flex items-baseline justify-between">
              <label class="label" :for="`ns-body-${i}`">{{ t('Skill text') }}</label>
              <span class="text-xs text-zinc-500 tabular-nums">{{ counter(skill.body.length, LIMITS.skillBody) }}</span>
            </div>
            <textarea
              :id="`ns-body-${i}`"
              v-model="skill.body"
              class="input mono min-h-28"
              rows="5"
              :maxlength="LIMITS.skillBody"
              spellcheck="false"
            />
          </div>
        </div>
      </section>

      <section>
        <div class="flex items-baseline justify-between gap-2">
          <h3 class="text-sm font-semibold">{{ t('Resulting system prompt') }}</h3>
          <span class="text-xs text-zinc-500 tabular-nums">{{ t('{n} {n#character|characters}', { n: preview.length }) }}</span>
        </div>
        <pre
          class="mono mt-1 max-h-72 overflow-auto rounded-lg border border-zinc-200 bg-zinc-100 p-3 break-words whitespace-pre-wrap dark:border-zinc-800 dark:bg-zinc-950"
          >{{ preview || '—' }}</pre
        >
        <p class="help">
          {{ t('Read-only: the agent prompt and the selected skills as one text, as the subagent will receive them.') }}
        </p>
      </section>

      <button type="submit" class="hidden" aria-hidden="true" tabindex="-1" />
    </form>

    <template #footer>
      <button type="button" class="btn" :disabled="busy" @click="emit('cancel')">{{ t('Cancel') }}</button>
      <button type="button" class="btn btn-primary" :disabled="!valid || busy" @click="submit">
        {{ saveLabel ?? t('Save') }}
      </button>
    </template>
  </Modal>
</template>
