// Settings page: section and field texts (settingsSchema.ts), Settings.vue, KeyBlock.vue.
export default {
  'Interface language': 'Язык интерфейса',
  'Language of this page. It applies after saving. Command descriptions have their own language setting in the Projects section.':
    'Язык этой страницы. Применяется после сохранения. У описаний команд своя настройка языка в разделе «Проекты».',
  'General': 'Общие',
  'Mod enabled': 'Мод включён',
  'Main switch. When off, the mod changes nothing in Claude Code: no model, no effort, no subagents, no compaction. The same switch is the “On” badge at the top of the page.':
    'Главный выключатель. Выключен — мод ничего не меняет в Claude Code: ни модель, ни effort, ни субагентов, ни сжатие. Тот же переключатель — значок «Включён» вверху страницы.',
  'Mode': 'Режим',
  'Active': 'Активный',
  'Shadow mode (only records decisions)': 'Наблюдение (только записывает решения)',
  'In shadow mode Jev still makes decisions and writes them to the journal, but changes nothing in Claude Code. This lets you evaluate the mod before turning it on: compare “what would have happened” with what you choose yourself. Jev requests cost the same as usual.':
    'В режиме наблюдения Jev по-прежнему принимает решения и пишет их в журнал, но Claude Code ничего не меняет. Так можно оценить мод до включения: сравнить «что было бы» с тем, что вы выбираете сами. Стоит запросов к Jev, как обычно.',
  'Shadow mode paths': 'Пути в режиме наблюдения',
  'One path per line (~ is allowed). Sessions whose working folder starts with such a path run in shadow mode; the rest follow “Mode”. Handy for trying the mod on one project without touching the others.':
    'По одному пути на строку (можно с ~). Сессии, чья рабочая папка начинается с такого пути, работают в режиме наблюдения, остальные — как задано в «Режиме». Удобно, чтобы проверить мод на одном проекте, не трогая остальные.',
  'Paths where the mod is always active': 'Пути, где мод всегда активен',
  'One path per line. Here the mod controls models even in shadow mode, and these paths take precedence over the list above. For example, shadow mode everywhere except the one project where you are testing the mod.':
    'По одному пути на строку. Здесь мод управляет моделями даже в режиме наблюдения, и эти пути важнее списка выше. Например, режим «наблюдение» везде, кроме одного проекта, на котором вы проверяете мод.',
  'Projects without Jev': 'Проекты без Jev',
  'One path per line. In these projects the mod sends nothing to Jev (OpenRouter): no model and effort choice, no compaction or trimming through Jev, no turn selection for the capsule. For third-party or work code. In other projects secrets (keys, tokens, passwords) are replaced with [secret] before sending anyway, but code and paths go out as they are.':
    'По одному пути на строку. В этих проектах мод ничего не отправляет в Jev (OpenRouter): нет выбора модели и effort, нет сжатия и обрезки через Jev, нет отбора ходов для капсулы. Для чужого или рабочего кода. В остальных проектах секреты (ключи, токены, пароли) и так заменяются на [secret] перед отправкой, но код и пути уходят как есть.',
  'Codex is coming in the next version.': 'Codex — в следующей версии.',
  'Models': 'Модели',
  'The mod chooses between two tiers. Change the identifiers only when new versions are released.':
    'Мод выбирает между двумя уровнями. Идентификаторы меняйте, только когда выходят новые версии.',
  'Standard tier (Sonnet)': 'Стандартный уровень (Sonnet)',
  'Model for tasks where Sonnet 5.5 is enough. Uses up subscription limits noticeably slower than Opus.':
    'Модель для задач, где хватает Sonnet 5.5. Расходует лимиты подписки заметно медленнее Opus.',
  'Strong tier (Opus)': 'Сильный уровень (Opus)',
  'Model for hard and risky tasks. Higher quality, limits are used up faster.':
    'Модель для сложных и рискованных задач. Качество выше, лимиты уходят быстрее.',
  'Thresholds are probabilities from Jev (0–1). Switching the model in the middle of a long chat resets the prompt cache and is expensive, so the mod switches freely only where the cache is cold or the context is small.':
    'Пороги — это вероятности от Jev (0–1). Смена модели посреди длинного диалога сбрасывает кэш промпта и стоит дорого, поэтому мод переключается свободно только там, где кэш холодный или контекст маленький.',
  'Choose the main chat model': 'Выбирать модель основного диалога',
  'Jev decides on every turn whether to use Sonnet or Opus. When off, the model stays the one you chose yourself.':
    'Jev решает на каждом ходе, Sonnet или Opus. Выключено — модель остаётся той, что вы выбрали сами.',
  'Choose effort every turn': 'Выбирать effort каждый ход',
  'Jev picks the reasoning depth for each turn. Changing effort does not reset the cache on Opus/Sonnet 5.5, so it is safe. When off, effort stays as it was.':
    'Jev подбирает глубину рассуждений на каждый ход. Смена effort не сбрасывает кэш на Opus/Sonnet 5.5, поэтому безопасна. Выключено — effort остаётся прежним.',
  'Threshold for switching to Opus': 'Порог перехода на Opus',
  'The probability from Jev that Opus is needed at which the main chat switches to Opus where the cache is cold or the context is small. A lower threshold means Opus more often (higher quality, limits spent faster); a higher one, less often.':
    'Вероятность от Jev, что нужна Opus, при которой основной диалог переключается на Opus там, где кэш холодный или контекст маленький. Ниже порог — чаще Opus (качество выше, лимиты тратятся быстрее); выше — реже.',
  'Threshold for forced switch to Opus': 'Порог принудительного перехода на Opus',
  'The probability that Opus is needed at which the chat switches even with a warm cache. This is expensive: the whole context is read again. A higher threshold means the mod breaks the cache less often, but stays on Sonnet longer where Opus is needed.':
    'Вероятность, что нужна Opus, при которой диалог переключается даже при тёплом кэше. Это дорого: весь контекст читается заново. Выше порог — мод реже ломает кэш, но дольше остаётся на Sonnet там, где нужна Opus.',
  'Threshold for returning to Sonnet': 'Порог возврата на Sonnet',
  'The probability that Sonnet is enough at which the chat returns from Opus to Sonnet (where that is cheap). A higher threshold is more cautious: you stay on Opus longer and spend more.':
    'Вероятность, что хватит Sonnet, при которой диалог возвращается с Opus на Sonnet (там, где это дёшево). Выше порог — осторожнее: дольше остаётесь на Opus и тратите больше.',
  'Cheap switch: context up to': 'Дешёвое переключение: контекст до',
  'tokens': 'токенов',
  'If the context is no larger than this, switching to Opus counts as cheap: there is almost nothing to lose in the cache. Switching to Sonnet is decided in dollars (setting below).':
    'Если контекст не больше этого размера, переход на Opus считается дешёвым: терять в кэше почти нечего. Переход на Sonnet решается в долларах (настройка ниже).',
  'Switch to Sonnet pays off within, turns': 'Переход на Sonnet окупается за, ходов',
  'turns': 'ходов',
  'Switching the main chat to Sonnet costs writing the whole context into the cache of the new model; the benefit is cheaper output and writing of new content on every following turn (cache reads cost the same on Opus and Sonnet). The mod switches only if the benefit over this many turns exceeds the cost of switching. Both amounts are visible in the journal, in the decision reasons.':
    'Переход основного диалога на Sonnet стоит записи всего контекста в кэш новой модели; выгода — дешевле вывод и запись нового на каждом следующем ходу (чтение кэша у Opus и Sonnet стоит одинаково). Мод переходит, только если выгода за столько ходов больше цены перехода. Обе суммы видны в журнале, в причинах решения.',
  'Maximum context for Sonnet': 'Максимальный контекст для Sonnet',
  'If the context is larger, the chat is not moved to Sonnet: on a long context Opus is more reliable, and switching models is expensive.':
    'Если контекст больше, диалог не переводится на Sonnet: на длинном контексте Opus надёжнее, а смена модели дорога.',
  'Cache lifetime': 'Время жизни кэша',
  'min': 'мин',
  'After this many idle minutes the prompt cache counts as cold, and switching models costs nothing. Do not set it higher than the real cache lifetime of your subscription: the mod would treat the cache as warm when it has already gone cold, or the other way round.':
    'Через столько минут простоя кэш промпта считается остывшим, и смена модели ничего не стоит. Не ставьте больше реального времени жизни кэша вашей подписки: мод будет считать кэш тёплым, когда он уже остыл, или наоборот.',
  'Minimum effort': 'Минимальный effort',
  'The mod never lowers effort below this level. A higher minimum means steadier quality but smaller savings.':
    'Ниже этого уровня мод effort не опускает. Выше минимум — стабильнее качество, но меньше экономия.',
  'Maximum effort': 'Максимальный effort',
  'The mod never raises effort above this level. max and xhigh use up limits heavily; it cannot be lower than the minimum.':
    'Выше этого уровня мод effort не поднимает. max и xhigh сильно расходуют лимиты; не может быть ниже минимума.',
  'Default effort': 'Effort по умолчанию',
  'Used when Jev is not sure about its estimate.': 'Используется, когда Jev не уверен в оценке.',
  'Effort when Jev does not respond': 'Effort, когда Jev не отвечает',
  'The first turn of a chat or subagent when Jev is unavailable and there is no previous decision. Without this, the turn would run at the session effort (often xhigh).':
    'Первый ход чата или субагента, а Jev недоступен и прошлого решения нет. Без этого ход шёл бы на effort сессии (часто xhigh).',
  'Confidence threshold for effort': 'Порог уверенности для effort',
  'If the confidence of Jev in the effort estimate is below this threshold, the estimate is ignored and the default effort is used.':
    'Если уверенность Jev в оценке effort ниже этого порога, оценка игнорируется и берётся effort по умолчанию.',
  'Raise effort after errors': 'Повышать effort после ошибок',
  'errors per turn': 'ошибок за ход',
  'How many failed tool calls in one turn raise effort by one level. 0 means never.':
    'Сколько неудачных вызовов инструментов за один ход повышают effort на один уровень. 0 — никогда.',
  'Threshold for a “risky” task': 'Порог «рискованной» задачи',
  'The probability that the task is risky (irreversible actions, production) at which effort is raised to at least high and Opus is used. A lower threshold means more caution and more spending.':
    'Вероятность, что задача рискованная (необратимые действия, продакшен), при которой effort поднимается минимум до high и берётся Opus. Ниже порог — больше перестраховки и расхода.',
  'Threshold for “continuation”': 'Порог «продолжения»',
  'The probability that the message continues the previous task; then the decision of the previous turn is repeated. A lower threshold means fewer needless switches, but the previous model may be kept longer.':
    'Вероятность, что сообщение — продолжение предыдущей задачи; тогда повторяется решение прошлого хода. Ниже порог — меньше лишних переключений, но можно дольше держать прежнюю модель.',
  'Take subscription limits into account': 'Учитывать лимиты подписки',
  'When the limit windows (5 hours and a week) are being used up faster than the usual pace, the mod saves: it takes Opus and high effort less often. When off, decisions do not depend on the remaining limits.':
    'Когда окна лимитов (5 часов и неделя) расходуются быстрее обычного темпа, мод экономит: реже берёт Opus и высокий effort. Выключено — решения не зависят от остатка лимитов.',
  'Choose subagent model and effort': 'Выбирать модель и effort субагентов',
  'Jev decides when each subagent is launched. A subagent has its own context, so the main chat cache does not suffer.':
    'Jev решает при запуске каждого субагента. У субагента свой контекст, поэтому кэш основного диалога не страдает.',
  'Opus threshold for a subagent': 'Порог Opus для субагента',
  'The probability that Opus is needed at which a subagent is launched on Opus. A lower threshold means more subagents on Opus (higher quality, more spending).':
    'Вероятность, что нужна Opus, при которой субагент запускается на Opus. Ниже порог — больше субагентов на Opus (качество выше, расход больше).',
  'Specialist agents': 'Агенты-специалисты',
  'Specialists are ready-made subagents with a short prompt and skills. Instead of a generic subagent the mod substitutes a suitable specialist; if there is none, it can create a new one.':
    'Специалисты — готовые субагенты с коротким промптом и навыками. Вместо общего субагента мод подставляет подходящего специалиста; если такого нет, может создать нового.',
  'Replace generic subagents with specialists': 'Подменять общих субагентов специалистами',
  'Launching a subagent from the list below is replaced with a suitable specialist from the registry (“Agents”).':
    'Запуск субагента из списка ниже заменяется на подходящего специалиста из реестра («Агенты»).',
  'Create a specialist if none fits': 'Создавать специалиста, если подходящего нет',
  'When no specialist fits, the author model (see below) writes a new one: one extra model call. When off, only the specialists you created by hand are used.':
    'Когда ни один специалист не подошёл, модель-автор (см. ниже) пишет нового — один дополнительный вызов модели. Выключено — только то, что вы создали вручную.',
  'Which subagent types to replace': 'Какие типы субагентов подменять',
  'Subagent types separated by commas (for example general-purpose, Explore). Other types are launched as they are.':
    'Типы субагентов через запятую (например general-purpose, Explore). Остальные типы запускаются как есть.',
  'Threshold for picking an existing specialist': 'Порог выбора существующего специалиста',
  'The probability from Jev that a specialist fits the task. A lower threshold means an existing specialist is taken more often, but inexact matches are possible; a higher one means a new one is created more often.':
    'Вероятность от Jev, что специалист подходит к задаче. Ниже порог — чаще берётся имеющийся специалист, но возможны неточные совпадения; выше — чаще создаётся новый.',
  'Maximum specialists': 'Максимум специалистов',
  'Auto-creation stops at this number of specialists. 0 means do not create automatically.':
    'Автосоздание останавливается при таком количестве специалистов. 0 — не создавать автоматически.',
  'Show specialists to Claude': 'Показывать специалистов Claude',
  'Adds the list of specialists to the subagent types available to Claude. This uses context, so it is hidden by default: the mod picks the specialist itself.':
    'Добавляет список специалистов в доступные Claude типы субагентов. Это расходует контекст, поэтому по умолчанию скрыто: мод подбирает специалиста сам.',
  'Specialist author model': 'Модель-автор специалистов',
  'The model that writes drafts of agents and skills. Sonnet 5.5 with low effort is usually enough.':
    'Модель, которая пишет черновики агентов и навыков. Sonnet 5.5 с низким effort обычно достаточно.',
  'Draft timeout': 'Таймаут черновика',
  'ms': 'мс',
  'How long to wait for a specialist draft. After that the launch goes ahead as an ordinary subagent.':
    'Сколько ждать черновик специалиста. По истечении запуск идёт как обычный субагент.',
  'Short waits in subagents': 'Короткие ожидания в субагентах',
  'Asks each subagent to wait for a build or process for no more than 4 minutes per call. The subagent cache lives for 5 minutes; after a long pause its whole context is written again (on the night of 5 October this cost ≈ $34 over 25 rebuilds).':
    'Просит каждого субагента ждать сборку или процесс не дольше 4 минут за один вызов. Кэш субагента живёт 5 минут; после долгой паузы весь его контекст записывается заново (ночью 5 октября это стоило ≈ $34 на 25 пересборках).',
  'Instead of a long summary the mod asks Jev to find stale tool calls and remove them from the context. This is cheaper and keeps the details.':
    'Вместо длинного summary мод просит Jev найти устаревшие вызовы инструментов и убрать их из контекста. Это дешевле и сохраняет детали.',
  'Compact through Jev': 'Сжимать через Jev',
  'When off, the built-in compaction of Claude Code (summary) is always used.':
    'Выключено — всегда встроенное сжатие Claude Code (summary).',
  'Compact at context size': 'Сжимать при размере контекста',
  'The main threshold: when the context grows to this size, the mod compacts it through Jev. 200k is almost as good as 120–180k, but with fewer compactions; 600k (60% of the window) is almost useless. 0 means off.':
    'Главный порог: когда контекст дорастает до этого размера, мод сжимает его через Jev. 200k почти так же выгоден, как 120–180k, но сжатий меньше; 600k (60% окна) почти бесполезен. 0 — выключено.',
  'Compact at the threshold only if Jev removes at least': 'Сжимать по порогу, только если Jev убирает не меньше',
  'Rewriting the cache after compaction pays off faster the more is removed: at 50% in about 40 steps, at 30% in 90+. If Jev can remove less than this share, threshold compaction is skipped (without the expensive built-in summary).':
    'Перезапись кэша после сжатия окупается тем быстрее, чем больше убрано: при 50% примерно за 40 шагов, при 30% — за 90+. Если Jev может убрать меньше этой доли, сжатие по порогу пропускается (без дорогого встроенного пересказа).',
  'Compact again no sooner than after': 'Повторное сжатие не раньше, чем через',
  'tokens of growth': 'токенов роста',
  'After a compaction (or a skipped attempt) the next one happens only when the context grows by this much. Protects against compacting every turn.':
    'После сжатия (или пропущенной попытки) следующее — только когда контекст вырастет на столько. Защищает от сжатия каждый ход.',
  'Request compaction at fill level': 'Просить сжатие при заполнении',
  'An additional threshold as a percentage of the window (with a 1M window this is late). 0 means off, the token threshold is enough.':
    'Дополнительный порог в процентах окна (при окне 1M это поздно). 0 — выключено, достаточно порога в токенах.',
  'Minimum savings': 'Минимальная экономия',
  'When Claude Code itself starts compaction (it hit the window or you typed /compact): if Jev removes less than this share, the built-in Claude Code summary is used.':
    'Когда сжатие запускает сам Claude Code (упёрся в окно или вы ввели /compact): если Jev убирает меньше этой доли, используется встроенный пересказ Claude Code.',
  'Keep threshold': 'Порог сохранения',
  'A call or result whose importance, as estimated by Jev, is above the threshold is left untouched. A higher threshold keeps more and saves less.':
    'Вызов или результат, важность которого по оценке Jev выше порога, остаётся нетронутым. Выше порог — сохраняется больше, экономия меньше.',
  'Leave the latest messages alone': 'Не трогать последние сообщения',
  'msgs': 'сообщ.',
  'How many recent messages are never compacted. More is safer for the current work, with smaller savings.':
    'Сколько свежих сообщений никогда не сжимается. Больше — безопаснее для текущей работы, меньше экономия.',
  'Length of the kept beginning': 'Длина сохранённого начала',
  'characters': 'символов',
  'How many characters of the beginning of the output remain from a trimmed tool result.':
    'Сколько символов начала вывода остаётся от обрезанного результата инструмента.',
  'Maximum “state” for Jev': 'Максимум «состояния» для Jev',
  'How much history is shown to Jev for its estimate. More means more accurate decisions, but the request is more expensive and slower.':
    'Сколько истории показывается Jev при оценке. Больше — точнее решения, но запрос дороже и медленнее.',
  'Maximum Jev request size': 'Максимум запроса к Jev',
  'The upper limit of a single request to Jev; a long history is split into several requests.':
    'Верхняя граница одного запроса к Jev; длинная история делится на несколько запросов.',
  'Compact when the cache expired during a pause': 'Сжимать, когда кэш истёк во время паузы',
  'When you do not write for longer than the cache lifetime (60 minutes on a subscription), the mod compacts the context through Jev by itself right after the cache expires, while you are away (and when such a session is opened after a restart). Rewriting the cache on your return is unavoidable, and this way it is smaller. When off, compaction happens only at the threshold or when Claude Code requests it.':
    'Когда вы не пишете дольше срока жизни кэша (на подписке 60 минут), мод сам сжимает контекст через Jev сразу после истечения кэша, пока вас нет (и при открытии такой сессии после перезапуска). Перезапись кэша при возвращении неизбежна, а так она меньше. Выключено — сжатие только по порогу или когда его запросит Claude Code.',
  'Compact on return from size': 'Сжимать при возвращении от размера',
  'Compaction on return starts only if the context is at least this size. A smaller value means more compactions, but on a small context the gain is modest; a larger one means fewer, but only where rewriting the cache is really expensive.':
    'Сжатие при возвращении запускается, только если контекст не меньше этого размера. Меньше значение — сжатий больше, но на маленьком контексте выигрыш скромный; больше — реже, зато только там, где перезапись кэша действительно дорога.',
  'On return, compact if at least this much is removed': 'При возвращении сжимать, если убирается не меньше',
  'After the cache expires the rewrite is unavoidable, so any savings are free: the threshold is low. Below it nothing is done.':
    'После истечения кэша перезапись неизбежна, поэтому любая экономия бесплатна: порог низкий. Ниже него ничего не делается.',
  'Save removed content to an archive': 'Сохранять убранное в архив',
  'Every removed call (input and full output) is saved to a file, and a link to it stays in the context. If an old detail is needed, Claude reads it from the file instead of running it again. Archive reads appear in the journal as output-read. Kept for 7 days, with the same overall limit as trimmed outputs.':
    'Каждый убранный вызов (вход и полный вывод) сохраняется в файл, а в контексте остаётся ссылка на него. Нужна старая деталь — Claude прочитает её из файла вместо повторного запуска. Чтения архива видны в журнале как output-read. Хранится 7 дней, общий лимит как у обрезанных выводов.',
  'Limit on the share removed in one compaction': 'Предел доли убранного за одно сжатие',
  'If Jev wants to remove more than this share of the history, the mod restores the calls Jev was least sure about removing until the share drops to the limit; a huge output is restored only if it cannot be avoided. A single compaction that removed 95% (it happened on 5 October) leaves the model guessing what it had. 1 means no limit; below 0.5 is not allowed: such a compaction would not reach the minimum benefit and would be skipped.':
    'Если Jev хочет убрать больше этой доли истории, мод возвращает вызовы, в удалении которых Jev был менее всего уверен, пока доля не опустится до предела; огромный вывод возвращается, только если без него не обойтись. Одно сжатие, убравшее 95% (было 5 октября), оставляет модель гадать, что у неё было. 1 — без предела, ниже 0.5 нельзя: такое сжатие не дотянет до минимальной пользы и будет пропускаться.',
  'Result preview for Jev, characters': 'Превью результата для Jev, символов',
  'chars': 'симв.',
  'How many characters from the start, and as many from the end, of each tool output Jev sees when deciding whether to keep it. 0 means only the output size, as in the original library: then Jev decides almost blind. The preview takes part of the state budget; if there is not enough room, previews of old calls are dropped first.':
    'Сколько символов из начала и столько же из конца каждого вывода инструмента видит Jev, решая, оставить ли его. 0 — только размер вывода, как в исходной библиотеке: тогда Jev решает почти вслепую. Превью занимает часть бюджета состояния; если места не хватает, превью старых вызовов убираются первыми.',
  'Context handoff to a new chat': 'Перенос контекста в новый чат',
  'In the old chat, /jevg getctx [focus] builds a “capsule”: a brief from this chat’s model (while the cache is warm), requests and final answers by turn (recent ones in full, those Jev rates as needed in condensed form, the rest in one line), changed files and the latest checks. The prompt for the new chat is copied to the clipboard. Paste it into a new chat of this project and the capsule attaches itself. Without pasting, /jevg ctx works in the new chat. The new chat reads ~10–15k instead of hundreds of thousands of tokens of old history at every step. /jevg fresh [focus] does the same without a new window: it builds the capsule, clears the chat (/clear) and attaches the capsule to your next message.':
    'В старом чате /jevg getctx [фокус] собирает «капсулу»: бриф от модели этого чата (пока кэш тёплый), запросы и итоговые ответы по ходам (свежие целиком, нужные по оценке Jev сжато, остальные одной строкой), изменённые файлы и последние проверки. Промпт для нового чата копируется в буфер обмена. Вставьте его в новый чат этого проекта, и капсула подключится сама. Без вставки в новом чате работает /jevg ctx. Новый чат читает ~10–15k вместо сотен тысяч токенов старой истории на каждом шаге. /jevg fresh [фокус] делает то же без нового окна: собирает капсулу, очищает чат (/clear) и подключает капсулу к вашему следующему сообщению.',
  'Context handoff': 'Перенос контекста',
  'The /jevg fresh, /jevg getctx and /jevg ctx commands and automatic attaching of the capsule by the jev-ctx:… link in a new chat.':
    'Команды /jevg fresh, /jevg getctx и /jevg ctx и автоматическое подключение капсулы по ссылке jev-ctx:… в новом чате.',
  'Capsule size': 'Размер капсулы',
  'Capsule budget. It first holds the brief, the last two turns in full and the first turn (usually the task itself), the rest by relevance. More means fewer lost details, but every step of the new chat reads more.':
    'Бюджет капсулы. Сначала в него входят бриф, два последних хода целиком и первый ход (обычно это сама задача), остальное по нужности. Больше — меньше потерь деталей, но каждый шаг нового чата читает больше.',
  'Brief from the old chat model': 'Бриф от модели старого чата',
  'only while the cache is warm': 'только пока кэш тёплый',
  'always': 'всегда',
  'never': 'никогда',
  'The brief: goal, state, decisions and why, rejected options, next step. It is one short turn of the old chat. While the cache is warm it is almost free (a cache read plus ~1.5k output tokens); on a cold cache it would cost rewriting the whole context. The --brief and --nobrief command flags override this setting.':
    'Бриф: цель, состояние, решения и почему, отвергнутые варианты, следующий шаг. Это один короткий ход старого чата. Пока кэш тёплый, он почти бесплатен (чтение кэша плюс ~1,5k токенов вывода); на остывшем кэше стоил бы перезаписи всего контекста. Флаги команды --brief и --nobrief перекрывают настройку.',
  'Brief length': 'Длина брифа',
  'words': 'слов',
  'Upper limit of the brief length.': 'Верхняя граница длины брифа.',
  'Turn selection through Jev': 'Отбор ходов через Jev',
  'Jev judges which old turns are needed to continue the work (taking the focus into account). When off, old turns are taken by recency.':
    'Jev оценивает, какие старые ходы нужны для продолжения работы (с учётом фокуса). Выключено — старые ходы берутся по свежести.',
  'Suggest a new chat at context from': 'Подсказывать новый чат при контексте от',
  'If Jev sees that the request starts a new task and the context is already at least this size, the mod suggests continuing with a clean chat via /jevg fresh. A suggestion only, at most once every 10 turns, works in shadow mode too. 0 means do not suggest.':
    'Если Jev видит, что запрос начинает новую задачу, а контекст уже не меньше этого размера, мод подсказывает продолжить с чистым чатом через /jevg fresh. Только подсказка, не чаще раза в 10 ходов, работает и в режиме наблюдения. 0 — не подсказывать.',
  'Jev confidence for the suggestion': 'Уверенность Jev для подсказки',
  'The “new task” probability at which the suggestion is shown.':
    'Вероятность «новая задача», с которой показывается подсказка.',
  'Suggest when the cache is cold from': 'Подсказывать при остывшем кэше от',
  'If you came back after a pause longer than the cache lifetime and the context is at least this size, the next turn will write all of it again. The mod will suggest /jevg fresh: continue in the same window with a clean chat and a capsule. Off by default (0): after a pause the mod first compacts the chat itself (“Compact when the cache expired during a pause”).':
    'Если вы вернулись после паузы дольше жизни кэша, а контекст не меньше этого размера, следующий ход заново запишет его целиком. Мод подскажет /jevg fresh: продолжить в этом же окне с чистым чатом и капсулой. По умолчанию выключено (0): после паузы мод сначала сам сжимает чат («Сжимать, когда кэш истёк во время паузы»).',
  'Keep capsules': 'Хранить капсулы',
  'days': 'дней',
  'Capsules are stored in ~/.claude/jev-governor/handoffs/.': 'Капсулы лежат в ~/.claude/jev-governor/handoffs/.',
  'Trimming large outputs': 'Обрезка больших выводов',
  'The mod trims long test, build or install output before it enters the chat: it keeps the summary line (tests passed or failed, how many), every error, warning and failure line with its neighboring lines, summary lines, the start and end of the output, and from the middle whatever Jev considers needed for the task. The full output is saved to a file, and Claude reads it from there instead of running the command again. This way thousands of log lines do not reach the context and the cache.':
    'Длинный вывод тестов, сборки или установки мод обрезает до того, как он попадёт в диалог: остаются строка с итогом (тесты прошли или упали, сколько), каждая строка ошибки, предупреждения и сбоя с соседними строками, итоговые строки, начало и конец вывода, а из середины — то, что Jev считает нужным для задачи. Полный вывод сохраняется в файл, и Claude прочитает его оттуда вместо повторного запуска команды. Так в контекст и кэш не попадают тысячи строк лога.',
  'Trim large outputs': 'Обрезать большие выводы',
  'When off, tool results enter the chat in full. When on, context is saved, but Claude does not see outputs completely (the full text is available in the saved file).':
    'Выключено — результаты инструментов попадают в диалог целиком. Включено — экономия контекста, но Claude видит выводы не полностью (полный текст доступен в сохранённом файле).',
  'Minimum size of test and build output': 'Минимальный размер вывода тестов и сборок',
  'Test and build outputs shorter than this are left alone. A smaller value trims more and saves more, but details are lost more often; a larger one is safer, but long logs pass through in full.':
    'Выводы тестов/сборок короче этого не трогаются. Меньше значение — обрезается больше, экономия выше, но чаще теряются детали; больше — безопаснее, но длинные логи проходят целиком.',
  'Size above which any output is trimmed': 'Размер, после которого обрезается любой вывод',
  'Any other output (not tests or a build) longer than this is trimmed too. Smaller means more aggressive savings, but, for example, a large file or a search may arrive incomplete; larger means such outputs stay as they are. Claude Code itself replaces Bash outputs longer than ~30k with a preview, so for Bash this threshold almost never fires.':
    'Любой другой вывод (не тесты и не сборка) длиннее этого тоже обрезается. Меньше — агрессивнее экономия, но, например, большой файл или поиск могут прийти не целиком; больше — такие выводы остаются как есть. Bash-выводы длиннее ~30k Claude Code сам заменяет превью, так что для Bash этот порог почти не срабатывает.',
  'Long lists (ls, du, ps, find)': 'Длинные списки (ls, du, ps, find)',
  'A list of files or processes longer than this is cut to the first 40 and last 15 lines; the full list is in a file, and Claude finds what it needs with grep. 0 means do not shorten.':
    'Список файлов или процессов длиннее этого сокращается до первых 40 и последних 15 строк; полный лежит в файле, Claude найдёт нужное через grep. 0 — не сокращать.',
  'Lines from the start': 'Строк сначала',
  'lines': 'строк',
  'How many of the first lines of the output always stay: usually the command, versions and first messages. More gives a fuller beginning but smaller savings.':
    'Сколько первых строк вывода остаётся всегда: там обычно команда, версии и первые сообщения. Больше — полнее начало, но меньше экономия.',
  'Lines from the end': 'Строк с конца',
  'How many of the last lines always stay: the summary, timing and exit code. More is safer, but the output will not get shorter.':
    'Сколько последних строк остаётся всегда: там итоги, время и код возврата. Больше — безопаснее, но вывод короче не станет.',
  'Lines around an error': 'Строк вокруг ошибки',
  'How many lines before and after each error, warning or failure line stay next to it. More makes the cause clearer (trace, expected and actual), but the output is longer.':
    'Сколько строк до и после каждой строки ошибки, предупреждения или сбоя остаётся рядом с ней. Больше — понятнее причина ошибки (трассировка, ожидаемое и фактическое), но вывод длиннее.',
  'Desired result size': 'Желаемый размер результата',
  'A soft limit on the size of the text that is kept. Error and summary lines are not dropped for its sake, so the result may be longer. Smaller means more savings; larger means less chance of losing something needed.':
    'Мягкая граница размера оставленного текста. Строки ошибок и итогов ради неё не выбрасываются, поэтому результат может быть длиннее. Меньше — больше экономия; больше — меньше шанс потерять нужное.',
  'Ask Jev what else is needed': 'Спрашивать Jev, что ещё нужно',
  'Jev looks at the skipped pieces of the middle of the output and returns those needed for the current task. This is one extra request to Jev per trim. When off, only errors, summaries, the start and the end remain.':
    'Jev смотрит на пропущенные куски середины вывода и возвращает те, что нужны для текущей задачи. Это один дополнительный запрос к Jev на каждую обрезку. Выключено — остаются только ошибки, итоги, начало и конец.',
  'Threshold for restoring a middle chunk': 'Порог возврата куска середины',
  'The lower it is, the more of the middle of the output Jev keeps: a chunk is restored if the probability that it is needed is not below the threshold. A lower threshold gives a fuller output and smaller savings; a higher one gives a shorter output, but a needed chunk may be lost.':
    'Чем ниже, тем больше середины вывода Jev оставляет: кусок возвращается, если вероятность, что он нужен, не ниже порога. Ниже порог — полнее вывод и меньше экономия; выше — короче вывод, но можно потерять нужный кусок.',
  'Keep full outputs': 'Хранить полные выводы',
  'How many days files with the full output stay in the outputs folder. Longer lets Claude reread an old output in a long session; shorter uses less disk space.':
    'Сколько дней лежат файлы с полным выводом в папке outputs. Дольше — Claude может перечитать старый вывод в долгой сессии; короче — меньше места на диске.',
  'Storage limit for full outputs': 'Предел места под полные выводы',
  'MB': 'МБ',
  'If all saved outputs together exceed this, the oldest sessions are deleted whole at session start. In addition, every start deletes files older than the retention period and empty folders.':
    'Если все сохранённые выводы вместе больше этого, при старте сессии удаляются самые старые сессии целиком. Плюс каждый старт удаляет файлы старше срока хранения и пустые папки.',
  'Savings calculation': 'Расчёт экономии',
  'How the “Savings” tab is calculated: dollar amounts at Anthropic list prices (API equivalent), subscription limits are used up in proportion to the same tokens. These settings affect only the calculation, not how the mod works.':
    'Как считается вкладка «Экономия»: суммы в долларах по прайс-листу Anthropic (эквивалент API), лимиты подписки расходуются пропорционально тем же токенам. Эти настройки влияют только на подсчёт, не на работу мода.',
  'Compact mid-turn and in subagents at': 'Сжимать посреди хода и в субагентах при',
  'The mod can compact only between turns. At this size Claude Code compacts by itself, also in the middle of a long turn and inside subagents, and the mod prunes it through Jev. Set as Claude Code’s auto-compaction window (CLAUDE_CODE_AUTO_COMPACT_WINDOW) for each session; a value you set in the environment yourself wins. Keep it above the threshold above. 0 means Claude Code’s own window.':
    'Сам мод умеет сжимать только между ходами. При таком размере Claude Code сжимает сам, в том числе посреди длинного хода и внутри субагентов, а мод прореживает это через Jev. Ставится как окно автосжатия Claude Code (CLAUDE_CODE_AUTO_COMPACT_WINDOW) в каждой сессии; если вы задали переменную сами, действует ваше значение. Держите выше порога выше. 0 — окно самого Claude Code.',
  'Share of output per effort level': 'Доля вывода за уровень усилия',
  'The share of a turn’s output saved by lowering effort by one level; about 0.3 according to the project’s A/B tests. Cache reads are not counted. Affects only the estimate.':
    'Доля вывода хода, которую экономит снижение усилия на один уровень; по A/B-тестам проекта ≈ 0.3. Чтение кэша не считается. Влияет только на оценку.',
  'Model without the mod': 'Модель без мода',
  'What the sessions would have run on without the mod. Needed for old journal entries where this is not recorded.':
    'На чём работали бы сессии без мода — нужно для старых записей журнала, где это не записано.',
  'Effort without the mod': 'Effort без мода',
  'The effort level the sessions would have run at without the mod; also only for old journal entries where this is not recorded.':
    'С каким уровнем усилия работали бы сессии без мода; тоже только для старых записей журнала, где это не записано.',
  'Jev and key': 'Jev и ключ',
  'Jev model': 'Модель Jev',
  'Identifier of the Jev model for the System One API.': 'Идентификатор модели Jev для API System One.',
  'API address': 'Адрес API',
  'TypeSafe-compatible System One address. OpenRouter by default. The key is sent to this address.':
    'TypeSafe-совместимый адрес System One. По умолчанию — OpenRouter. Ключ отправляется на этот адрес.',
  'Key file': 'Файл ключа',
  'Where the OpenRouter key is stored (~ is the home folder). The OPENROUTER_API_KEY environment variable takes precedence over the file. Save the settings first, then the key.':
    'Где лежит ключ OpenRouter (~ — домашняя папка). Переменная окружения OPENROUTER_API_KEY важнее файла. Сначала сохраните настройки, затем ключ.',
  'Decision timeout': 'Таймаут решения',
  'If Jev takes longer to respond, the decision is dropped and nothing changes. Smaller means a faster turn, but “no decision” more often.':
    'Если Jev отвечает дольше, решение отбрасывается и ничего не меняется. Меньше — быстрее ход, но чаще «без решения».',
  'Projects': 'Проекты',
  'Project pages (the “Projects” tab): commands found in the project files and commands that Claude ran successfully there. Project folders are only read, nothing is written to them.':
    'Страницы проектов (вкладка «Проекты»): команды, найденные в файлах проекта, и команды, которые Claude успешно запускал там. Папки проектов только читаются, ничего в них не записывается.',
  'Project panel': 'Пульт проектов',
  'The “Projects” tab, remembering the commands Claude ran successfully, and command descriptions. Not related to saving limits; when off, the mod and the interface leave projects alone.':
    'Вкладка «Проекты», запоминание команд, которые Claude успешно запускал, и описания команд. К экономии лимитов не относится; выключен — мод и интерфейс проекты не трогают.',
  'Command description language': 'Язык описаний команд',
  'Descriptions are written by Claude Sonnet through an open session with the mod; when the language changes, they are rewritten at the next project refresh.':
    'Описания пишет Claude Sonnet через открытую сессию с модом; при смене языка они перепишутся при следующем обновлении проекта.',
  'Remember commands run by Claude': 'Запоминать команды Claude',
  'The mod records in the journal the commands Claude runs in a project (without output and without commands that look like secrets). Successful commands appear in the project list marked “Claude ×N”.':
    'Мод записывает в журнал команды, которые Claude запускает в проекте (без вывода и без команд, похожих на секреты). Успешные команды попадают в список проекта с пометкой «Claude ×N».',
  'Successful runs before showing': 'Успешных запусков до показа',
  'A command that is not in the project files is shown after this many successful Claude runs in the last 30 days. More means fewer accidental commands in the list.':
    'Команду, которой нет в файлах проекта, показываем после стольких успешных запусков Claude за последние 30 дней. Больше — меньше случайных команд в списке.',
  'Describe commands with Claude': 'Описывать команды с помощью Claude',
  'On a project refresh a request is placed in the data folder, and an open Claude Code session with the mod answers it with Sonnet at low effort (usually within a minute). Without an open session there will be no descriptions: drafts from the project files are shown instead.':
    'При обновлении проекта в папку данных кладётся запрос, а открытая сессия Claude Code с модом отвечает на него Sonnet с низким effort (обычно за минуту). Без открытой сессии описаний не будет: вместо них видны черновики из файлов проекта.',
  'Claude Code git worktrees (…/.claude/worktrees/…) in the project list. This can also be toggled in place on the “Projects” page.':
    'Git-worktree Claude Code (…/.claude/worktrees/…) в списке проектов. На странице «Проекты» это можно переключить и на месте.',
  'Terminal': 'Терминал',
  'Where the “Run in terminal” button opens. Other terminals later.':
    'Где открывается кнопка «В терминале». Другие терминалы — позже.',
  'Interface': 'Интерфейс',
  'Settings port': 'Порт настроек',
  'The port of this interface (127.0.0.1 only). Applies after the server restarts.':
    'Порт этого интерфейса (только 127.0.0.1). Применяется после перезапуска сервера.',
  'Show the decision in the status line': 'Показывать решение в строке статуса',
  'The Claude Code status line shows the current model, effort and limit pressure.':
    'В строке статуса Claude Code видно текущую модель, effort и давление лимитов.',
  'Path to Node': 'Путь к Node',
  'Node for the /jevg ui command (looked up in PATH if just “node” is given). Version 23.6 or newer is required.':
    'Node для команды /jevg ui (поиск в PATH, если указано просто «node»). Нужна версия 23.6 или новее.',
  'Settings saved. The mod will pick them up on the next turn.': 'Настройки сохранены. Мод подхватит их на следующем ходу.',
  'Port {port} will take effect after the interface server restarts.': 'Порт {port} заработает после перезапуска сервера интерфейса.',
  'Reset all settings to their defaults? The key and the agents are not affected.': 'Сбросить все настройки к значениям по умолчанию? Ключ и агенты не затрагиваются.',
  'Settings reset to defaults.': 'Настройки сброшены к умолчанию.',
  'Save': 'Сохранить',
  'Discard changes': 'Отменить правки',
  'Reset to defaults': 'Сбросить к умолчаниям',
  'Unsaved changes': 'Есть несохранённые изменения',
  'environment variable OPENROUTER_API_KEY': 'переменная окружения OPENROUTER_API_KEY',
  'file in the project folder: {path}': 'файл в папке проекта: {path}',
  'file: {path}': 'файл: {path}',
  'Key saved to {path}, but the key from another source is currently in effect ({source}).': 'Ключ сохранён в {path}, но сейчас действует ключ из другого источника ({source}).',
  'Key saved.': 'Ключ сохранён.',
  'OpenRouter key': 'Ключ OpenRouter',
  'Checking…': 'Проверяю…',
  'Key found': 'Ключ найден',
  'Without a key Jev decides nothing, and the mod does not change Claude Code settings. Paste the key below.': 'Без ключа Jev ничего не решает, и мод не меняет настройки Claude Code. Вставьте ключ ниже.',
  'New OpenRouter key': 'Новый ключ OpenRouter',
  'Save key': 'Сохранить ключ',
  'The key is never shown in the interface. It will be saved to': 'Ключ никогда не показывается в интерфейсе. Он будет сохранён в',
  'with permissions for you only (0600).': 'с правами только для вас (0600).',
  'Test Jev': 'Проверить Jev',
  'Jev responds: {ms} ms, noul {noul}': 'Jev отвечает: {ms} мс, noul {noul}',
  'Error: {error}': 'Ошибка: {error}',
  'Sends one tiny request to Jev (costs a fraction of a cent).': 'Отправляет один крошечный запрос к Jev (стоит доли цента).',
  'Basics': 'Основное',
  'Interface language, the on/off switch, mode, and the Jev key and model.': 'Язык интерфейса, выключатель, режим, ключ и модель Jev.',
  'Models & agents': 'Модели и агенты',
  'Which models and effort levels the mod picks for the main chat and subagents, and the specialist agents.': 'Какие модели и уровни effort мод выбирает для основного чата и субагентов, и агенты-специалисты.',
  'Context': 'Контекст',
  'Context compaction, handoff to a new chat, and trimming of large outputs.': 'Сжатие контекста, перенос в новый чат и обрезка больших выводов.',
  'Projects & savings': 'Проекты и экономия',
  'The project panel with its commands, and how the savings are counted.': 'Панель проектов с командами и подсчёт экономии.',
  '{n} {n#section|sections}': '{n} {n#раздел|раздела|разделов}',
  '{n} {n#setting|settings}': '{n} {n#настройка|настройки|настроек}',
} as Record<string, string>;
