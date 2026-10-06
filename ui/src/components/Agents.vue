<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import {
  api,
  notify,
  type AgentInput,
  type AgentView,
  type DraftRecord,
  type SkillInput,
  type SkillView,
} from '../api.ts';
import { fmtAgo } from '../format.ts';
import { t } from '../i18n/index.ts';
import AgentEditor from './AgentEditor.vue';
import GenerateAgent from './GenerateAgent.vue';
import Toggle from './Toggle.vue';

const STORAGE_KEY = 'jev-governor.draft';

const agents = ref<AgentView[]>([]);
const skills = ref<SkillView[]>([]);
const loaded = ref(false);
const busy = ref(false);

const editor = ref<{ agent: AgentView | null } | null>(null);
const generating = ref(false);
const resumeId = ref<string | undefined>(undefined);
const review = ref<DraftRecord | null>(null);

async function load(): Promise<void> {
  try {
    [agents.value, skills.value] = await Promise.all([api.agents(), api.skills()]);
    loaded.value = true;
  } catch {
    // shown as a toast
  }
}

onMounted(async () => {
  await load();
  let id: string | null = null;
  try {
    id = localStorage.getItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  if (!id) return;
  try {
    const draft = await api.draft(id);
    if (draft.status === 'done' && draft.result) review.value = draft;
    else {
      resumeId.value = id;
      generating.value = true;
    }
  } catch {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
});

const tierLabel = { standard: 'Sonnet 5.5', strong: 'Opus 5.5' } as const;

/**
 * Days without a run, counted from the last run (or from creation when there
 * was none), after which an enabled agent counts as unused: it only costs Jev
 * a candidate slot. A disabled one costs nothing.
 */
const UNUSED_DAYS = 14;

function unused(agent: AgentView): boolean {
  if (!agent.enabled) return false;
  // The stats cover 30 days: a run before that leaves lastUsedAt empty, and creation is older still.
  const since = Date.parse(agent.stats.lastUsedAt ?? agent.createdAt);
  return Number.isFinite(since) && Date.now() - since > UNUSED_DAYS * 86_400_000;
}

const WORD = /[\p{L}\p{N}]{3,}/gu;
const words = (text: string): Set<string> => new Set((text.toLowerCase().match(WORD) ?? []).filter((w) => !STOP.has(w)));
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'when', 'use', 'any', 'into', 'files', 'code']);

/** Agents whose descriptions mostly overlap: candidates to merge into one. */
const similar = computed(() => {
  const sets = agents.value.map((a) => ({ name: a.name, words: words(`${a.name.replace(/-/g, ' ')} ${a.description}`) }));
  const out = new Map<string, string[]>();
  for (const a of sets) {
    for (const b of sets) {
      if (a.name >= b.name) continue;
      const shared = [...a.words].filter((w) => b.words.has(w)).length;
      const jaccard = shared / Math.max(1, a.words.size + b.words.size - shared);
      if (jaccard < 0.45) continue;
      out.set(a.name, [...(out.get(a.name) ?? []), b.name]);
      out.set(b.name, [...(out.get(b.name) ?? []), a.name]);
    }
  }
  return out;
});

async function save(input: AgentInput): Promise<void> {
  busy.value = true;
  try {
    const current = editor.value?.agent;
    if (current) await api.updateAgent(current.name, input);
    else await api.createAgent(input);
    editor.value = null;
    notify(current ? t('Agent saved.') : t('Agent created.'));
    await load();
  } catch {
    // shown as a toast
  } finally {
    busy.value = false;
  }
}

async function toggle(agent: AgentView, enabled: boolean): Promise<void> {
  try {
    await api.updateAgent(agent.name, { enabled });
  } catch {
    // shown as a toast
  }
  await load();
}

async function remove(agent: AgentView): Promise<void> {
  if (!window.confirm(t('Delete agent “{name}”? This cannot be undone.', { name: agent.name }))) return;
  try {
    await api.deleteAgent(agent.name);
    notify(t('Agent deleted.'));
  } catch {
    // shown as a toast
  }
  await load();
}

function forget(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

function onDone(draft: DraftRecord): void {
  generating.value = false;
  resumeId.value = undefined;
  review.value = draft;
}

async function accept(agent: AgentInput, newSkills: SkillInput[]): Promise<void> {
  const draft = review.value;
  if (!draft) return;
  busy.value = true;
  try {
    const { agent: saved, skills: savedSkills } = await api.acceptDraft(draft.id, { agent, skills: newSkills });
    forget();
    review.value = null;
    notify(
      savedSkills.length > 0
        ? t('Agent “{name}” and {n} {n#skill|skills} saved.', { name: saved.name, n: savedSkills.length })
        : t('Agent “{name}” saved.', { name: saved.name }),
    );
    await load();
  } catch {
    // shown as a toast
  } finally {
    busy.value = false;
  }
}

async function discardReview(): Promise<void> {
  const draft = review.value;
  review.value = null;
  forget();
  if (draft) await api.deleteDraft(draft.id).catch(() => undefined);
}

function closeGenerate(): void {
  generating.value = false;
  resumeId.value = undefined;
}
</script>

<template>
  <div class="space-y-4">
    <p class="card text-sm text-zinc-600 dark:text-zinc-300">
      {{
        t(
          'Agents are mostly created automatically: when Claude launches a subagent and there is no suitable specialist, the mod writes a new one. Here you can edit them, disable them or create them by hand. Keep prompts short and in English: they go into the context of every run.',
        )
      }}
    </p>

    <div class="flex flex-wrap items-center gap-2">
      <button type="button" class="btn btn-primary" @click="editor = { agent: null }">{{ t('New agent') }}</button>
      <button type="button" class="btn" @click="generating = true">{{ t('Generate from a description') }}</button>
      <span class="text-sm text-zinc-500 dark:text-zinc-400">{{ t('Total: {n}', { n: agents.length }) }}</span>
    </div>

    <p v-if="!loaded" class="text-sm text-zinc-500">{{ t('Loading…') }}</p>
    <p v-else-if="agents.length === 0" class="card text-sm text-zinc-600 dark:text-zinc-300">
      {{ t('No agents yet. They will appear on their own as you work, or create the first one by hand.') }}
    </p>

    <ul class="grid gap-4 lg:grid-cols-2">
      <li v-for="agent in agents" :key="agent.name" class="card flex flex-col gap-3" :class="agent.enabled ? '' : 'opacity-70'">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <h3 class="mono truncate text-sm font-semibold" :title="agent.name">{{ agent.name }}</h3>
            <div class="mt-1 flex flex-wrap gap-1.5">
              <span class="badge" :class="agent.origin === 'auto' ? 'badge-indigo' : 'badge-gray'">
                {{ agent.origin === 'auto' ? t('auto') : t('manual') }}
              </span>
              <span v-if="agent.tier !== 'auto'" class="badge badge-amber">{{ t('model: {tier}', { tier: tierLabel[agent.tier] }) }}</span>
              <span v-if="agent.effort !== 'auto'" class="badge badge-amber">{{ t('effort: {effort}', { effort: agent.effort }) }}</span>
              <span v-if="agent.tier === 'auto' && agent.effort === 'auto'" class="badge badge-gray">{{ t('model and effort: Jev') }}</span>
              <span
                v-if="unused(agent)"
                class="badge badge-amber"
                :title="
                  t(
                    'No runs in {n} {n#day|days} (counted from the last run, or from creation if there were none). Every enabled agent is one more candidate that Jev compares when a subagent starts; it is better to delete or disable one you do not need.',
                    { n: UNUSED_DAYS },
                  )
                "
              >
                {{ t('not used') }}
              </span>
              <span v-if="agent.tools" class="badge badge-gray" :title="agent.tools.join(', ')">
                {{ t('tools: {n}', { n: agent.tools.length }) }}
              </span>
            </div>
          </div>
          <Toggle
            :model-value="agent.enabled"
            :label="t('Enable {name}', { name: agent.name })"
            @update:model-value="toggle(agent, $event)"
          />
        </div>

        <p class="text-sm">{{ agent.description }}</p>

        <div v-if="agent.skills.length" class="flex flex-wrap gap-1.5">
          <span v-for="s in agent.skills" :key="s" class="badge badge-gray mono">{{ s }}</span>
        </div>

        <p v-if="similar.get(agent.name)" class="help">
          {{
            t('Similar to {names}: you may want to keep just one (move the skills over and delete the other).', {
              names: similar.get(agent.name)!.join(', '),
            })
          }}
        </p>

        <p class="text-xs text-zinc-500 dark:text-zinc-400">
          {{ t('Runs in 30 days:') }} <span class="tabular-nums">{{ agent.stats.uses }}</span> · {{ fmtAgo(agent.stats.lastUsedAt) }}
        </p>

        <div class="mt-auto flex gap-2">
          <button type="button" class="btn btn-sm" @click="editor = { agent }">{{ t('Edit') }}</button>
          <button type="button" class="btn btn-danger btn-sm" @click="remove(agent)">{{ t('Delete') }}</button>
        </div>
      </li>
    </ul>

    <AgentEditor
      v-if="editor"
      :agent="editor.agent"
      :skills="skills"
      :title="editor.agent ? t('Agent {name}', { name: editor.agent.name }) : t('New agent')"
      :busy="busy"
      @save="save"
      @cancel="editor = null"
    />

    <GenerateAgent v-if="generating" :resume-id="resumeId" @done="onDone" @close="closeGenerate" />

    <AgentEditor
      v-if="review?.result"
      :agent="review.result.agent"
      :skills="skills"
      :new-skills="review.result.skills"
      :title="t('New agent: review the draft')"
      :save-label="t('Save agent')"
      :busy="busy"
      @save="accept"
      @cancel="discardReview"
    />
  </div>
</template>
