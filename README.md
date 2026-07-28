# ESP Flasher — flash.miroslav.diy

Веб-прошивальщик ESP32 с каталогами **Bruce**, **Launcher** и **ESP Terminator**,
серверным прокси прошивок и починкой `LittleFS is full`.

Живёт на **https://flash.miroslav.diy**.

## Зачем

### 1. «Failed to download firmware: Failed to fetch»

Все публичные веб-прошивальщики скачивают `.bin` прямо из релизов GitHub. GitHub
отвечает `302` на `release-assets.githubusercontent.com`, и **в этом редиректе нет
заголовка `Access-Control-Allow-Origin`** — браузер обрывает межсайтовый `fetch()`.
Страница получает пустую ошибку и починить это на своей стороне не может.

Проверяется одной командой:

```bash
curl -sI -H "Origin: https://example.com" \
  https://github.com/BruceDevices/firmware/releases/download/1.16/Bruce-CYD-2432S028.bin \
  | grep -i access-control      # пусто
```

Здесь прошивку качает `fw-proxy` на сервере и отдаёт её с того же домена — CORS не
участвует вообще. Побочные плюсы: кеш на диске (повторная прошивка мгновенная и
работает при недоступном GitHub) и обход лимита GitHub API 60 запросов/час.

### 2. «LittleFS is full» ([BruceDevices/firmware#2298](https://github.com/BruceDevices/firmware/issues/2298))

Когда LittleFS забита, Bruce показывает красную полосу и блокируется до нажатия
кнопки — файлы удалить неоткуда. Патч из issue открывает serial-хендлер до экрана
ошибки, но он требует пересборки прошивки.

Кнопка **«Починить LittleFS is full»** решает это без пересборки:

1. читает таблицу разделов **с самой платы** (`readFlash(0x8000, 0xC00)`);
2. находит раздел ФС (subtype `0x82 spiffs` / `0x83 littlefs`);
3. записывает в **этот раздел** `0xFF` — паттерн стёртой флеши.

При следующем старте `setupLittleFS()` не смонтирует ФС, и `main.cpp` вызовет
`LittleFS.format()` — файловая система становится чистой. Приложение и раздел
`nvs` (Wi-Fi, настройки) не трогаются. Плюс есть встроенный **serial-монитор** —
это ровно тот путь восстановления, который описан в issue (`help` и команды сборки).

### 3. CYD: 192 КБ под файлы

| Сборка | partition csv | app | LittleFS |
|---|---|---|---|
| `Bruce-CYD-2432S028.bin` | `custom_4Mb_full.csv` | 3,75 МБ | **192 КБ** |
| `Bruce-LAUNCHER_CYD-2432S028.bin` | `custom_4Mb.csv` | 2,44 МБ | **1,5 МБ** |

Вариант `LAUNCHER_` собирается с `env_light` (`LITE_VERSION=1`, `-Os`, урезанные
ИК-протоколы) — иначе не влезает. Это размен функций на место, а не бесплатный
апгрейд. UI это проговаривает.

## Структура

```
server/fwproxy.py         каталоги + прокси бинарников (stdlib, без зависимостей)
server/fw-proxy.service   systemd unit (127.0.0.1:8781, ProtectSystem=strict)
web/index.html            страница
web/js/app.js             UI, каталог, действия
web/js/esp.js             всё, что трогает устройство (esptool-js)
web/js/partitions.js      парсеры таблицы разделов и заголовка образа (чистые)
web/lib/esptool-bundle.js вендоренный esptool-js 0.5.x
tools/test-parsers.mjs    прогон парсеров по реальным .bin
deploy.sh                 раскладка на /var/www/esp-flasher и /opt/fw-proxy
```

## API прокси

| Запрос | Ответ |
|---|---|
| `GET /api/health` | `{"ok":true}` |
| `GET /api/sources` | список источников |
| `GET /api/catalog?src=bruce\|launcher\|espterminator[&refresh=1]` | нормализованный каталог |
| `GET /api/bin?u=<url>` | бинарник с того же origin, `X-Fw-Cache: hit\|miss` |

`/api/bin` пускает только `https` и только к хостам из статического списка плюс
те, что встречаются в текущих каталогах. Кеш — `/var/cache/fw-proxy/bins`,
LRU-обрезка до 3 ГБ.

## Деплой

```bash
bash deploy.sh                 # статика + сервис + health-check
systemctl reload caddy         # если менялся vhost
```

Caddy на NUC — vhost `flash.miroslav.diy` (`/api/*` → `127.0.0.1:8781`, остальное
статика). На edge домен добавлен в общий host-list, TLS выпускается автоматически.

## Проверки

```bash
node tools/test-parsers.mjs /tmp/Bruce-CYD-2432S028.bin      # парсеры на реальном образе
curl -s https://flash.miroslav.diy/api/health
curl -s "https://flash.miroslav.diy/api/catalog?src=bruce" | head -c 200
```

## Ограничения

* Web Serial есть только в Chrome / Edge / Opera на десктопе и только по `https`.
* Прошивки принадлежат их авторам — этот сайт их только проксирует и записывает.
* Логика записи проверена на разборе реальных образов и на прогоне каталогов;
  запись в железо проверяется только на живой плате.
