// Russian text for the English keys used in the matching components.
export default {
  // savings.ts
  'Tools behind ToolSearch': 'Инструменты за ToolSearch',
  'The mod’s own model calls': 'Собственные вызовы моделей',
  'Jev': 'Jev',
  'at the threshold': 'по порогу',
  'after a pause': 'после паузы',
  'mid-turn or in a subagent': 'посреди хода или в субагенте',
  "instead of Claude Code's summary": 'вместо пересказа Claude Code',
  'drafting a specialist': 'черновик специалиста',
  'merging specialists': 'слияние специалистов',
  'saving facts from the dialog': 'сохранение фактов из диалога',
  'checking the facts to save': 'проверка фактов перед сохранением',
  'describing project commands': 'описание команд проекта',
  'handoff brief': 'бриф для переноса',
  '{count} {n#token|tokens}': '{count} {n#токен|токена|токенов}',
  'would have been re-read {n} {n#time|times}': 'перечитали бы {n} {n#раз|раза|раз}',
  'trimmed {tokens}': 'обрезано {tokens}',
  'compacted {tokens}': 'сжато {tokens}',
  '{n} {n#tool|tools} behind ToolSearch, {tokens}': '{n} {n#инструмент|инструмента|инструментов} за ToolSearch, {tokens}',
  'out of {n} {n#request|requests}': 'не было в {n} {n#запросе|запросах|запросах}',
  'request to Jev': 'запрос к Jev',

  // Savings.vue
  'compaction, trimming, tools behind ToolSearch': 'сжатие, обрезка, инструменты за ToolSearch',
  'What the mod removed from the context, priced on the model that actually ran: the removed tokens × the requests that would have re-read them, minus what had to be written to the cache again.':
    'Что мод убрал из контекста, по ценам модели, которая реально работала: убранные токены × запросы, которые перечитывали бы их, минус то, что пришлось заново записать в кэш.',
  'Spent by the mod': 'Потратил мод',
  'spent by the mod': 'потратил мод',
  'Jev {jev} · own model calls {calls}': 'Jev {jev} · свои вызовы моделей {calls}',
  'Requests to Jev and the model calls the mod makes itself: specialist drafts and merges, saving facts from the dialog, command descriptions, handoff briefs.':
    'Запросы к Jev и вызовы моделей, которые мод делает сам: черновики и слияние специалистов, сохранение фактов из диалога, описания команд, брифы для переноса.',
  'Net benefit': 'Чистая выгода',
  'saved − spent by the mod': 'сэкономлено − потратил мод',
  'Saved minus what the mod spent.': 'Сэкономлено минус то, что потратил мод.',
  'Actual cost': 'Фактический расход',
  '{n} {n#turn|turns} managed by the mod': '{n} {n#ход|хода|ходов} под управлением мода',
  'What the tokens of the turns the mod managed cost (excluding shadow mode), on the models they ran on.':
    'Что стоили токены ходов, которыми мод управлял (без режима наблюдения), на тех моделях, на которых они шли.',
  'Without the mod it would be ≈': 'Без мода было бы ≈',
  'no data': 'нет данных',
  'net savings {share}': 'чистая экономия {share}',
  'Actual cost + saved: the same turns on the same models, without compaction, trimming and deferred tools. The percentage is the net benefit of this sum.':
    'Фактический расход + сэкономлено: те же ходы на тех же моделях, но без сжатия, обрезки и отложенных инструментов. Процент — чистая выгода от этой суммы.',
  'Removed from the context': 'Убрано из контекста',
  'tokens, by compaction and trimming': 'токенов — сжатием и обрезкой',
  'Tokens the mod took out of the context; each of them would otherwise have been re-read by every later request.':
    'Токены, которые мод убрал из контекста; иначе каждый из них перечитывался бы каждым следующим запросом.',
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
  'Cost breakdown': 'Из чего состоит расход',
  'How it is calculated': 'Как считается',
  'This is the API dollar equivalent at Anthropic’s list prices: Opus 5.5 is $4 / $20 per million input and output tokens, Sonnet 5.5 is $2 / $10, cache read is $0.20, cache write is 1.25× (5 minutes) or 2× (1 hour) of the input price. Subscription limits are used up in proportion to the same tokens, so dollars also show the limit savings well.':
    'Это эквивалент в долларах API по прайс-листу Anthropic: Opus 5.5 — $4 / $20 за миллион токенов на входе и выходе, Sonnet 5.5 — $2 / $10, чтение кэша — $0.20, запись в кэш — 1.25× (5 минут) или 2× (1 час) от входной цены. Лимиты подписки расходуются пропорционально тем же токенам, поэтому доллары хорошо показывают и экономию лимитов.',
  'Model and effort are not counted.': 'Модель и усилие не считаются.',
  'Which model and effort a turn ran on is taken as given: you could have chosen them yourself, so the choice is neither a saving nor a cost. Every amount below is priced on the model that actually did the work; the models and efforts are shown apart, for orientation.':
    'На какой модели и с каким усилием шёл ход — данность: их можно было выбрать и самому, поэтому выбор не экономия и не расход. Все суммы ниже считаются по цене модели, которая реально работала; модели и усилие показаны отдельно, для ориентира.',
  'compaction and trimming: the removed tokens × the number of later requests that would have re-read them from the cache, minus what had to be written to the cache again. Tools behind ToolSearch: their definitions left the start of every later request of that chat.':
    'сжатие и обрезка: убранные токены × число следующих запросов, которые перечитывали бы их из кэша, минус то, что пришлось заново записать в кэш. Инструменты за ToolSearch: их описания ушли из начала каждого следующего запроса этого чата.',
  'Compactions that Claude Code asked for count as estimates: the mod did them itself, and the summary that would have cost money was not needed.':
    'Сжатия, которые попросил Claude Code, считаются оценкой: мод сделал их сам, и пересказ, за который пришлось бы платить, не понадобился.',
  'requests to Jev and the mod’s own model calls (specialist drafts and merges, saving facts from the dialog, command descriptions, handoff briefs) are deducted (“Net benefit” = saved − spent). They cost money in any mode and are always counted. Sessions in shadow mode are not part of the savings or the “Actual cost”: the mod changed nothing there.':
    'запросы к Jev и собственные вызовы моделей мода (черновики и слияние специалистов, сохранение фактов из диалога, описания команд, брифы для переноса) вычитаются («Чистая выгода» = сэкономлено − потрачено). Они стоят денег в любом режиме и учитываются всегда. Сессии в режиме наблюдения в экономию и «Фактический расход» не входят: мод там ничего не менял.',
  'Not counted in dollars, because it cannot be measured without a second run: what long-term memory spared the model from re-exploring, and the subagent cache note.':
    'В долларах не считается, потому что без второго прогона это не измерить: что долговременная память избавила модель изучать заново, и заметка о кэше для субагентов.',
  'By source': 'По источникам',
  'including ≈ {amount} estimated (compactions requested by Claude Code)': 'в том числе ≈ {amount} по оценке (сжатия по просьбе Claude Code)',
  'By day': 'По дням',
  'exact': 'точно',
  'estimated': 'по оценке',
  'No data for the period.': 'Нет данных за период.',
  'cost {amount}': 'расход {amount}',
  'Models and effort': 'Модели и усилие',
  'Where the turns ran and what they cost. For orientation only: not part of the savings.': 'На чём шли ходы и сколько стоили. Только для ориентира: в экономию не входит.',
  '{n} {n#turn|turns}': '{n} {n#ход|хода|ходов}',
  'By project': 'По проектам',
  'Exact': 'Точно',
  'Estimated': 'По оценке',
  'Cost': 'Расход',
  'Events': 'События',
  'Source': 'Источник',
  'What happened': 'Что произошло',
  'Amount': 'Сумма',
  'No events.': 'Событий нет.',
  'An estimate, not a measurement': 'Оценка, а не измерение',
  'estimate': 'оценка',
  'subagent': 'субагент',
  'Show more': 'Показать ещё',
  'only the last {shown} of {total} events are listed (totals cover all of them)': 'в списке последние {shown} из {total} событий (итоги считаются по всем)',
} as Record<string, string>;
