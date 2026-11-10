<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { api, notify, type FactView, type MemoryOverview, type MemoryProjectView } from '../api.ts';
import { locale, t } from '../i18n/index.ts';
import { go, segments } from '../router.ts';
import { store } from '../store.ts';
import Modal from './Modal.vue';
import Toggle from './Toggle.vue';

const TYPES = ['decision', 'convention', 'architecture', 'bug', 'gotcha', 'workflow', 'preference', 'reference', 'context'] as const;
const LEVELS = ['core', 'high', 'normal', 'low'] as const;
const MAX_CHARS = 300;

const overview = ref<MemoryOverview | null>(null);
const facts = ref<FactView[]>([]);
const factsFor = ref('');
const loadingFacts = ref(false);
const busy = ref(false);
const toggling = ref(false);
const search = ref('');
const projectSearch = ref('');
const typeFilter = ref('');
const showRetired = ref(false);
const editor = ref<{ fact: FactView | null; text: string; type: string; importance: string; pinned: boolean } | null>(null);
const moving = ref<{ fact: FactView; to: string } | null>(null);
const addRelated = ref('');
const mergeInto = ref('');

function typeLabel(type: string | null): string {
  switch (type) {
    case 'decision':
      return t('decision');
    case 'convention':
      return t('convention');
    case 'architecture':
      return t('architecture');
    case 'bug':
      return t('bug');
    case 'gotcha':
      return t('trap');
    case 'workflow':
      return t('how-to');
    case 'preference':
      return t('preference');
    case 'reference':
      return t('reference');
    case 'context':
      return t('context');
    default:
      return t('untyped');
  }
}

function levelLabel(level: string): string {
  switch (level) {
    case 'core':
      return t('key');
    case 'high':
      return t('important');
    case 'low':
      return t('minor');
    default:
      return t('normal');
  }
}

/** `#/memory/<id>`; the person's memory when nothing is picked. */
const selected = computed(() => segments.value[1] ?? overview.value?.personal?.id ?? '');
const isPersonal = computed(() => selected.value !== '' && selected.value === overview.value?.personal?.id);
const project = computed<MemoryProjectView | undefined>(() => overview.value?.projects.find((p) => p.id === selected.value));
const projectName = (id: string): string => overview.value?.projects.find((p) => p.id === id)?.name ?? id;

const shownProjects = computed(() => {
  const q = projectSearch.value.trim().toLowerCase();
  const list = overview.value?.projects ?? [];
  return q ? list.filter((p) => [p.name, ...p.names, p.id].some((n) => n.toLowerCase().includes(q))) : list;
});

const matching = computed(() => {
  const q = search.value.trim().toLowerCase();
  return facts.value.filter((f) => (!typeFilter.value || f.type === typeFilter.value) && (!q || f.text.toLowerCase().includes(q)));
});
const weight = (f: FactView): number => (f.pinned ? 4 : 0) + (f.importance === 'core' ? 3 : f.importance === 'high' ? 2 : f.importance === 'low' ? 0 : 1);
const knowledge = computed(() => matching.value.filter((f) => !f.session && f.status === 'active').sort((a, b) => weight(b) - weight(a) || b.updatedAt.localeCompare(a.updatedAt)));
const chatNotes = computed(() => matching.value.filter((f) => f.session && f.status === 'active'));
const retired = computed(() => matching.value.filter((f) => f.status !== 'active'));

const relatedChoices = computed(() => (overview.value?.projects ?? []).filter((p) => p.id !== selected.value && !project.value?.related.includes(p.id)));
const mergeChoices = computed(() => (overview.value?.projects ?? []).filter((p) => p.id !== selected.value));
const moveChoices = computed(() => {
  const o = overview.value;
  if (!o) return [];
  const all = [...(o.personal ? [{ id: o.personal.id, label: t('About me') }] : []), ...o.projects.map((p) => ({ id: p.id, label: p.name }))];
  return all.filter((c) => c.id !== moving.value?.fact.memory);
});

const day = (ts: string): string => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
};

async function loadOverview(quiet = false): Promise<void> {
  try {
    overview.value = await api.memory(quiet);
  } catch {
    // shown as a toast
  }
}

async function loadFacts(): Promise<void> {
  const id = selected.value;
  if (!id || !overview.value?.reachable) {
    facts.value = [];
    factsFor.value = '';
    return;
  }
  loadingFacts.value = true;
  try {
    const result = await api.memoryFacts(id, showRetired.value);
    if (selected.value === id) {
      facts.value = result.facts;
      factsFor.value = id;
    }
  } catch {
    // shown as a toast
  } finally {
    loadingFacts.value = false;
  }
}

onMounted(async () => {
  await loadOverview();
  await loadFacts();
});
watch([selected, showRetired], () => {
  search.value = '';
  typeFilter.value = '';
  void loadFacts();
});

async function refresh(): Promise<void> {
  await loadOverview(true);
  await loadFacts();
}

/** The switch saves at once. Off, nothing is asked of the memory service, by this page either. */
async function toggleMemory(on: boolean): Promise<void> {
  if (toggling.value) return;
  toggling.value = true;
  try {
    store.config = await api.saveConfig({ memory: { enabled: on } });
    notify(on ? t('Memory on. Chats pick it up on their next turn.') : t('Memory off. The memory service is no longer touched.'));
    await refresh();
  } catch {
    // shown as a toast
  } finally {
    toggling.value = false;
  }
}

function open(id: string): void {
  go(`/memory/${encodeURIComponent(id)}`);
}

function edit(fact: FactView | null): void {
  editor.value = fact
    ? { fact, text: fact.text, type: fact.type ?? 'context', importance: fact.importance, pinned: fact.pinned }
    : { fact: null, text: '', type: isPersonal.value ? 'preference' : 'decision', importance: 'normal', pinned: false };
}

async function act(work: () => Promise<unknown>, done: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await work();
    notify(done);
    await refresh();
  } catch {
    // shown as a toast
  } finally {
    busy.value = false;
  }
}

async function saveFact(): Promise<void> {
  const e = editor.value;
  if (!e) return;
  const input = { text: e.text, type: e.type, importance: e.importance, pinned: e.pinned };
  await act(async () => {
    if (e.fact) await api.updateMemoryFact(e.fact.memory, e.fact.id, input);
    else await api.addMemoryFact(selected.value, input);
    editor.value = null;
  }, e.fact ? t('Fact saved.') : t('Fact added.'));
}

async function removeFact(fact: FactView): Promise<void> {
  if (!window.confirm(t('Remove this from the memory? It will no longer be recalled.'))) return;
  await act(() => api.deleteMemoryFact(fact.memory, fact.id), t('Removed from the memory.'));
}

async function togglePin(fact: FactView): Promise<void> {
  await act(() => api.updateMemoryFact(fact.memory, fact.id, { pinned: !fact.pinned }), fact.pinned ? t('Unpinned.') : t('Pinned: it is always recalled.'));
}

async function moveFact(): Promise<void> {
  const m = moving.value;
  if (!m || !m.to) return;
  await act(async () => {
    await api.moveMemoryFact(m.fact.memory, m.fact.id, m.to);
    moving.value = null;
  }, t('Moved.'));
}

async function relate(): Promise<void> {
  const p = project.value;
  if (!p || !addRelated.value) return;
  const next = [...p.related, addRelated.value];
  addRelated.value = '';
  await act(() => api.updateMemoryProject(p.id, { related: next }), t('Projects related.'));
}

async function unrelate(id: string): Promise<void> {
  const p = project.value;
  if (!p) return;
  await act(() => api.updateMemoryProject(p.id, { related: p.related.filter((r) => r !== id) }), t('Relation removed.'));
}

async function merge(): Promise<void> {
  const p = project.value;
  const into = mergeInto.value;
  if (!p || !into) return;
  if (!window.confirm(t('Join the memory of “{from}” to “{into}”? Its facts stay and are read with that project’s; new facts go to “{into}”.', { from: p.name, into: projectName(into) }))) return;
  mergeInto.value = '';
  await act(async () => {
    await api.mergeMemory(p.id, into);
    open(into);
  }, t('Memories joined.'));
}

async function split(id: string): Promise<void> {
  if (!window.confirm(t('Make “{id}” a separate project again?', { id }))) return;
  await act(() => api.splitMemory(id), t('Separated.'));
}
</script>

<template>
  <div class="space-y-4">
    <p v-if="!overview" class="text-sm text-zinc-500">{{ t('Loading…') }}</p>

    <template v-else>
      <section class="card space-y-2" :class="overview.enabled ? '' : 'opacity-90'">
        <div class="flex items-start gap-4">
          <div class="min-w-0 flex-1 space-y-2">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="text-base font-semibold">{{ t('Long-term memory') }}</h2>
              <span v-if="!overview.enabled" class="badge badge-gray">{{ t('switched off') }}</span>
              <span v-else-if="overview.reachable" class="badge badge-green">{{ t('working') }}</span>
              <span v-else class="badge badge-amber">{{ overview.configured ? t('on, the service does not answer') : t('on, no service found') }}</span>
              <span v-if="overview.enabled" class="mono text-zinc-500 dark:text-zinc-400">{{ overview.url }}</span>
              <button type="button" class="btn btn-sm" :disabled="busy" @click="refresh">{{ t('Refresh') }}</button>
            </div>
            <p class="help">
              {{
                t(
                  'Two layers. “About me” is who you are and how you want to be worked with: it is read at the start of every chat in every project. A project’s memory holds its decisions, conventions, traps and a note of each chat on it; a chat on that project gets what its task needs, and a task that reaches into another project gets that project’s notes too.',
                )
              }}
            </p>
          </div>
          <Toggle :model-value="overview.enabled" :disabled="toggling" :label="t('Long-term memory')" @update:model-value="toggleMemory" />
        </div>
        <p v-if="!overview.enabled" class="text-sm text-zinc-600 dark:text-zinc-300">
          {{ t('Switched off: the mod does not touch the memory service at all. Chats get no notes and save nothing, and everything else works as it did. What is stored stays where it is.') }}
        </p>
        <p v-else-if="!overview.configured" class="text-sm text-amber-700 dark:text-amber-400">
          {{ t('No memory service was found (no key in {file}), so the memory is not used. Nothing needs switching: once the service is set up, the memory starts working by itself.', { file: overview.keyFile }) }}
        </p>
        <p v-else-if="!overview.reachable" class="text-sm text-amber-700 dark:text-amber-400">
          {{ t('The memory service does not answer at {url}, so the memory is not used for now. Nothing needs switching: when the service is back, the memory works again by itself.', { url: overview.url }) }}
          <span v-if="overview.error" class="mono">{{ overview.error }}</span>
        </p>
        <p v-if="overview.enabled" class="text-sm">
          {{
            t('In the last {days} days: notes went into {with} of {recalls} chats and subagent tasks ({notes} notes); {saved} facts and {chats} chat notes were saved in {saves} readings of the dialog.', {
              days: overview.activity.days,
              with: overview.activity.recallsWithNotes,
              recalls: overview.activity.recalls,
              notes: overview.activity.notes,
              saved: overview.activity.factsSaved,
              chats: overview.activity.chatNotes,
              saves: overview.activity.saves,
            })
          }}
          <span v-if="overview.activity.failures > 0" class="text-red-700 dark:text-red-400">
            {{ t('Failures: {n}.', { n: overview.activity.failures }) }}
            <span v-if="overview.activity.lastError" class="mono">{{ overview.activity.lastError }}</span>
          </span>
        </p>
      </section>

      <div v-if="overview.reachable" class="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <nav class="space-y-3" :aria-label="t('Memories')">
          <button
            v-if="overview.personal"
            type="button"
            class="card flex w-full items-center justify-between gap-2 text-left transition hover:border-indigo-400 dark:hover:border-indigo-500"
            :class="isPersonal ? '!border-indigo-500 dark:!border-indigo-400' : ''"
            @click="open(overview.personal.id)"
          >
            <span>
              <span class="block text-sm font-semibold">{{ t('About me') }}</span>
              <span class="block text-xs text-zinc-500 dark:text-zinc-400">{{ t('the main memory, in every project') }}</span>
            </span>
            <span class="badge badge-indigo tabular-nums">{{ overview.personal.facts }}</span>
          </button>

          <div class="card !p-0">
            <div class="border-b border-zinc-200 p-3 dark:border-zinc-800">
              <h3 class="text-sm font-semibold">{{ t('Projects') }} · {{ overview.projects.length }}</h3>
              <input v-model="projectSearch" type="search" class="input mt-2" :placeholder="t('Find a project')" autocomplete="off" />
            </div>
            <ul class="max-h-[32rem] overflow-y-auto">
              <li v-for="p in shownProjects" :key="p.id">
                <button
                  type="button"
                  class="flex w-full items-center justify-between gap-2 border-l-2 px-3 py-2 text-left text-sm transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  :class="p.id === selected ? 'border-indigo-500 bg-zinc-100 font-medium dark:bg-zinc-800' : 'border-transparent'"
                  @click="open(p.id)"
                >
                  <span class="min-w-0">
                    <span class="block truncate">{{ p.name }}</span>
                    <span v-if="p.local || p.aliases.length || p.related.length" class="block truncate text-xs text-zinc-500 dark:text-zinc-400">
                      {{ [p.local ? t('no git remote') : '', p.aliases.length ? t('+{n} older', { n: p.aliases.length }) : '', p.related.length ? t('related: {n}', { n: p.related.length }) : ''].filter(Boolean).join(' · ') }}
                    </span>
                  </span>
                  <span class="badge badge-gray tabular-nums">{{ p.facts }}</span>
                </button>
              </li>
              <li v-if="shownProjects.length === 0" class="px-3 py-3 text-sm text-zinc-500">{{ t('No projects in the memory yet.') }}</li>
            </ul>
          </div>
        </nav>

        <section class="min-w-0 space-y-4">
          <div class="card space-y-3">
            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 class="text-lg font-semibold">{{ isPersonal ? t('About me') : (project?.name ?? selected) }}</h2>
              <span class="mono break-all text-zinc-500 dark:text-zinc-400">{{ selected }}</span>
            </div>
            <p v-if="isPersonal" class="help">
              {{ t('Who you are and how to work with you. What is pinned or marked important is added to every chat; the rest when a task brings it up. A fact about one project belongs in that project: move it there.') }}
            </p>

            <template v-if="project">
              <p v-if="project.roots.length" class="text-xs text-zinc-500 dark:text-zinc-400">
                {{ t('Folders:') }} <span v-for="r in project.roots" :key="r" class="mono mr-2">{{ r }}</span>
              </p>
              <div v-if="project.aliases.length" class="text-sm">
                <span class="label inline">{{ t('Older memories of this project (still read):') }}</span>
                <span v-for="a in project.aliases" :key="a.id" class="badge badge-gray mono ml-1.5">
                  {{ a.id }} · {{ a.facts }}
                  <button type="button" class="ml-1.5 hover:text-red-600" :title="t('Make it a separate project again')" :disabled="busy" @click="split(a.id)">✕</button>
                </span>
              </div>
              <div class="flex flex-wrap items-center gap-1.5 text-sm">
                <span class="label inline">{{ t('Related projects:') }}</span>
                <span v-if="project.related.length === 0" class="text-zinc-500 dark:text-zinc-400">{{ t('none') }}</span>
                <span v-for="r in project.related" :key="r" class="badge badge-indigo">
                  <a :href="`#/memory/${encodeURIComponent(r)}`" class="hover:underline" @click.prevent="open(r)">{{ projectName(r) }}</a>
                  <button type="button" class="ml-1.5 hover:text-red-600" :title="t('Remove the relation')" :disabled="busy" @click="unrelate(r)">✕</button>
                </span>
                <select v-model="addRelated" class="input !w-44" :aria-label="t('Relate a project')" :disabled="busy" @change="relate">
                  <option value="">{{ t('+ relate a project') }}</option>
                  <option v-for="p in relatedChoices" :key="p.id" :value="p.id">{{ p.name }}</option>
                </select>
              </div>
              <p class="help">
                {{ t('A task in this project that needs to know something about a related one gets that project’s notes. A relation also appears by itself when a chat here names the other project.') }}
              </p>
              <div class="flex flex-wrap items-center gap-1.5 text-sm">
                <span class="label inline">{{ t('The same project as:') }}</span>
                <select v-model="mergeInto" class="input !w-44" :aria-label="t('Join to a project')" :disabled="busy">
                  <option value="">{{ t('choose a project') }}</option>
                  <option v-for="p in mergeChoices" :key="p.id" :value="p.id">{{ p.name }}</option>
                </select>
                <button type="button" class="btn btn-sm" :disabled="busy || !mergeInto" @click="merge">{{ t('Join') }}</button>
              </div>
            </template>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <button type="button" class="btn btn-primary" :disabled="busy" @click="edit(null)">{{ t('Add a fact') }}</button>
            <input v-model="search" type="search" class="input !w-56" :placeholder="t('Search in the facts')" autocomplete="off" />
            <select v-model="typeFilter" class="input !w-40" :aria-label="t('Fact type')">
              <option value="">{{ t('all types') }}</option>
              <option v-for="type in TYPES" :key="type" :value="type">{{ typeLabel(type) }}</option>
            </select>
            <label class="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-300">
              <input v-model="showRetired" type="checkbox" /> {{ t('show retired') }}
            </label>
            <span class="text-sm text-zinc-500 dark:text-zinc-400">{{ t('Total: {n}', { n: knowledge.length }) }}</span>
          </div>

          <p v-if="loadingFacts && factsFor !== selected" class="text-sm text-zinc-500">{{ t('Loading…') }}</p>
          <p v-else-if="knowledge.length === 0 && chatNotes.length === 0" class="card text-sm text-zinc-600 dark:text-zinc-300">
            {{ search || typeFilter ? t('Nothing matches.') : t('Nothing is stored here yet. Facts appear by themselves as you work: the mod reads each chat’s dialog every few turns and keeps what is durable.') }}
          </p>

          <ul v-if="knowledge.length" class="space-y-2">
            <li v-for="fact in knowledge" :key="`${fact.memory}/${fact.id}`" class="card !p-3">
              <p class="text-sm">{{ fact.text }}</p>
              <div class="mt-2 flex flex-wrap items-center gap-1.5">
                <span class="badge badge-gray">{{ typeLabel(fact.type) }}</span>
                <span v-if="fact.pinned" class="badge badge-indigo">{{ t('pinned') }}</span>
                <span v-if="fact.importance !== 'normal'" class="badge" :class="fact.importance === 'low' ? 'badge-gray' : 'badge-amber'">{{ levelLabel(fact.importance) }}</span>
                <span v-if="fact.auto" class="badge badge-gray" :title="t('Saved by the mod from a dialog')">{{ t('auto') }}</span>
                <span v-if="fact.memory !== selected" class="badge badge-gray mono" :title="t('Stored in an older memory of this project')">{{ fact.memory }}</span>
                <span class="text-xs text-zinc-500 dark:text-zinc-400">{{ day(fact.updatedAt || fact.createdAt) }}</span>
                <span class="ml-auto flex gap-1.5">
                  <button type="button" class="btn btn-sm" :disabled="busy" @click="togglePin(fact)">{{ fact.pinned ? t('Unpin') : t('Pin') }}</button>
                  <button type="button" class="btn btn-sm" :disabled="busy" @click="edit(fact)">{{ t('Edit') }}</button>
                  <button type="button" class="btn btn-sm" :disabled="busy" @click="moving = { fact, to: '' }">{{ t('Move') }}</button>
                  <button type="button" class="btn btn-danger btn-sm" :disabled="busy" @click="removeFact(fact)">{{ t('Delete') }}</button>
                </span>
              </div>
            </li>
          </ul>

          <template v-if="chatNotes.length">
            <h3 class="text-sm font-semibold">{{ t('Notes of the chats on this project') }}</h3>
            <p class="help !mt-0">{{ t('One per chat: what it did, decided and left open. The next chat on the project gets the last three.') }}</p>
            <ul class="space-y-2">
              <li v-for="fact in chatNotes" :key="`${fact.memory}/${fact.id}`" class="card flex flex-wrap items-start gap-3 !p-3">
                <span class="shrink-0 text-xs text-zinc-500 tabular-nums dark:text-zinc-400">{{ day(fact.updatedAt || fact.createdAt) }}</span>
                <p class="min-w-0 flex-1 text-sm">{{ fact.text }}</p>
                <button type="button" class="btn btn-danger btn-sm" :disabled="busy" @click="removeFact(fact)">{{ t('Delete') }}</button>
              </li>
            </ul>
          </template>

          <template v-if="showRetired && retired.length">
            <h3 class="text-sm font-semibold">{{ t('Retired (replaced or removed; not recalled)') }}</h3>
            <ul class="space-y-2">
              <li v-for="fact in retired" :key="`${fact.memory}/${fact.id}`" class="card !p-3 opacity-70">
                <p class="text-sm">{{ fact.text }}</p>
                <div class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                  <span class="badge badge-gray">{{ fact.status }}</span>
                  <span>{{ day(fact.updatedAt || fact.createdAt) }}</span>
                </div>
              </li>
            </ul>
          </template>
        </section>
      </div>
    </template>

    <Modal v-if="editor" :title="editor.fact ? t('Edit the fact') : t('New fact')" @close="editor = null">
      <form class="space-y-3" @submit.prevent="saveFact">
        <div>
          <label class="label" for="m-text">{{ t('The fact, in one sentence') }}</label>
          <textarea id="m-text" v-model="editor.text" class="input mt-1 min-h-28" :maxlength="MAX_CHARS" required />
          <p class="help">
            {{ t('{n} of {max} characters. Write it so that it still makes sense in a year: name the thing and give the reason.', { n: editor.text.length, max: MAX_CHARS }) }}
          </p>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="label" for="m-type">{{ t('Type') }}</label>
            <select id="m-type" v-model="editor.type" class="input mt-1">
              <option v-for="type in TYPES" :key="type" :value="type">{{ typeLabel(type) }}</option>
            </select>
          </div>
          <div>
            <label class="label" for="m-level">{{ t('Importance') }}</label>
            <select id="m-level" v-model="editor.importance" class="input mt-1">
              <option v-for="level in LEVELS" :key="level" :value="level">{{ levelLabel(level) }}</option>
            </select>
          </div>
        </div>
        <label class="flex items-center gap-2 text-sm"><input v-model="editor.pinned" type="checkbox" /> {{ t('Pinned: always recalled') }}</label>
      </form>
      <template #footer>
        <button type="button" class="btn" @click="editor = null">{{ t('Cancel') }}</button>
        <button type="button" class="btn btn-primary" :disabled="busy || editor.text.trim().length < 8" @click="saveFact">{{ t('Save') }}</button>
      </template>
    </Modal>

    <Modal v-if="moving" :title="t('Move the fact')" @close="moving = null">
      <p class="text-sm">{{ moving.fact.text }}</p>
      <label class="label mt-3" for="m-move">{{ t('Where to') }}</label>
      <select id="m-move" v-model="moving.to" class="input mt-1">
        <option value="">{{ t('choose a memory') }}</option>
        <option v-for="c in moveChoices" :key="c.id" :value="c.id">{{ c.label }}</option>
      </select>
      <template #footer>
        <button type="button" class="btn" @click="moving = null">{{ t('Cancel') }}</button>
        <button type="button" class="btn btn-primary" :disabled="busy || !moving.to" @click="moveFact">{{ t('Move') }}</button>
      </template>
    </Modal>
  </div>
</template>
