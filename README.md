# Claude OpenCodex Limits

Плагин для **Claude Desktop** и **Claude Code**, который отображает реальный остаток квот провайдеров (Google Antigravity, Gemini, Claude 3P и др.) прямо в интерфейсе приложения вместо `localhost`.

![Preview](https://raw.githubusercontent.com/teroguy/claude-opencodex-limits/main/preview.png)

---

## Возможности

- **Индикатор над строкой ввода (`AbovePrompt`)**:
  - Отображает остаток лимита текущей модели: `5ч: 70% ━━━━━━── (2ч) · Неделя: 74% ━━━━━━── (4д)`.
  - Цветовой акцент: зеленый (норма), желтый (менее 30%), красный (менее 15%).
  - Не загромождает интерфейс и выполнен в нативном минималистичном стиле.
- **Боковая панель (`Pane`)**:
  - Открывается по кнопке `детали` или команде `/limits`.
  - Подробные шкалы по семействам моделей (Gemini, Claude и др.).
  - Статистика токенов в сессии (входные, кэшированные, выходные) и процент попадания в кэш.
  - Журнал последних 5 запросов с временем и задержкой.
- **Нижний статус-бар**:
  - Краткий индикатор `ocx: 5ч: 70% · нед: 74%`.

---

## Установка

### Вариант 1: Через каталог плагинов Claude (Рекомендуется)

В окне ввода Claude Desktop или терминале Claude Code выполните:

```bash
/plugin marketplace add teroguy/claude-opencodex-limits
/plugin install opencodex-limits --marketplace teroguy/claude-opencodex-limits
```

или через CLI в терминале:

```bash
claude plugin marketplace add teroguy/claude-opencodex-limits
claude plugin install opencodex-limits --marketplace teroguy/claude-opencodex-limits
```

---

### Вариант 2: Клонирование в папку навыков

Если вы хотите установить плагин вручную без добавления маркетплейса:

```bash
git clone https://github.com/teroguy/claude-opencodex-limits.git ~/.claude/skills/opencodex-limits
```

После перезапуска Claude Desktop плагин автоматически активируется.

---

## Использование

1. Запустите Claude Desktop с работающим OpenCodex.
2. Над полем ввода появится аккуратная строка с текущими остатками лимитов.
3. Чтобы открыть подробную панель:
   - Нажмите ссылку `детали` справа от строки лимитов, либо
   - Введите команду `/limits` в чате.

---

## Требования

- **Claude Desktop** (с вкладкой Code) или **Claude Code CLI** (v2.1.295+)
- Работающий сервис **OpenCodex** (`opencodex`)

---

## Лицензия

[MIT](LICENSE) © [Vlad (teroguy)](https://github.com/teroguy)
