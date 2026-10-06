// Russian text for the English keys used in the matching components.
export default {
  // savings.ts
  'Model choice': 'Выбор модели',
  'Effort level (estimate)': 'Уровень усилия (оценка)',
  'Jev': 'Jev',
  'Effort level': 'Уровень усилия',
  'at the threshold': 'по порогу',
  'after a pause': 'после паузы',
  'mid-turn or in a subagent': 'посреди хода или в субагенте',
  "instead of Claude Code's summary": 'вместо пересказа Claude Code',
  '{count} {n#token|tokens}': '{count} {n#токен|токена|токенов}',
  'would have been re-read {n} {n#time|times}': 'перечитали бы {n} {n#раз|раза|раз}',
  'turn {cost}': 'ход {cost}',
  'the model change rewrote the cache: {tokens}': 'смена модели переписала кэш: {tokens}',
  'quality surcharge': 'доплата за качество',
  '{to} instead of {from}': '{to} вместо {from}',
  'effort {from} → {to}': 'усилие {from} → {to}',
  'trimmed {tokens}': 'обрезано {tokens}',
  'compacted {tokens}': 'сжато {tokens}',
  'request to Jev': 'запрос к Jev',

  // Savings.vue
  'Saved (exact)': 'Сэкономлено точно',
  'measured from the journal: model, trimming, compaction': 'измерено по журналу: модель, обрезка, сжатие',
  'The same tokens at the prices of the model Claude Code would have used without the mod; trimming and compaction are counted by how many times the removed content would have had to be re-read. A negative number is a surcharge for quality (Opus instead of Sonnet).':
    'Те же токены по ценам модели, на которой работал бы Claude Code без мода; обрезка и сжатие считаются по тому, сколько раз убранное пришлось бы перечитывать. Отрицательное число — доплата за качество (Opus вместо Sonnet).',
  'estimate: lower effort and compaction without a Claude Code summary': 'оценка: меньше усилия и сжатие без пересказа Claude Code',
  'An estimate, not a measurement: at a lower effort level the model thinks and writes less, so the turn’s output is smaller by about the share set in “Savings calculation” per level (cache reads are not counted: effort barely moves them), and when Claude Code asked for compaction, the mod did it itself and the paid summary was not needed.':
    'Оценка, не измерение: на меньшем уровне усилия модель меньше думает и пишет, и вывод хода меньше примерно на долю «Расчёта экономии» за уровень (чтение кэша не считается: усилие его почти не меняет), а когда Claude Code просил сжатие, мод сделал его сам, и платный пересказ не понадобился.',
  'requests to Jev, deducted from the benefit': 'запросы к Jev, вычитаются из выгоды',
  'The cost of requests to Jev: model and effort decisions, trimming estimates.': 'Стоимость запросов к Jev: решения о модели и усилии, оценки обрезки.',
  'Net benefit': 'Чистая выгода',
  'exact + estimate − Jev': 'точно + оценка − Jev',
  'Saved (exact) + plus estimated − spent on Jev.': 'Сэкономлено точно + ещё по оценке − потрачено на Jev.',
  'Actual cost': 'Фактический расход',
  '{n} {n#turn|turns} managed by the mod': '{n} {n#ход|хода|ходов} под управлением мода',
  'What the tokens of the turns the mod managed cost (excluding shadow mode), at the same prices.':
    'Что стоили токены ходов, которыми мод управлял (без режима наблюдения), по тем же ценам.',
  'Without the mod it would be ≈': 'Без мода было бы ≈',
  'no data': 'нет данных',
  'savings {share} ({amount})': 'экономия {share} ({amount})',
  'Actual cost + saved (exact) + plus estimated. The percentage is the share saved (exact + estimate) of this sum; Jev is not deducted.':
    'Фактический расход + сэкономлено точно + ещё по оценке. Процент — доля сэкономленного (точно + оценка) от этой суммы, Jev не вычитается.',
  'Cache read': 'Чтение кэша',
  'every step re-reads the whole context; one price for Opus and Sonnet; the levers are context size and the number of steps':
    'каждый шаг перечитывает весь контекст; одна цена на Opus и Sonnet — рычаг: размер контекста и число шагов',
  'Cache write': 'Запись в кэш',
  'what is new in the context and the rewrite after a model change or a cooled cache; the levers are model, compaction, trimming':
    'новое в контексте и перезапись после смены модели или остывшего кэша — рычаги: модель, сжатие, обрезка',
  'the model’s answers and reasoning; the levers are model and effort level': 'ответы и рассуждения модели — рычаги: модель и уровень усилия',
  'Uncached input': 'Вход без кэша',
  'usually a tiny share': 'обычно крошечная доля',
  'no project': 'без проекта',
  'Dollar amounts at API list prices · refreshes every 15 seconds': 'Суммы в долларах по прайс-листу API · обновляется каждые 15 секунд',
  'There is nothing to count for the selected period: either the journal is empty, or the mod ran only in shadow mode (it changes nothing there, so there are no savings). Spending on Jev is still counted.':
    'За выбранный период нечего считать: либо журнал пуст, либо мод работал только в режиме наблюдения (там он ничего не меняет, поэтому экономии нет). Расходы на Jev при этом всё равно учитываются.',
  'Totals': 'Итоги',
  'was calculated from an assumption:': 'посчитано от допущения:',
  '{n} {n#turn has|turns have} no “without the mod” model and effort in the journal (written by older mod code), and for them it is assumed that without the mod it would have been':
    'у {n} {n#хода|ходов|ходов} в журнале нет модели и усилия «без мода» (их писал старый код мода), и для них принято, что без мода было бы',
  '(Settings, “Savings calculation” section). If you usually work at lower effort, the savings are overstated. Such rows in events are marked “assumption”.':
    '(настройки, раздел «Расчёт экономии»). Если вы обычно работаете с меньшим усилием, экономия завышена. Такие строки в событиях помечены «допущение».',
  'Cost breakdown': 'Из чего состоит расход',
  'How it is calculated': 'Как считается',
  'This is the API dollar equivalent at Anthropic’s list prices: Opus 5.5 is $4 / $20 per million input and output tokens, Sonnet 5.5 is $2 / $10, cache read is $0.20, cache write is 1.25× (5 minutes) or 2× (1 hour) of the input price. Subscription limits are used up in proportion to the same tokens, so dollars also show the limit savings well.':
    'Это эквивалент в долларах API по прайс-листу Anthropic: Opus 5.5 — $4 / $20 за миллион токенов на входе и выходе, Sonnet 5.5 — $2 / $10, чтение кэша — $0.20, запись в кэш — 1.25× (5 минут) или 2× (1 час) от входной цены. Лимиты подписки расходуются пропорционально тем же токенам, поэтому доллары хорошо показывают и экономию лимитов.',
  '(computed from the journal):': '(считается по журналу):',
  'the same turn tokens at the price of the model Claude Code would have used without the mod, minus their price on the model that did the work. A negative value is a surcharge for quality (Opus instead of Sonnet). For trimming and compaction: the removed tokens × the number of requests that would have re-read them from the cache, minus what had to be written to the cache again.':
    'те же токены ходов по цене модели, на которой работал бы Claude Code без мода, минус их цена на модели, которая отработала. Отрицательное значение — доплата за качество (Opus вместо Sonnet). Для обрезки и сжатия: убранные токены × число запросов, которые перечитывали бы их из кэша, минус то, что пришлось заново записать в кэш.',
  'Estimated': 'По оценке',
  'at a lower effort level the model thinks and writes less; one level ≈ {percent}% of the turn’s output (set in Settings, “Savings calculation” section). Only the output is counted: in long chats most of a turn is cache reads, which effort barely changes.':
    'на меньшем уровне усилия модель меньше думает и пишет; один уровень ≈ {percent}% вывода хода (задаётся в настройках, раздел «Расчёт экономии»). Считается только вывод: в длинных чатах большая часть хода — чтение кэша, его усилие почти не меняет.',
  'Compactions that Claude Code asked for also count as estimates: the mod did them itself, and the summary that would have cost money was not needed.':
    'К оценке относятся и сжатия, которые попросил Claude Code: мод сделал их сам, и пересказ, за который пришлось бы платить, не понадобился.',
  'the cost of requests to Jev is deducted from the benefit (“Net benefit” = exact + estimate − Jev). Requests to Jev cost money in any mode and are always counted. Sessions in shadow mode are not part of the savings or the “Actual cost”: the mod changed nothing there.':
    'стоимость запросов к Jev вычитается из выгоды («Чистая выгода» = точно + оценка − Jev). Запросы к Jev стоят деньги в любом режиме и учитываются всегда. Сессии в режиме наблюдения в экономию и «Фактический расход» не входят: мод там ничего не менял.',
  'By source': 'По источникам',
  'including ≈ {amount} estimated (compactions requested by Claude Code)': 'в том числе ≈ {amount} по оценке (сжатия по просьбе Claude Code)',
  'By day': 'По дням',
  'exact': 'точно',
  'estimated': 'по оценке',
  'No data for the period.': 'Нет данных за период.',
  'cost {amount}': 'расход {amount}',
  'By project': 'По проектам',
  'Cost': 'Расход',
  'Events': 'События',
  'Source': 'Источник',
  'What happened': 'Что произошло',
  'Amount': 'Сумма',
  'No events.': 'Событий нет.',
  'An estimate, not a measurement': 'Оценка, а не измерение',
  'estimate': 'оценка',
  'The journal has no “without the mod” model and effort: assumed {base}': 'В журнале нет модели и усилия «без мода»: принято {base}',
  'assumption': 'допущение',
  'subagent': 'субагент',
  'Show more': 'Показать ещё',
  'only the last {shown} of {total} events are listed (totals cover all of them)': 'в списке последние {shown} из {total} событий (итоги считаются по всем)',
} as Record<string, string>;
