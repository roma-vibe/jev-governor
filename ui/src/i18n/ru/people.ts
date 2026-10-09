// Russian text for the English keys used in the matching components (Agents, AgentEditor, GenerateAgent, Skills, SkillEditor).
export default {
  // Agents
  'Agent saved.': 'Агент сохранён.',
  'Agent created.': 'Агент создан.',
  'Delete agent “{name}”? This cannot be undone.': 'Удалить агента «{name}»? Это действие нельзя отменить.',
  'Agent deleted.': 'Агент удалён.',
  'Agent “{name}” and {n} {n#skill|skills} saved.': 'Агент «{name}» и {n} {n#навык|навыка|навыков} сохранены.',
  'Agent “{name}” saved.': 'Агент «{name}» сохранён.',
  'Agents are mostly created automatically: when Claude launches a subagent and there is no suitable specialist, the mod writes a new one. Here you can edit them, disable them or create them by hand. Keep prompts short and in English: they go into the context of every run.':
    'Специалисты в основном создаются автоматически: когда Claude запускает субагента и подходящего специалиста нет, мод пишет нового. Здесь их можно поправить, отключить или создать вручную. Промпты лучше делать короткими и по-английски: они попадают в контекст каждого запуска.',
  'New agent': 'Новый агент',
  'Generate from a description': 'Сгенерировать по описанию',
  'Total: {n}': 'Всего: {n}',
  'Enabled: {on} of {n}': 'Включено: {on} из {n}',
  'Merge near-copies': 'Слить дубли',
  'Merging…': 'Сливаю…',
  'Claude compares all enabled agents and folds near-copies into one: the kept one takes their skills and runs, the others are disabled (not deleted). Manual agents are never folded away.':
    'Claude сравнивает все включённые агенты и сливает почти одинаковые в один: оставшийся забирает их навыки и запуски, остальные выключаются (не удаляются). Агенты, созданные вручную, никогда не сливаются в другие.',
  skill: 'навык',
  'Merged: {list}': 'Слиты: {list}',
  'No near-copies found.': 'Похожих агентов не нашлось.',
  'Merge failed: {error}': 'Слить не удалось: {error}',
  'No Claude Code session with the mod picked the request up yet; it will run in the next one.':
    'Ни одна сессия Claude Code с модом пока не взяла запрос; он выполнится в следующей.',
  'merged into {name}': 'слит в {name}',
  'retired: registry full': 'выведен: реестр полон',
  'all runs:': 'всего запусков:',
  'No agents yet. They will appear on their own as you work, or create the first one by hand.':
    'Агентов пока нет. Они появятся сами по мере работы или создайте первого вручную.',
  auto: 'авто',
  manual: 'вручную',
  'model: {tier}': 'модель: {tier}',
  'effort: {effort}': 'effort: {effort}',
  'model and effort: Jev': 'модель и effort — Jev',
  'No runs in {n} {n#day|days} (counted from the last run, or from creation if there were none). Every enabled agent is one more candidate that Jev compares when a subagent starts; it is better to delete or disable one you do not need.':
    'Ни одного запуска за {n} {n#день|дня|дней} (с последнего запуска, а если запусков не было — с создания). Каждый включённый агент — ещё один кандидат, которого Jev сравнивает при запуске субагента; ненужного лучше удалить или выключить.',
  'not used': 'не используется',
  'tools: {n}': 'инструментов: {n}',
  'Enable {name}': 'Включить {name}',
  'Similar to {names}: “Merge near-copies” folds such agents into one.':
    'Похож на {names}: кнопка «Слить дубли» сольёт такие агенты в один.',
  'Runs in 30 days:': 'Запусков за 30 дней:',
  Edit: 'Редактировать',
  Delete: 'Удалить',
  'Agent {name}': 'Агент {name}',
  'New agent: review the draft': 'Новый агент: проверьте черновик',
  'Save agent': 'Сохранить агента',

  // AgentEditor and SkillEditor
  'Enter a name.': 'Укажите имя.',
  'Name: a-z, 0-9 and hyphen, 2–40 characters, starts with a letter.': 'Имя: a-z, 0-9 и дефис, 2–40 символов, начинается с буквы.',
  Name: 'Имя',
  'Registered in Claude Code as jev-governor:{name}': 'Регистрируется в Claude Code как jev-governor:{name}',
  'Description: when to use it': 'Описание — когда использовать',
  'Fixes failing Rust tests: finds the cause, fixes the code, runs cargo test':
    'Чинит упавшие тесты Rust: находит причину, правит код, запускает cargo test',
  'One line. Jev uses it to decide whether the agent fits a task, so write what kind of work it is for.':
    'Одна строка. По ней Jev решает, подходит ли агент к задаче, поэтому пишите, для какой работы он нужен.',
  Prompt: 'Промпт',
  'Short and in English: the role, the approach, what to return. No general programming advice.':
    'Коротко и по-английски: роль, подход, что вернуть. Без общих советов по программированию.',
  Tools: 'Инструменты',
  'All tools (same as the main session)': 'Все инструменты (как у основной сессии)',
  'Do not give researchers and reviewers Edit and Write: the agent will then only be able to read.':
    'Для исследователей и ревьюеров не давайте Edit и Write: агент сможет только читать.',
  'No skills yet. Create them on the “Skills” tab.': 'Навыков пока нет. Создайте их на вкладке «Навыки».',
  new: 'новый',
  Model: 'Модель',
  'Auto (Jev decides)': 'Авто (решает Jev)',
  Effort: 'Effort',
  Enabled: 'Включён',
  'Pin the model or effort only if the agent always needs it; otherwise Jev will pick them for each task and save your limits.':
    'Закрепляйте модель или effort, только если агенту это нужно всегда; иначе Jev подберёт под каждую задачу и сэкономит лимиты.',
  'New skills of this agent': 'Новые навыки этого агента',
  Remove: 'Убрать',
  Description: 'Описание',
  'Skill text': 'Текст навыка',
  'Resulting system prompt': 'Итоговый системный промпт',
  '{n} {n#character|characters}': '{n} {n#символ|символа|символов}',
  'Read-only: the agent prompt and the selected skills as one text, as the subagent will receive them.':
    'Только для чтения: промпт агента и выбранные навыки одним текстом, как их получит субагент.',
  Cancel: 'Отмена',
  Save: 'Сохранить',

  // GenerateAgent
  'Generate an agent from a description': 'Сгенерировать агента по описанию',
  'The draft is gone (it was deleted or never saved). Try again.': 'Черновик исчез (его удалили или он не сохранился). Попробуйте ещё раз.',
  'New request': 'Новый запрос',
  'What the agent should be able to do': 'Что должен уметь агент',
  'An agent that fixes failing tests in Rust projects: finds the cause, fixes the code and reruns cargo test…':
    'Агент, который чинит упавшие тесты в Rust-проектах: находит причину, правит код и перезапускает cargo test…',
  'Describe a class of tasks in one paragraph (10–2000 characters), not one specific task. Claude will write a short prompt in English and, if needed, skills; you can edit everything before saving.':
    'Опишите класс задач одним абзацем (10–2000 символов), не одну конкретную задачу. Claude напишет короткий промпт на английском и при необходимости навыки; вы сможете всё поправить перед сохранением.',
  'The draft is created by an open Claude Code session with the mod (it checks the queue about every 8 seconds). If there is no such session, the request will wait.':
    'Черновик создаёт открытая сессия Claude Code с модом (раз в ~8 секунд проверяет очередь). Если такой сессии нет, запрос будет ждать.',
  'Waiting for an open Claude Code session with the mod: the draft is created there about every 8 seconds. Open Claude Code if it is closed.':
    'Ждёт открытую сессию Claude Code с модом — черновик создаётся там раз в ~8 секунд. Откройте Claude Code, если он закрыт.',
  'Claude is writing the draft… It usually takes up to half a minute.': 'Claude пишет черновик… Обычно это занимает до полуминуты.',
  'Done, opening the editor…': 'Готово, открываю редактор…',
  'Failed: {error}': 'Не получилось: {error}',
  'unknown error': 'неизвестная ошибка',
  'Edit the request': 'Изменить запрос',
  Generate: 'Сгенерировать',

  // Skills
  'Skill saved.': 'Навык сохранён.',
  'Skill created.': 'Навык создан.',
  'The skill is used by agents: {names}. It will be removed from their lists.': 'Навык используют агенты: {names}. Он будет убран из их списков.',
  'Delete skill “{name}”?': 'Удалить навык «{name}»?',
  'Skill deleted.': 'Навык удалён.',
  'A skill is a short piece of concrete knowledge (commands, conventions, pitfalls) that is added to the agent prompt. One skill can be used by several agents. An agent has at most 4 skills, and a skill text is at most 2000 characters long.':
    'Навык — короткий кусок конкретных знаний (команды, соглашения, подводные камни), который добавляется в промпт агента. Один навык может использоваться несколькими агентами. У агента не больше 4 навыков, а текст навыка не длиннее 2000 символов.',
  'New skill': 'Новый навык',
  'No skills yet.': 'Навыков пока нет.',
  '{n} chars': '{n} симв.',
  'Used by:': 'Используют:',
  'Not used by any agent.': 'Не используется ни одним агентом.',
  'Skill {name}': 'Навык {name}',

  // SkillEditor
  'Latin letters, digits and hyphen.': 'Латиница, цифры и дефис.',
  'When renamed, the references in these agents will be updated: {agents}.': 'При переименовании ссылки в агентах обновятся: {agents}.',
  'One line: what this skill is about and when it is useful.': 'Одна строка: о чём этот навык и когда он полезен.',
  'Concrete knowledge: exact commands, project conventions, pitfalls. Short and in English. It is added to the prompt of every agent that uses the skill.':
    'Конкретные знания: точные команды, соглашения проекта, подводные камни. Коротко и по-английски. Добавляется в промпт каждого агента, который использует навык.',
} as Record<string, string>;
