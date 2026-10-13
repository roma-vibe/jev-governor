<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import { api, type ProjectSummary, type SavingEvent, type SavingSource, type SavingsRow, type SavingsView } from '../api.ts';
import { fmtMoney, fmtPct, fmtSigned, fmtTime, moneyTone, projectName } from '../format.ts';
import { locale, t } from '../i18n/index.ts';
import { describeEvent, familyLabel, getSources, sourceLabel } from '../savings.ts';
import { store } from '../store.ts';

const periods = computed(() =>
  [1, 7, 30].map((n) => ({ days: n, label: t('{n} {n#day|days}', { n }) })),
);

const days = ref(7);
const data = ref<SavingsView | null>(null);
const projectList = ref<ProjectSummary[]>([]);
const loaded = ref(false);
const filter = ref<SavingEvent['source'] | 'all'>('all');
const shown = ref(50);
let timer: ReturnType<typeof setInterval> | undefined;
let request = 0;

async function load(): Promise<void> {
  const mine = ++request;
  try {
    const next = await api.savings(days.value);
    if (mine !== request) return;
    data.value = next;
    loaded.value = true;
  } catch {
    // the header shows the lost connection; keep the last data
  }
}

onMounted(() => {
  void load();
  // Only to link a project row to its page; the report works without it.
  if (store.config?.projects.enabled !== false) api.projects().then(
    (list) => (projectList.value = list),
    () => undefined,
  );
  timer = setInterval(() => void load(), 15_000);
});
onUnmounted(() => clearInterval(timer));
watch(days, () => void load());
watch(filter, () => (shown.value = 50));

// ---- top cards

const totals = computed(() => data.value?.totals);
/** Share of what the managed turns would have cost without the mod's context work. */
const savedShare = computed(() => (totals.value && totals.value.withoutMod > 0 ? totals.value.net / totals.value.withoutMod : null));
const shareText = computed(() => {
  const share = savedShare.value;
  return share === null ? '—' : fmtPct(share, Math.abs(share) < 0.1 ? 1 : 0);
});

const cards = computed(() => {
  const tot = totals.value;
  if (!tot) return [];
  return [
    {
      label: t('Saved'),
      value: `${tot.estimated !== 0 ? '≈ ' : ''}${fmtMoney(tot.saved)}`,
      tone: moneyTone(tot.saved),
      sub: t('compaction, trimming, tools behind ToolSearch'),
      title: t('What the mod removed from the context, priced on the model that actually ran: the removed tokens × the requests that would have re-read them, minus what had to be written to the cache again.'),
    },
    {
      label: t('Spent by the mod'),
      value: fmtMoney(tot.spent),
      tone: '',
      sub: t('Jev {jev} · own model calls {calls}', { jev: fmtMoney(tot.jev), calls: fmtMoney(tot.calls) }),
      title: t('Requests to Jev and the model calls the mod makes itself: specialist drafts and merges, saving facts from the dialog, command descriptions, handoff briefs.'),
    },
    {
      label: t('Net benefit'),
      value: fmtMoney(tot.net),
      tone: moneyTone(tot.net),
      sub: t('saved − spent by the mod'),
      title: t('Saved minus what the mod spent.'),
    },
    {
      label: t('Actual cost'),
      value: fmtMoney(tot.actual),
      tone: '',
      sub: t('{n} {n#turn|turns} managed by the mod', { n: tot.turns }),
      title: t('What the tokens of the turns the mod managed cost (excluding shadow mode), on the models they ran on.'),
    },
    {
      label: t('Without the mod it would be ≈'),
      value: `≈ ${fmtMoney(tot.withoutMod)}`,
      tone: '',
      sub: savedShare.value === null ? t('no data') : t('net savings {share}', { share: shareText.value }),
      title: t('Actual cost + saved: the same turns on the same models, without compaction, trimming and deferred tools. The percentage is the net benefit of this sum.'),
    },
    {
      label: t('Removed from the context'),
      value: tot.tokensRemoved.toLocaleString(locale()),
      tone: '',
      sub: t('tokens, by compaction and trimming'),
      title: t('Tokens the mod took out of the context; each of them would otherwise have been re-read by every later request.'),
    },
  ];
});

// ---- routing: which models and efforts ran, not priced against anything

const routing = computed(() => {
  const r = data.value?.routing;
  if (!r) return [];
  const block = (rows: typeof r.main, label: string) => {
    const sum = rows.reduce((a, x) => a + x.cost, 0);
    return { label, rows: rows.map((x) => ({ ...x, name: `${familyLabel(x.model)}${x.effort ? ` · ${x.effort}` : ''}`, share: sum > 0 ? x.cost / sum : 0 })) };
  };
  return [block(r.main, t('Main chat')), block(r.subagent, t('Subagents'))].filter((b) => b.rows.length > 0);
});

// ---- what the managed turns cost, by token kind

const costKinds = () =>
  [
    { key: 'cacheRead', label: t('Cache read'), hint: t('every step re-reads the whole context; one price for Opus and Sonnet; the levers are context size and the number of steps') },
    { key: 'cacheWrite', label: t('Cache write'), hint: t('what is new in the context and the rewrite after a model change or a cooled cache; the levers are model, compaction, trimming') },
    { key: 'output', label: t('Output'), hint: t('the model’s answers and reasoning; the levers are model and effort level') },
    { key: 'input', label: t('Uncached input'), hint: t('usually a tiny share') },
  ] as const;

const costRows = computed(() => {
  const c = totals.value?.cost;
  if (!c) return [];
  const sum = c.input + c.output + c.cacheRead + c.cacheWrite;
  return costKinds().map((k) => ({ ...k, value: c[k.key], share: sum > 0 ? c[k.key] / sum : 0 }));
});

const empty = computed(() => !!data.value && data.value.totals.turns === 0 && data.value.eventCount === 0);

// ---- by source: diverging bars around a zero line

const FILL_GAIN = 'bg-emerald-500 dark:bg-emerald-500';
const FILL_LOSS = 'bg-red-500 dark:bg-red-500';

type Bar = { left: number; width: number; cls: string };

/** Never thinner than a visible sliver, never past the track. */
function sliver(left: number, width: number): { left: number; width: number } {
  const w = Math.min(100, Math.max(width, 0.7));
  return { left: Math.min(Math.max(0, left), 100 - w), width: w };
}

const sourceRows = computed(() => {
  const tot = totals.value;
  const d = data.value;
  if (!tot || !d) return { zero: 0, rows: [] };
  const rows = getSources().map((s) => {
    const value = tot.bySource[s.key];
    const est = d.estimatedBySource[s.key];
    // The sums are added up in a different order on the server: compare with a tolerance.
    const onlyEstimate = value !== 0 && Math.abs(est - value) < 1e-9;
    return { ...s, value, est, onlyEstimate, partlyEstimate: !onlyEstimate && Math.abs(est) >= 1e-9 };
  });
  const maxGain = Math.max(0, ...rows.map((r) => r.value));
  const maxLoss = Math.max(0, ...rows.map((r) => -r.value));
  const span = maxGain + maxLoss || 1;
  const zero = (maxLoss / span) * 100;
  return {
    zero,
    rows: rows.map((r) => {
      const width = (Math.abs(r.value) / span) * 100;
      const bar: Bar | null =
        r.value === 0
          ? null
          : { ...sliver(r.value > 0 ? zero : zero - width, width), cls: `${r.value > 0 ? FILL_GAIN : FILL_LOSS}${r.onlyEstimate ? ' hatch' : ''}` };
      return { ...r, bar };
    }),
  };
});

// ---- by day

const dayRows = computed(() => {
  const d = data.value;
  if (!d) return [];
  const gain = (v: number) => Math.max(0, v);
  const loss = (v: number) => Math.max(0, -v);
  const maxGain = Math.max(0, ...d.byDay.map((x) => gain(x.exact) + gain(x.estimated)));
  const maxLoss = Math.max(0, ...d.byDay.map((x) => Math.max(loss(x.exact) + loss(x.estimated), x.spent)));
  const span = maxGain + maxLoss || 1;
  const zero = (maxLoss / span) * 100;
  return [...d.byDay]
    .reverse()
    .map((x) => {
      const bars: Bar[] = [];
      let up = zero;
      let down = zero;
      for (const part of [
        { v: x.exact, estimate: false },
        { v: x.estimated, estimate: true },
      ]) {
        if (part.v === 0) continue;
        const width = (Math.abs(part.v) / span) * 100;
        const cls = `${part.v > 0 ? FILL_GAIN : FILL_LOSS}${part.estimate ? ' hatch opacity-60' : ''}`;
        if (part.v > 0) {
          bars.push({ ...sliver(up, width), cls });
          up += width;
        } else {
          down -= width;
          bars.push({ ...sliver(down, width), cls });
        }
      }
      const spentWidth = (x.spent / span) * 100;
      return {
        day: x.day,
        label: dayLabel(x.day),
        x,
        zero,
        bars,
        spent: x.spent > 0 ? sliver(zero - spentWidth, spentWidth) : null,
      };
    });
});

function dayLabel(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString(locale(), { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
}

// ---- by project

type ProjectLine = SavingsRow & { name: string; label: string; href?: string };

const projectRows = computed<ProjectLine[]>(() => {
  const by = data.value?.byProject;
  if (!by) return [];
  return Object.entries(by)
    .map(([name, row]) => {
      // A folder name shared by several projects cannot be linked.
      const same = projectList.value.filter((p) => p.name === name);
      return {
        ...row,
        name,
        label: name === '' ? t('no project') : projectName(name),
        ...(same.length === 1 ? { href: `#/projects/${encodeURIComponent(same[0]!.id)}` } : {}),
      };
    })
    .sort((a, b) => b.exact + b.estimated - (a.exact + a.estimated) || b.actual - a.actual);
});

// ---- events

const filters = computed(() => {
  const events = data.value?.events ?? [];
  const count = (key: SavingSource) => events.filter((e) => e.source === key).length;
  return [
    { key: 'all' as const, label: t('All'), count: events.length },
    ...getSources().map((s) => ({ key: s.key, label: sourceLabel(s.key), count: count(s.key) })),
  ];
});

const filtered = computed(() => (data.value?.events ?? []).filter((e) => filter.value === 'all' || e.source === filter.value));
const visibleEvents = computed(() => filtered.value.slice(0, shown.value));
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
          {{ p.label }}
        </button>
      </div>
      <span class="text-xs text-zinc-500 dark:text-zinc-400">{{ t('Dollar amounts at API list prices · refreshes every 15 seconds') }}</span>
    </div>

    <p v-if="!loaded" class="text-sm text-zinc-500">{{ t('Loading…') }}</p>

    <template v-else-if="data && totals">
      <p v-if="empty" class="card text-sm text-zinc-600 dark:text-zinc-300">
        {{
          t('There is nothing to count for the selected period: either the journal is empty, or the mod ran only in shadow mode (it changes nothing there, so there are no savings). Spending on Jev is still counted.')
        }}
      </p>

      <ul class="grid grid-cols-2 gap-3 lg:grid-cols-3" :aria-label="t('Totals')">
        <li v-for="c in cards" :key="c.label" class="card p-3!" :title="c.title">
          <p class="text-xs text-zinc-500 dark:text-zinc-400">{{ c.label }}</p>
          <p class="mt-1 text-xl font-semibold tabular-nums sm:text-2xl" :class="c.tone">{{ c.value }}</p>
          <p class="mt-1 text-xs leading-snug text-zinc-500 dark:text-zinc-400">{{ c.sub }}</p>
        </li>
      </ul>

      <section v-if="costRows.length > 0 && totals.actual > 0" class="card" :aria-label="t('Cost breakdown')">
        <h3 class="card-title">{{ t('Cost breakdown') }} · {{ fmtMoney(totals.actual) }}</h3>
        <ul class="space-y-3">
          <li v-for="row in costRows" :key="row.key">
            <div class="flex items-baseline justify-between gap-3 text-sm">
              <span>{{ row.label }}</span>
              <span class="font-medium whitespace-nowrap tabular-nums">{{ fmtMoney(row.value) }} · {{ fmtPct(row.share) }}</span>
            </div>
            <div class="mt-1 h-2.5 rounded-full bg-zinc-200 dark:bg-zinc-800">
              <div class="h-full rounded-full bg-indigo-500" :style="{ width: `${Math.max(row.share > 0 ? 1 : 0, row.share * 100)}%` }" />
            </div>
            <p class="help">{{ row.hint }}</p>
          </li>
        </ul>
      </section>

      <details class="card">
        <summary class="cursor-pointer text-sm font-medium">{{ t('How it is calculated') }}</summary>
        <div class="mt-3 space-y-2 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
          <p>
            {{
              t('This is the API dollar equivalent at Anthropic’s list prices: Opus 5.5 is $4 / $20 per million input and output tokens, Sonnet 5.5 is $2 / $10, cache read is $0.20, cache write is 1.25× (5 minutes) or 2× (1 hour) of the input price. Subscription limits are used up in proportion to the same tokens, so dollars also show the limit savings well.')
            }}
          </p>
          <p>
            <b>{{ t('Model and effort are not counted.') }}</b>
            {{ t('Which model and effort a turn ran on is taken as given: you could have chosen them yourself, so the choice is neither a saving nor a cost. Every amount below is priced on the model that actually did the work; the models and efforts are shown apart, for orientation.') }}
          </p>
          <p>
            <b>{{ t('Saved') }}</b>:
            {{
              t('compaction and trimming: the removed tokens × the number of later requests that would have re-read them from the cache, minus what had to be written to the cache again. Tools behind ToolSearch: their definitions left the start of every later request of that chat.')
            }}
            {{ t('Compactions that Claude Code asked for count as estimates: the mod did them itself, and the summary that would have cost money was not needed.') }}
          </p>
          <p>
            <b>{{ t('Spent by the mod') }}</b>:
            {{
              t('requests to Jev and the mod’s own model calls (specialist drafts and merges, saving facts from the dialog, command descriptions, handoff briefs) are deducted (“Net benefit” = saved − spent). They cost money in any mode and are always counted. Sessions in shadow mode are not part of the savings or the “Actual cost”: the mod changed nothing there.')
            }}
          </p>
          <p>
            {{ t('Not counted in dollars, because it cannot be measured without a second run: what long-term memory spared the model from re-exploring, and the subagent cache note.') }}
          </p>
        </div>
      </details>

      <section class="card" :aria-label="t('By source')">
        <h3 class="card-title">{{ t('By source') }}</h3>
        <ul class="space-y-3">
          <li v-for="row in sourceRows.rows" :key="row.key">
            <div class="flex items-baseline justify-between gap-3 text-sm">
              <span>{{ row.label }}</span>
              <span class="font-medium whitespace-nowrap tabular-nums" :class="moneyTone(row.value)">
                {{ row.onlyEstimate ? '≈ ' : '' }}{{ fmtSigned(row.value) }}
              </span>
            </div>
            <div class="relative mt-1 h-2.5 rounded-full bg-zinc-200 dark:bg-zinc-800">
              <div
                v-if="row.bar"
                class="absolute inset-y-0 rounded-full"
                :class="row.bar.cls"
                :style="{ left: `${row.bar.left}%`, width: `${row.bar.width}%` }"
              />
              <div class="absolute -inset-y-0.5 w-px bg-zinc-500 dark:bg-zinc-400" :style="{ left: `${sourceRows.zero}%` }" />
            </div>
            <p v-if="row.partlyEstimate" class="help">
              {{ t('including ≈ {amount} estimated (compactions requested by Claude Code)', { amount: fmtSigned(row.est) }) }}
            </p>
          </li>
        </ul>
      </section>

      <section class="card" :aria-label="t('By day')">
        <div class="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 class="card-title mb-0">{{ t('By day') }}</h3>
          <p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400" aria-hidden="true">
            <span><i class="mr-1 inline-block h-2 w-3 rounded-sm bg-emerald-500 align-middle" />{{ t('exact') }}</span>
            <span><i class="hatch mr-1 inline-block h-2 w-3 rounded-sm bg-emerald-500 align-middle opacity-60" />{{ t('estimated') }}</span>
            <span><i class="mr-1 inline-block h-1 w-3 rounded-sm bg-red-600 align-middle" />{{ t('spent by the mod') }}</span>
          </p>
        </div>
        <p v-if="dayRows.length === 0" class="text-sm text-zinc-500 dark:text-zinc-400">{{ t('No data for the period.') }}</p>
        <ul v-else class="space-y-3">
          <li v-for="row in dayRows" :key="row.day">
            <div class="flex items-baseline justify-between gap-3 text-sm">
              <span class="font-medium tabular-nums">{{ row.label }}</span>
              <span class="text-xs text-zinc-500 tabular-nums dark:text-zinc-400">{{ t('cost {amount}', { amount: fmtMoney(row.x.actual) }) }}</span>
            </div>
            <div class="relative mt-1 h-3.5 rounded bg-zinc-100 dark:bg-zinc-800/70">
              <div
                v-for="(bar, i) in row.bars"
                :key="i"
                class="absolute inset-y-0"
                :class="bar.cls"
                :style="{ left: `${bar.left}%`, width: `${bar.width}%` }"
              />
              <div class="absolute -inset-y-0.5 w-px bg-zinc-500 dark:bg-zinc-400" :style="{ left: `${row.zero}%` }" />
            </div>
            <div class="relative h-1">
              <div
                v-if="row.spent"
                class="absolute inset-y-0 bg-red-600 dark:bg-red-500"
                :style="{ left: `${row.spent.left}%`, width: `${row.spent.width}%` }"
              />
            </div>
            <p class="mt-0.5 text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
              {{ t('exact') }} <span :class="moneyTone(row.x.exact)">{{ fmtSigned(row.x.exact) }}</span>
              · {{ t('estimated') }} <span :class="moneyTone(row.x.estimated)">≈ {{ fmtSigned(row.x.estimated) }}</span>
              · {{ t('spent by the mod') }} <span :class="row.x.spent > 0 ? moneyTone(-row.x.spent) : ''">{{ fmtSigned(-row.x.spent) }}</span>
            </p>
          </li>
        </ul>
      </section>

      <section v-if="routing.length > 0" class="card" :aria-label="t('Models and effort')">
        <h3 class="card-title">{{ t('Models and effort') }}</h3>
        <p class="help -mt-1 mb-3">{{ t('Where the turns ran and what they cost. For orientation only: not part of the savings.') }}</p>
        <div class="grid gap-4 md:grid-cols-2">
          <div v-for="b in routing" :key="b.label">
            <p class="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">{{ b.label }}</p>
            <table class="w-full text-sm">
              <tbody class="divide-y divide-zinc-200 dark:divide-zinc-800">
                <tr v-for="r in b.rows" :key="r.name">
                  <td class="py-1 pr-2">{{ r.name }}</td>
                  <td class="py-1 pr-2 text-right whitespace-nowrap text-zinc-500 tabular-nums dark:text-zinc-400">{{ t('{n} {n#turn|turns}', { n: r.turns }) }}</td>
                  <td class="py-1 text-right whitespace-nowrap tabular-nums">{{ fmtMoney(r.cost) }} · {{ fmtPct(r.share) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section v-if="projectRows.length > 0" class="card overflow-hidden p-0" :aria-label="t('By project')">
        <h3 class="card-title px-4 pt-4">{{ t('By project') }}</h3>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[28rem] text-sm">
            <thead class="border-b border-zinc-200 dark:border-zinc-800">
              <tr>
                <th class="th pl-4">{{ t('Project') }}</th>
                <th class="th text-right">{{ t('Exact') }}</th>
                <th class="th text-right">{{ t('Estimated') }}</th>
                <th class="th text-right">{{ t('Spent by the mod') }}</th>
                <th class="th pr-4 text-right">{{ t('Cost') }}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-zinc-200 dark:divide-zinc-800">
              <tr v-for="p in projectRows" :key="p.name">
                <td class="td pl-4 break-words">
                  <a v-if="p.href" :href="p.href" class="text-indigo-700 hover:underline dark:text-indigo-300">{{ p.label }}</a>
                  <span v-else :class="p.name === '' ? 'text-zinc-500 dark:text-zinc-400' : ''">{{ p.label }}</span>
                </td>
                <td class="td text-right whitespace-nowrap tabular-nums" :class="moneyTone(p.exact)">{{ fmtMoney(p.exact) }}</td>
                <td class="td text-right whitespace-nowrap tabular-nums" :class="moneyTone(p.estimated)">≈ {{ fmtMoney(p.estimated) }}</td>
                <td class="td text-right whitespace-nowrap tabular-nums">{{ fmtMoney(p.spent) }}</td>
                <td class="td pr-4 text-right whitespace-nowrap tabular-nums">{{ fmtMoney(p.actual) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section :aria-label="t('Events')">
        <div class="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h2 class="text-sm font-semibold">{{ t('Events') }}</h2>
          <div class="flex flex-wrap gap-1.5" role="group" :aria-label="t('Source')">
            <button
              v-for="f in filters"
              :key="f.key"
              type="button"
              class="badge text-xs transition"
              :class="filter === f.key ? 'badge-indigo' : 'badge-gray hover:bg-zinc-200 dark:hover:bg-zinc-700'"
              :aria-pressed="filter === f.key"
              @click="filter = f.key"
            >
              {{ f.label }} · {{ f.count }}
            </button>
          </div>
        </div>
        <div class="card overflow-x-auto p-0">
          <table class="w-full min-w-[38rem] text-sm">
            <thead class="border-b border-zinc-200 dark:border-zinc-800">
              <tr>
                <th class="th">{{ t('Time') }}</th>
                <th class="th">{{ t('Project') }}</th>
                <th class="th">{{ t('Source') }}</th>
                <th class="th">{{ t('What happened') }}</th>
                <th class="th text-right">{{ t('Amount') }}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-zinc-200 dark:divide-zinc-800">
              <tr v-if="visibleEvents.length === 0">
                <td class="td text-zinc-500 dark:text-zinc-400" colspan="5">{{ t('No events.') }}</td>
              </tr>
              <tr v-for="(e, i) in visibleEvents" :key="`${e.ts}-${e.session}-${e.source}-${i}`">
                <td class="td whitespace-nowrap tabular-nums">{{ fmtTime(e.ts) }}</td>
                <td class="td whitespace-nowrap" :title="e.project">{{ projectName(e.project) }}</td>
                <td class="td">
                  <span>{{ sourceLabel(e.source) }}</span>
                  <span
                    v-if="e.estimate"
                    class="badge badge-amber ml-1"
                    :title="t('An estimate, not a measurement')"
                  >
                    {{ t('estimate') }}
                  </span>
                  <span v-if="e.scope === 'subagent'" class="badge badge-gray ml-1">{{ t('subagent') }}</span>
                </td>
                <td class="td max-w-72 min-w-48">
                  {{ describeEvent(e).text }}
                  <span
                    v-if="describeEvent(e).detail"
                    class="block max-w-72 truncate text-xs text-zinc-500 dark:text-zinc-400"
                    :title="describeEvent(e).detail"
                  >
                    {{ describeEvent(e).detail }}
                  </span>
                </td>
                <td class="td text-right font-medium whitespace-nowrap tabular-nums" :class="moneyTone(e.amount)">
                  {{ e.estimate ? '≈ ' : '' }}{{ fmtSigned(e.amount) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
          <button v-if="filtered.length > shown" type="button" class="btn btn-sm" @click="shown += 100">{{ t('Show more') }}</button>
          <span>{{ t('Showing {shown} of {total}', { shown: visibleEvents.length, total: filtered.length }) }}</span>
          <span v-if="data.eventCount > data.events.length">
            · {{ t('only the last {shown} of {total} events are listed (totals cover all of them)', { shown: data.events.length, total: data.eventCount }) }}
          </span>
        </div>
      </section>
    </template>
  </div>
</template>
