<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import { api, type LedgerEntry, type LedgerKind } from '../api.ts';
import { entryKeys, fmtNum, fmtP, fmtPct, fmtTime, fmtUsd, modelEffort, modelName, projectName } from '../format.ts';
import { locale, t } from '../i18n/index.ts';

type Col = { label: string; cell: (e: LedgerEntry) => string; right?: boolean; wide?: boolean; mono?: boolean; badge?: boolean };

const kinds = computed<{ value: LedgerKind | ''; label: string }[]>(() => [
  { value: '', label: t('All') },
  { value: 'turn', label: t('turn: turns') },
  { value: 'subagent', label: t('subagent: subagents') },
  { value: 'usage', label: t('usage: tokens') },
  { value: 'compact', label: t('compact: compaction') },
  { value: 'agent-created', label: t('agent-created: new agents') },
  { value: 'trim', label: t('trim: output trimming') },
  { value: 'output-read', label: t('output-read: reads of saved outputs') },
  { value: 'command', label: t('command: Claude commands in projects') },
  { value: 'handoff', label: t('handoff: context handoff to a new chat') },
  { value: 'hint', label: t('hint: new chat hints') },
  { value: 'override', label: t('override: your /model and effort changes') },
  { value: 'chat', label: t('chat: /jevg chat and /jevg idle in a chat') },
  { value: 'light-up', label: t('light-up: a light subagent moved to the standard model') },
  { value: 'rerun-after-prune', label: t('rerun-after-prune: rerun of what compaction removed') },
  { value: 'redacted', label: t('redacted: secrets removed from requests to Jev') },
  { value: 'window', label: t('window: auto-compaction window per session') },
  { value: 'error', label: t('error: errors') },
]);

const kind = ref<LedgerKind | ''>('');
const days = ref(7);
const limit = ref(500);
const search = ref('');
const entries = ref<LedgerEntry[]>([]);
const total = ref(0);
const loaded = ref(false);
const expanded = ref<Set<string>>(new Set());
let timer: ReturnType<typeof setInterval> | undefined;

async function load(): Promise<void> {
  try {
    const result = await api.ledger(days.value, limit.value, kind.value || undefined);
    entries.value = result.entries;
    total.value = result.total;
    loaded.value = true;
  } catch {
    // the header shows the lost connection; keep the last data
  }
}

onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 10_000);
});
onUnmounted(() => clearInterval(timer));
watch([kind, days, limit], () => void load());

const reasons = (e: LedgerEntry): string => e.reasons?.join('; ') ?? '';
function compactReason(reason: 'engine' | 'threshold' | 'return' | 'window' | undefined): string {
  switch (reason ?? 'engine') {
    case 'threshold':
      return t('threshold');
    case 'window':
      return t('mid-turn window');
    case 'return':
      return t('on return');
    default:
      return 'Claude Code';
  }
}
const exact = (n: number): string => n.toLocaleString(locale());
/** «tool · command → charsBefore→charsAfter · outcome» */
function trimSummary(e: LedgerEntry): string {
  const tr = e.trim;
  if (!tr) return '';
  const what = [tr.tool, tr.command].filter(Boolean).join(' · ');
  const persisted = tr.persisted ? ` · ${t('from a Claude Code file ({n} characters instead of the preview)', { n: exact(tr.fullChars ?? 0) })}` : '';
  return `${what} → ${exact(tr.charsBefore)}→${exact(tr.charsAfter)}${tr.outcome ? ` · ${tr.outcome}` : ''}${persisted}`;
}
const trimSaved = (e: LedgerEntry): string =>
  e.trim && e.trim.charsBefore > 0 ? fmtPct(Math.max(0, e.trim.charsBefore - e.trim.charsAfter) / e.trim.charsBefore) : '—';
const trimLines = (e: LedgerEntry): string =>
  e.trim ? `${exact(e.trim.linesBefore)}→${exact(e.trim.linesAfter)}` : '';

const columns = computed<Col[]>(() => {
  const time: Col = { label: t('Time'), cell: (e) => fmtTime(e.ts) };
  const project: Col = { label: t('Project'), cell: (e) => projectName(e.project) };
  const text: Col = { label: t('Text'), cell: (e) => e.text ?? '', wide: true };
  const pStrong: Col = { label: 'P(opus)', cell: (e) => fmtP(e.pStrong), right: true };
  const jev: Col = {
    label: 'Jev',
    cell: (e) =>
      [e.jevMs !== undefined ? t('{n} ms', { n: e.jevMs }) : '', typeof e.jevCost === 'number' ? fmtUsd(e.jevCost) : '']
        .filter(Boolean)
        .join(' · '),
  };
  const subagentOf = (name: string | undefined): string => t('subagent {agent}', { agent: name ?? '' }).trim();
  switch (kind.value) {
    case 'turn':
      return [
        time,
        project,
        text,
        { label: t('Model'), cell: (e) => (e.prevModel && e.switched ? `${modelName(e.prevModel)} → ${modelName(e.model)}` : modelName(e.model)) },
        { label: 'Effort', cell: (e) => e.effort ?? '—' },
        pStrong,
        { label: t('Effort score'), cell: (e) => fmtP(e.effortScore), right: true },
        { label: t('Risk'), cell: (e) => fmtP(e.risky), right: true },
        { label: t('Cont.'), cell: (e) => fmtP(e.continuation), right: true },
        { label: t('Pressure'), cell: (e) => (e.pressure === undefined ? '—' : String(e.pressure)), right: true },
        jev,
        { label: t('Reasons'), cell: reasons, wide: true },
      ];
    case 'subagent':
      return [
        time,
        project,
        { label: t('Agent'), cell: (e) => e.agent ?? '—', mono: true },
        { label: t('Type'), cell: (e) => e.subagentType ?? '—', mono: true },
        text,
        { label: t('Model · effort'), cell: modelEffort },
        pStrong,
        { label: t('Created'), cell: (e) => (e.created ? t('yes') : '') },
        jev,
        { label: t('Reasons'), cell: reasons, wide: true },
      ];
    case 'usage':
      return [
        time,
        { label: t('Where'), cell: (e) => (e.scope === 'subagent' ? subagentOf(e.agent) : t('main')) },
        project,
        { label: t('Model'), cell: (e) => modelName(e.usage?.model) },
        { label: 'input', cell: (e) => fmtNum(e.usage?.input ?? 0), right: true },
        { label: 'output', cell: (e) => fmtNum(e.usage?.output ?? 0), right: true },
        { label: 'cache read', cell: (e) => fmtNum(e.usage?.cacheRead ?? 0), right: true },
        { label: 'cache write', cell: (e) => fmtNum(e.usage?.cacheWrite ?? 0), right: true },
      ];
    case 'compact':
      return [
        time,
        project,
        { label: t('Result'), cell: (e) => (e.compaction?.fallback ? t('rolled back') : t('compacted')) },
        { label: t('Reason'), cell: (e) => compactReason(e.compaction?.reason) },
        { label: t('Characters before'), cell: (e) => fmtNum(e.compaction?.charsBefore ?? 0), right: true },
        { label: t('after'), cell: (e) => fmtNum(e.compaction?.charsAfter ?? 0), right: true },
        { label: t('Savings'), cell: (e) => (e.compaction ? fmtPct(e.compaction.ratio) : '—'), right: true },
        { label: t('Requests'), cell: (e) => String(e.compaction?.requests ?? '—'), right: true },
        { label: t('Description'), cell: (e) => e.compaction?.fallback ?? e.text ?? '', wide: true },
      ];
    case 'agent-created':
      return [
        time,
        project,
        { label: t('Agent'), cell: (e) => e.agent ?? '—', mono: true },
        text,
        { label: t('Skills and notes'), cell: reasons, wide: true },
      ];
    case 'trim':
      return [
        time,
        project,
        { label: t('Output'), cell: trimSummary, wide: true },
        { label: t('Savings'), cell: trimSaved, right: true },
        { label: t('Lines'), cell: trimLines, right: true },
        { label: t('Jev chunks'), cell: (e) => (e.trim ? String(e.trim.jevChunks) : '—'), right: true },
      ];
    case 'error':
      return [time, project, { label: t('Error'), cell: (e) => e.error ?? '', wide: true }, text];
    default:
      return [
        time,
        { label: t('Type'), cell: (e) => e.kind, badge: true },
        { label: t('Where'), cell: (e) => (e.scope === 'subagent' ? subagentOf(e.agent ?? e.subagentType) : e.scope === 'main' ? t('main') : '') },
        project,
        text,
        { label: t('Model · effort'), cell: (e) => (e.model ? modelEffort(e) : e.usage ? modelName(e.usage.model) : '') },
        { label: t('Details'), cell: details, wide: true },
      ];
  }
});

function details(e: LedgerEntry): string {
  switch (e.kind) {
    case 'turn':
    case 'subagent':
      return [
        e.local ? t('without Jev') : '',
        e.pStrong !== undefined ? `P(opus) ${fmtP(e.pStrong)}` : '',
        e.correction !== undefined && e.correction >= 0.5 ? t('correction {value}', { value: fmtP(e.correction) }) : '',
        reasons(e),
      ]
        .filter(Boolean)
        .join(' · ');
    case 'override':
      return reasons(e);
    case 'usage':
      return e.usage ? `in ${fmtNum(e.usage.input)} · out ${fmtNum(e.usage.output)} · cache ${fmtNum(e.usage.cacheRead)}/${fmtNum(e.usage.cacheWrite)}` : '';
    case 'compact':
      return e.compaction
        ? [
            e.compaction.fallback
              ? t('rollback: {reason}', { reason: e.compaction.fallback })
              : t('savings {value}', { value: fmtPct(e.compaction.ratio) }),
            compactReason(e.compaction.reason),
            e.compaction.archived !== undefined ? t('archived {n}', { n: e.compaction.archived }) : '',
            e.compaction.restored ? t('restored by the limit {n}', { n: e.compaction.restored }) : '',
            e.compaction.via === 'command' ? t('via /compact') : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : '';
    case 'agent-created':
      return [e.agent, reasons(e)].filter(Boolean).join(' · ');
    case 'trim':
      return trimSummary(e);
    case 'output-read':
      return e.text ?? '';
    case 'command':
      return [e.command, e.dir ? t('in {dir}', { dir: e.dir }) : '', e.success === false ? t('failed') : ''].filter(Boolean).join(' · ');
    case 'handoff':
      if (e.handoff?.action === 'cancel')
        return `${t('handoff cancelled (/jevg fresh), capsule {id}', { id: e.handoff.id })}${e.text ? ` · ${e.text.replace(/^fresh cancelled: /, '')}` : ''}`;
      return e.handoff
        ? [
            e.handoff.action === 'create'
              ? `${t('capsule {id}', { id: e.handoff.id })}${e.handoff.fresh ? ' (/jevg fresh)' : ''}`
              : e.handoff.action === 'clear'
                ? t('chat cleared for {id}', { id: e.handoff.id })
                : t('{id} attached', { id: e.handoff.id }),
            e.handoff.sourceTokens
              ? t('{n} tokens of {source}', { n: fmtNum(e.handoff.tokens), source: fmtNum(e.handoff.sourceTokens) })
              : t('{n} tokens', { n: fmtNum(e.handoff.tokens) }),
            e.handoff.turns !== undefined ? t('turns {n}', { n: e.handoff.turns }) : '',
            e.handoff.action === 'create'
              ? t('brief {brief}, Jev {jev}', { brief: e.handoff.brief ? t('yes') : t('no'), jev: e.handoff.jev ? t('yes') : t('no') })
              : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : '';
    case 'hint':
      return [e.newTopic !== undefined ? t('P(new task) {value}', { value: fmtP(e.newTopic) }) : '', reasons(e)].filter(Boolean).join(' · ');
    case 'light-up':
      return reasons(e);
    case 'chat':
      return [e.text ?? '', reasons(e)].filter(Boolean).join(' · ');
    case 'rerun-after-prune':
      return t('rerun after compaction: {text}', { text: e.text ?? '' });
    case 'redacted':
      return t('replaced with [secret]: {count} · request: {text}', { count: e.count ?? 0, text: e.text ?? '' });
    case 'window':
      return [
        e.text ?? '',
        e.autoWindow?.tokens ? t('Claude Code measures against {n}', { n: fmtNum(e.autoWindow.tokens) }) : '',
        e.autoWindow?.source ? t('source {source}', { source: e.autoWindow.source }) : '',
      ]
        .filter(Boolean)
        .join(' · ');
    case 'error':
      return e.error ?? '';
  }
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return q ? entries.value.filter((e) => JSON.stringify(e).toLowerCase().includes(q)) : entries.value;
});
const keys = computed(() => entryKeys(filtered.value));

const kindBadge: Record<string, string> = {
  turn: 'badge-indigo',
  subagent: 'badge-green',
  usage: 'badge-gray',
  compact: 'badge-amber',
  'agent-created': 'badge-indigo',
  trim: 'badge-green',
  'output-read': 'badge-amber',
  command: 'badge-gray',
  handoff: 'badge-indigo',
  hint: 'badge-amber',
  redacted: 'badge-gray',
  chat: 'badge-indigo',
  'light-up': 'badge-amber',
  'rerun-after-prune': 'badge-amber',
  override: 'badge-indigo',
  window: 'badge-gray',
  error: 'badge-red',
};

function toggle(key: string): void {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded.value = next;
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-end gap-3">
      <div>
        <label class="label" for="j-kind">{{ t('Entry type') }}</label>
        <select id="j-kind" v-model="kind" class="input w-auto">
          <option v-for="k in kinds" :key="k.value" :value="k.value">{{ k.label }}</option>
        </select>
      </div>
      <div>
        <label class="label" for="j-days">{{ t('Period') }}</label>
        <select id="j-days" v-model.number="days" class="input w-auto">
          <option :value="1">{{ t('{n} {n#day|days}', { n: 1 }) }}</option>
          <option :value="7">{{ t('{n} {n#day|days}', { n: 7 }) }}</option>
          <option :value="30">{{ t('{n} {n#day|days}', { n: 30 }) }}</option>
        </select>
      </div>
      <div>
        <label class="label" for="j-limit">{{ t('Entries') }}</label>
        <select id="j-limit" v-model.number="limit" class="input w-auto">
          <option :value="200">200</option>
          <option :value="500">500</option>
          <option :value="1000">1000</option>
        </select>
      </div>
      <div class="min-w-48 flex-1">
        <label class="label" for="j-search">{{ t('Search text') }}</label>
        <input id="j-search" v-model="search" type="search" class="input" :placeholder="t('project, text, model, reason…')" />
      </div>
    </div>

    <p class="text-xs text-zinc-500 dark:text-zinc-400">
      {{ t('Showing {shown} of {total}', { shown: filtered.length, total }) }}{{ search ? ' ' + t('(search among loaded)') : '' }} ·
      {{ t('refreshes every 10 seconds') }} · {{ t('click a row to see the whole entry') }}
    </p>

    <p v-if="!loaded" class="text-sm text-zinc-500">{{ t('Loading…') }}</p>

    <div v-else class="card overflow-x-auto p-0">
      <table class="w-full min-w-[48rem] text-sm">
        <thead class="border-b border-zinc-200 dark:border-zinc-800">
          <tr>
            <th v-for="col in columns" :key="col.label" class="th" :class="col.right ? 'text-right' : ''">{{ col.label }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="filtered.length === 0">
            <td class="td text-zinc-500 dark:text-zinc-400" :colspan="columns.length">{{ t('No entries.') }}</td>
          </tr>
          <template v-for="(e, i) in filtered" :key="keys[i]">
            <tr
              class="cursor-pointer border-t border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50"
              :aria-expanded="expanded.has(keys[i]!)"
              tabindex="0"
              @click="toggle(keys[i]!)"
              @keydown.enter.prevent="toggle(keys[i]!)"
              @keydown.space.prevent="toggle(keys[i]!)"
            >
              <td
                v-for="(col, c) in columns"
                :key="col.label"
                class="td"
                :class="[col.right ? 'text-right tabular-nums' : '', col.mono ? 'mono' : '', col.wide ? 'max-w-80 min-w-44' : 'whitespace-nowrap']"
              >
                <span
                  v-if="col.badge"
                  class="badge"
                  :class="kindBadge[e.kind] ?? 'badge-gray'"
                >
                  {{ col.cell(e) }}
                </span>
                <span v-else :class="col.wide ? 'line-clamp-2 break-words' : ''" :title="col.wide ? col.cell(e) : undefined">
                  {{ col.cell(e) || '—' }}
                </span>
                <span v-if="c === 0 && e.applied === false" class="badge badge-amber ml-1">{{ t('observation') }}</span>
              </td>
            </tr>
            <tr v-if="expanded.has(keys[i]!)" class="bg-zinc-50 dark:bg-zinc-950">
              <td :colspan="columns.length" class="px-3 py-2">
                <pre class="mono max-h-80 overflow-auto break-words whitespace-pre-wrap">{{ JSON.stringify(e, null, 2) }}</pre>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>
