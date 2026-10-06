<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import { api, type ByModel, type CompactReason, type LedgerEntry, type Stats, type Tokens, type TrimOutcome } from '../api.ts';
import {
  effortOrder,
  fmtNum,
  fmtP,
  fmtMoney,
  fmtPct,
  fmtTime,
  fmtUsd,
  modelEffort,
  moneyTone,
  projectName,
} from '../format.ts';
import { t } from '../i18n/index.ts';
import Meter from './Meter.vue';

const periods = [{ days: 1 }, { days: 7 }, { days: 30 }];

function periodLabel(n: number): string {
  switch (n) {
    case 1:
      return t('1 day');
    case 7:
      return t('7 days');
    default:
      return t('30 days');
  }
}

const days = ref(7);
const stats = ref<Stats | null>(null);
const decisions = ref<LedgerEntry[]>([]);
const loaded = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

async function load(): Promise<void> {
  try {
    const [s, turns, subs] = await Promise.all([
      api.stats(days.value),
      api.ledger(days.value, 30, 'turn'),
      api.ledger(days.value, 30, 'subagent'),
    ]);
    stats.value = s;
    decisions.value = [...turns.entries, ...subs.entries].sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 30);
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
watch(days, () => void load());

const modelRows = [
  { key: 'sonnet', dot: 'bg-sky-500' },
  { key: 'opus', dot: 'bg-violet-500' },
  { key: 'other', dot: 'bg-zinc-400' },
] as const;

function modelLabel(key: (typeof modelRows)[number]['key']): string {
  switch (key) {
    case 'sonnet':
      return 'Sonnet';
    case 'opus':
      return 'Opus';
    default:
      return t('Other');
  }
}

function segments(by: ByModel<number>) {
  return modelRows.map((m) => ({ value: by[m.key], class: m.dot, label: modelLabel(m.key) }));
}

function share(n: number, total: number): string {
  return total > 0 ? fmtPct(n / total) : '—';
}

const turnEfforts = computed(() => {
  const by = stats.value?.turns.byEffort ?? {};
  const keys = [...new Set([...effortOrder.slice(0, 5), ...Object.keys(by)])].sort(
    (a, b) => effortOrder.indexOf(a) - effortOrder.indexOf(b),
  );
  const max = Math.max(1, ...keys.map((k) => by[k] ?? 0));
  return keys
    .filter((k) => (by[k] ?? 0) > 0 || effortOrder.slice(0, 5).includes(k))
    .map((k) => ({ key: k, count: by[k] ?? 0, width: ((by[k] ?? 0) / max) * 100 }));
});

const hasTokens = (tok: Tokens): boolean => tok.input + tok.output + tok.cacheRead + tok.cacheWrite > 0;

const tokenGroups = computed(() => {
  const usage = stats.value?.usage;
  if (!usage) return [];
  return [
    { title: t('Main chat'), data: usage.main },
    { title: t('Subagents'), data: usage.subagent },
  ].map((group) => ({
    title: group.title,
    rows: modelRows
      .map((m) => ({ label: modelLabel(m.key), dot: m.dot, tokens: group.data[m.key] }))
      .filter((row) => hasTokens(row.tokens)),
  }));
});

const compactReasons: { key: CompactReason }[] = [{ key: 'engine' }, { key: 'threshold' }, { key: 'window' }, { key: 'return' }];

function compactReasonLabel(key: CompactReason): string {
  switch (key) {
    case 'engine':
      return 'Claude Code';
    case 'threshold':
      return t('When the context fills up');
    case 'window':
      return t('Mid-turn and in subagents');
    default:
      return t('On return after a pause');
  }
}

const trimOutcomes: { key: TrimOutcome; badge: string }[] = [
  { key: 'passed', badge: 'badge-green' },
  { key: 'failed', badge: 'badge-red' },
  { key: 'build-error', badge: 'badge-red' },
  { key: 'error', badge: 'badge-amber' },
  { key: 'unknown', badge: 'badge-gray' },
];

/** Tokens as `193k`, a dash for none. */
const ctxText = (n: number | undefined): string => (n ? `${Math.round(n / 1000)}k` : '—');

function trimOutcomeLabel(key: TrimOutcome): string {
  switch (key) {
    case 'passed':
      return t('tests passed');
    case 'failed':
      return t('tests failed');
    case 'build-error':
      return t('build error');
    case 'error':
      return t('command failed');
    default:
      return t('no outcome');
  }
}

/** The savings card: what the mod saved against what the managed turns would have cost without it. */
const savings = computed(() => {
  const s = stats.value?.savings;
  if (!s) return null;
  const share = s.withoutMod > 0 ? (s.exact + s.estimated) / s.withoutMod : null;
  return { ...s, share: share === null ? '—' : fmtPct(share, Math.abs(share) < 0.1 ? 1 : 0) };
});

const rate = computed(() => stats.value?.rate);
const rateText = computed(() => {
  const r = rate.value;
  if (!r || (r.fiveHour === null && r.sevenDay === null)) return '';
  const parts: string[] = [];
  if (r.fiveHour !== null) parts.push(t('5h {pct}%', { pct: Math.round(r.fiveHour) }));
  if (r.sevenDay !== null) parts.push(t('7d {pct}%', { pct: Math.round(r.sevenDay) }));
  return t('Limits: {parts}', { parts: parts.join(' · ') });
});

function where(e: LedgerEntry): string {
  if (e.kind === 'turn') return t('Main');
  return t('Subagent · {type}', { type: e.agent ?? e.subagentType ?? t('no type') });
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-center gap-3">
      <div class="inline-flex overflow-hidden rounded-lg border border-zinc-300 dark:border-zinc-700" role="group" :aria-label="t('Period')">
        <button
          v-for="p in periods"
          :key="p.days"
          type="button"
          class="px-3 py-1.5 text-sm font-medium transition"
          :class="
            days === p.days
              ? 'bg-indigo-600 text-white'
              : 'bg-white text-zinc-700 hover:bg-zinc-100 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800'
          "
          @click="days = p.days"
        >
          {{ periodLabel(p.days) }}
        </button>
      </div>
      <span v-if="rateText" class="badge badge-gray text-sm" :title="rate?.ts ? t('Updated {time}', { time: fmtTime(rate.ts) }) : ''">
        {{ rateText }}
      </span>
      <span class="text-xs text-zinc-500 dark:text-zinc-400">{{ t('Updates every 10 seconds') }}</span>
    </div>

    <p v-if="!loaded" class="text-sm text-zinc-500">{{ t('Loading…') }}</p>

    <p
      v-else-if="stats && stats.entries === 0"
      class="card text-sm text-zinc-600 dark:text-zinc-300"
    >
      {{ t('The journal is empty for the selected period.') }}
      {{ t('Entries appear when the mod runs in an open Claude Code session (the journal is kept even in shadow mode).') }}
    </p>

    <template v-if="stats">
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <a
          v-if="savings"
          href="#/savings"
          class="card block transition hover:border-indigo-300 dark:hover:border-indigo-700"
          :aria-label="t('Savings: open the detailed report')"
        >
          <h3 class="card-title">{{ t('Savings') }}</h3>
          <p class="text-3xl font-semibold tabular-nums" :class="moneyTone(savings.net)">{{ fmtMoney(savings.net) }}</p>
          <p class="help mt-0.5">{{ t('net benefit for the period: exact + estimate − Jev') }}</p>
          <dl class="mt-3 space-y-1 text-sm">
            <div class="flex justify-between gap-2">
              <dt class="text-zinc-500 dark:text-zinc-400">{{ t('Exact') }}</dt>
              <dd class="tabular-nums" :class="moneyTone(savings.exact)">{{ fmtMoney(savings.exact) }}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-zinc-500 dark:text-zinc-400">{{ t('Plus estimated') }}</dt>
              <dd class="tabular-nums" :class="moneyTone(savings.estimated)">≈ {{ fmtMoney(savings.estimated) }}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-zinc-500 dark:text-zinc-400">{{ t('Spent on Jev') }}</dt>
              <dd class="tabular-nums">{{ fmtMoney(savings.jev) }}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-zinc-500 dark:text-zinc-400">{{ t('Of the cost without the mod') }}</dt>
              <dd class="tabular-nums">{{ t('{share} of ≈ {total}', { share: savings.share, total: fmtMoney(savings.withoutMod) }) }}</dd>
            </div>
          </dl>
          <p class="mt-2 text-xs font-medium text-indigo-700 dark:text-indigo-300">{{ t('More →') }}</p>
        </a>

        <section class="card">
          <h3 class="card-title">{{ t('Main chat turns') }}</h3>
          <p class="text-3xl font-semibold tabular-nums">{{ fmtNum(stats.turns.count) }}</p>
          <Meter class="mt-3" :segments="segments(stats.turns.byModel)" />
          <ul class="mt-3 space-y-1 text-sm">
            <li v-for="m in modelRows" :key="m.key" class="flex items-center gap-2">
              <span class="inline-block size-2.5 rounded-full" :class="m.dot" />
              <span class="flex-1">{{ modelLabel(m.key) }}</span>
              <span class="tabular-nums">{{ stats.turns.byModel[m.key] }}</span>
              <span class="w-12 text-right text-zinc-500 tabular-nums dark:text-zinc-400">
                {{ share(stats.turns.byModel[m.key], stats.turns.count) }}
              </span>
            </li>
          </ul>
          <p v-if="stats.turns.shadow > 0" class="help">
            {{ t('+ {n} in shadow mode (not counted)', { n: stats.turns.shadow }) }}
          </p>
        </section>

        <section class="card">
          <h3 class="card-title">{{ t('Model switches') }}</h3>
          <p class="text-3xl font-semibold tabular-nums">{{ fmtNum(stats.turns.switches) }}</p>
          <p class="help">
            {{
              t('{share} turns. Each switch resets the prompt cache, so the mod makes one only where it is cheap.', {
                share: share(stats.turns.switches, stats.turns.count),
              })
            }}
          </p>
        </section>

        <section class="card">
          <h3 class="card-title">{{ t('Effort in the main chat') }}</h3>
          <ul class="space-y-1.5 text-sm">
            <li v-for="row in turnEfforts" :key="row.key" class="flex items-center gap-2">
              <span class="w-16 shrink-0">{{ row.key }}</span>
              <div class="h-2.5 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div class="h-full rounded-full bg-indigo-500" :style="{ width: `${row.width}%` }" />
              </div>
              <span class="w-10 text-right tabular-nums">{{ row.count }}</span>
            </li>
          </ul>
        </section>

        <section class="card">
          <h3 class="card-title">{{ t('Subagents') }}</h3>
          <p class="text-3xl font-semibold tabular-nums">{{ fmtNum(stats.subagents.count) }}</p>
          <Meter class="mt-3" :segments="segments(stats.subagents.byModel)" />
          <ul class="mt-3 space-y-1 text-sm">
            <li v-for="m in modelRows" :key="m.key" class="flex items-center gap-2">
              <span class="inline-block size-2.5 rounded-full" :class="m.dot" />
              <span class="flex-1">{{ modelLabel(m.key) }}</span>
              <span class="tabular-nums">{{ stats.subagents.byModel[m.key] }}</span>
            </li>
          </ul>
          <p v-if="stats.subagents.shadow > 0" class="help">
            {{ t('+ {n} in shadow mode (not counted)', { n: stats.subagents.shadow }) }}
          </p>
          <div v-if="stats.subagents.byAgent.length" class="mt-3 border-t border-zinc-200 pt-2 dark:border-zinc-800">
            <p class="mb-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400">{{ t('Most frequent') }}</p>
            <ul class="space-y-0.5 text-sm">
              <li v-for="a in stats.subagents.byAgent" :key="a.agent" class="flex gap-2">
                <span class="mono min-w-0 flex-1 truncate">{{ a.agent }}</span>
                <span class="tabular-nums">{{ a.count }}</span>
              </li>
            </ul>
          </div>
        </section>

        <section class="card">
          <h3 class="card-title">{{ t('Jev costs') }}</h3>
          <p class="text-3xl font-semibold tabular-nums">{{ fmtUsd(stats.jev.cost) }}</p>
          <dl class="mt-3 space-y-1 text-sm">
            <div class="flex justify-between gap-2">
              <dt class="text-zinc-500 dark:text-zinc-400">{{ t('Requests') }}</dt>
              <dd class="tabular-nums">{{ fmtNum(stats.jev.requests) }}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-zinc-500 dark:text-zinc-400">{{ t('Average latency') }}</dt>
              <dd class="tabular-nums">{{ stats.jev.avgMs ? t('{n} ms', { n: stats.jev.avgMs }) : '—' }}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-zinc-500 dark:text-zinc-400">{{ t('Average per request') }}</dt>
              <dd class="tabular-nums">{{ stats.jev.requests ? fmtUsd(stats.jev.cost / stats.jev.requests) : '—' }}</dd>
            </div>
          </dl>
        </section>

        <section class="card">
          <h3 class="card-title">{{ t('Context compaction') }}</h3>
          <p class="text-3xl font-semibold tabular-nums">{{ fmtNum(stats.compactions.ok + stats.compactions.fallback) }}</p>
          <dl class="mt-3 space-y-1 text-sm">
            <div class="flex justify-between gap-2">
              <dt class="text-zinc-500 dark:text-zinc-400">{{ t('Succeeded (via Jev)') }}</dt>
              <dd class="tabular-nums">{{ stats.compactions.ok }}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-zinc-500 dark:text-zinc-400">{{ t('Fell back to the built-in one') }}</dt>
              <dd class="tabular-nums">{{ stats.compactions.fallback }}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-zinc-500 dark:text-zinc-400">{{ t('Average savings') }}</dt>
              <dd class="tabular-nums">{{ stats.compactions.ok ? fmtPct(stats.compactions.avgRatio) : '—' }}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-zinc-500 dark:text-zinc-400">{{ t('Of them in subagents') }}</dt>
              <dd class="tabular-nums">{{ stats.compactions.subagent ?? 0 }}</dd>
            </div>
            <div
              class="flex justify-between gap-2"
              :title="t('What one model request carries on average: the main lever of cost, since every request re-reads it. Before the mod, the main chat averaged about 430k.')"
            >
              <dt class="text-zinc-500 dark:text-zinc-400">{{ t('Context per request') }}</dt>
              <dd class="tabular-nums">
                {{ ctxText(stats.compactions.contextPerRequest?.main) }} · {{ t('subagents') }} {{ ctxText(stats.compactions.contextPerRequest?.subagent) }}
              </dd>
            </div>
          </dl>
          <div class="mt-3 border-t border-zinc-200 pt-2 dark:border-zinc-800">
            <p class="mb-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400">{{ t('Triggered by') }}</p>
            <ul class="space-y-0.5 text-sm">
              <li v-for="r in compactReasons" :key="r.key" class="flex gap-2">
                <span class="min-w-0 flex-1">{{ compactReasonLabel(r.key) }}</span>
                <span class="tabular-nums">{{ stats.compactions.byReason[r.key] }}</span>
              </li>
            </ul>
          </div>
        </section>

        <section class="card">
          <h3 class="card-title">{{ t('Agents created') }}</h3>
          <p class="text-3xl font-semibold tabular-nums">{{ fmtNum(stats.agentsCreated) }}</p>
          <p class="help">{{ t('Specialists the mod created itself when no suitable one was found.') }}</p>
        </section>

        <section class="card">
          <h3 class="card-title">{{ t('Errors') }}</h3>
          <p
            class="text-3xl font-semibold tabular-nums"
            :class="stats.errors > 0 ? 'text-amber-600 dark:text-amber-400' : ''"
          >
            {{ fmtNum(stats.errors) }}
          </p>
          <p class="help">{{ t('Jev timeouts, draft failures and the like. See the “Journal” tab for details.') }}</p>
        </section>

        <section class="card">
          <h3 class="card-title">{{ t('Output trimming') }}</h3>
          <p class="text-3xl font-semibold tabular-nums">{{ fmtNum(stats.trims.applied) }}</p>
          <dl class="mt-3 space-y-1 text-sm">
            <div class="flex justify-between gap-2">
              <dt class="text-zinc-500 dark:text-zinc-400">{{ t('Saved') }}</dt>
              <dd class="tabular-nums">
                {{ stats.trims.applied ? t('{n} chars ({pct})', { n: fmtNum(stats.trims.saved), pct: fmtPct(stats.trims.savedPct) }) : '—' }}
              </dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-zinc-500 dark:text-zinc-400">{{ t('Before → after') }}</dt>
              <dd class="tabular-nums">
                {{ stats.trims.applied ? `${fmtNum(stats.trims.charsBefore)} → ${fmtNum(stats.trims.charsAfter)}` : '—' }}
              </dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-zinc-500 dark:text-zinc-400">{{ t('Chunks returned by Jev') }}</dt>
              <dd class="tabular-nums">{{ fmtNum(stats.trims.jevChunks) }}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-zinc-500 dark:text-zinc-400">{{ t('Left whole (would have saved little)') }}</dt>
              <dd class="tabular-nums">{{ fmtNum(stats.trims.skipped ?? 0) }}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-zinc-500 dark:text-zinc-400">{{ t('In shadow mode') }}</dt>
              <dd class="tabular-nums">{{ fmtNum(stats.trims.shadow) }}</dd>
            </div>
          </dl>
          <div v-if="stats.trims.applied" class="mt-3 flex flex-wrap gap-1.5 border-t border-zinc-200 pt-2 dark:border-zinc-800">
            <template v-for="o in trimOutcomes" :key="o.key">
              <span v-if="stats.trims.byOutcome[o.key] > 0" class="badge" :class="o.badge">
                {{ trimOutcomeLabel(o.key) }} · {{ stats.trims.byOutcome[o.key] }}
              </span>
            </template>
          </div>
          <p class="help">
            {{ t('Large test and build outputs and long listings (ls, du, ps, find) are trimmed before they reach the chat; the full output stays in a file.') }}
            {{ t('File reads (cat, sed, Read) are left alone: that is code Claude asked for itself. So the share of all outputs is small.') }}
            {{ t('Trims in shadow mode and outputs left whole are not counted in the total.') }}
          </p>
        </section>

        <section class="card sm:col-span-2 lg:col-span-3">
          <h3 class="card-title">{{ t('Tokens by model') }}</h3>
          <p v-if="tokenGroups.every((g) => g.rows.length === 0)" class="text-sm text-zinc-500 dark:text-zinc-400">
            {{ t('No usage data for the period.') }}
          </p>
          <div v-else class="grid gap-4 md:grid-cols-2">
            <div v-for="group in tokenGroups" :key="group.title" class="min-w-0">
              <p class="mb-1 text-sm font-medium">{{ group.title }}</p>
              <p v-if="group.rows.length === 0" class="text-sm text-zinc-500 dark:text-zinc-400">—</p>
              <div v-else class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr>
                      <th class="th pl-0">{{ t('Model') }}</th>
                      <th class="th text-right">input</th>
                      <th class="th text-right">output</th>
                      <th class="th text-right">cache read</th>
                      <th class="th text-right">cache write</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in group.rows" :key="row.label" class="border-t border-zinc-200 dark:border-zinc-800">
                      <td class="td pl-0">
                        <span class="mr-1.5 inline-block size-2.5 rounded-full" :class="row.dot" />{{ row.label }}
                      </td>
                      <td class="td text-right tabular-nums">{{ fmtNum(row.tokens.input) }}</td>
                      <td class="td text-right tabular-nums">{{ fmtNum(row.tokens.output) }}</td>
                      <td class="td text-right tabular-nums">{{ fmtNum(row.tokens.cacheRead) }}</td>
                      <td class="td text-right tabular-nums">{{ fmtNum(row.tokens.cacheWrite) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>
      </div>

      <section>
        <h2 class="mb-2 text-sm font-semibold">{{ t('Recent decisions') }}</h2>
        <div class="card overflow-x-auto p-0">
          <table class="w-full min-w-[56rem] text-sm">
            <thead class="border-b border-zinc-200 dark:border-zinc-800">
              <tr>
                <th class="th">{{ t('Time') }}</th>
                <th class="th">{{ t('Where') }}</th>
                <th class="th">{{ t('Project') }}</th>
                <th class="th">{{ t('Text') }}</th>
                <th class="th">{{ t('Model · effort') }}</th>
                <th class="th text-right">P(opus)</th>
                <th class="th">{{ t('Reasons') }}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-zinc-200 dark:divide-zinc-800">
              <tr v-if="decisions.length === 0">
                <td class="td text-zinc-500 dark:text-zinc-400" colspan="7">{{ t('No decisions for the period.') }}</td>
              </tr>
              <tr v-for="(e, i) in decisions" :key="`${e.ts}-${e.session}-${i}`">
                <td class="td whitespace-nowrap tabular-nums">{{ fmtTime(e.ts) }}</td>
                <td class="td">
                  <span class="whitespace-nowrap">{{ where(e) }}</span>
                  <span v-if="e.created" class="badge badge-indigo ml-1">{{ t('created') }}</span>
                  <span v-if="e.applied === false" class="badge badge-amber ml-1">{{ t('shadow') }}</span>
                </td>
                <td class="td whitespace-nowrap" :title="e.project">{{ projectName(e.project) }}</td>
                <td class="td max-w-64 min-w-40">
                  <span class="line-clamp-2 break-words" :title="e.text">{{ e.text ?? '—' }}</span>
                </td>
                <td class="td whitespace-nowrap">
                  {{ modelEffort(e) }}
                  <span v-if="e.switched" class="badge badge-gray ml-1" :title="t('Model switched')">↔</span>
                </td>
                <td class="td text-right tabular-nums">{{ fmtP(e.pStrong) }}</td>
                <td class="td max-w-72 min-w-48">
                  <span class="line-clamp-2 text-xs text-zinc-600 dark:text-zinc-400" :title="e.reasons?.join('; ')">
                    {{ e.reasons?.join('; ') || '—' }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
