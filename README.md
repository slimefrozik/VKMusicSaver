# VK Music Saver (Firefox Extension)

> **100% written by Antigravity (Gemini 3.8 Flash)** — весь исходный код, архитектура, бинарные парсеры/муксеры, тесты и сборочные скрипты этого проекта полностью написаны ИИ-агентом **Antigravity** (модель **Gemini 3.8 Flash**) по постановке задачи от [@slimefrozik](https://github.com/slimefrozik).

Расширение для Firefox (Manifest V2, Firefox `140.0+`), которое заменяет кнопки **«Транслировать аудиозаписи:»** и **«Открыть сниппет»** на сайтах `vk.com` и `vk.ru` на кнопку скачивания трека в максимальном доступном качестве.

## Возможности

- **Замена кнопок в интерфейсе VK**: находит кнопки с метками/подсказками «Транслировать аудиозаписи:» и «Открыть сниппет» (как в классической вёрстке, так и в React-интерфейсе VK Музыки) и заменяет их на кнопку скачивания. Если обе кнопки находятся рядом в одной панели управления, вместо них остаётся одна кнопка скачивания.
- **Максимальный битрейт без перекодирования**:
  - Для HLS-потоков (`.m3u8`) выбирается вариант с наибольшим `BANDWIDTH` из master-плейлиста.
  - Поддерживается расшифровка сегментов `AES-128-CBC` через Web Crypto API.
  - Встроенный MPEG-TS демультиплексор извлекает оригинальный аудиопоток без потери качества:
    - MPEG Audio сохраняется как **`.mp3`** с добавлением ID3v2.3-тегов (`TIT2` / `TPE1` в UTF-16LE).
    - AAC ADTS переупаковывается без перекодирования в стандартный контейнер **`.m4a`** с метаданными.
  - Для прямых ссылок скачивается исходный файл (`.mp3` / `.m4a` / `.ogg`).

## Сборка пакета

```bash
node scripts/build.mjs
```

Соберёт пакеты `dist/vk-music-saver-1.0.1.xpi` и `dist/vk-music-saver-1.0.1.zip`.

## Установка в Firefox

1. Скачайте `.xpi` из раздела **Releases** (или соберите локально командой `node scripts/build.mjs`).
2. Откройте `about:debugging#/runtime/this-firefox` в Firefox (версия 140+).
3. Нажмите **«Загрузить временное дополнение…»** (*Load Temporary Add-on…*).
4. Выберите `manifest.json` или собранный файл `vk-music-saver-1.0.1.xpi`.

> В обычной релизной версии Firefox неподписанные дополнения работают до перезапуска браузера. Для постоянной установки подпишите `vk-music-saver-1.0.1.zip` через кабинет разработчика Mozilla (AMO) как *Self-distributed (Unlisted)* и установите полученный подписанный `.xpi`.

## Проверка тестами

```bash
node --test tests/extension.test.js
```

## Contributors

- **Antigravity (Gemini 3.8 Flash)** — Author & sole code contributor (100% of codebase written by Antigravity).
- **[@slimefrozik](https://github.com/slimefrozik)** — Repository owner, requirements & verification in Firefox.
