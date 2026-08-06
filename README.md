# ESP Flasher — flash.miroslav.diy

Web-based ESP32 flasher with **Bruce**, **Launcher**, **ESP Terminator** and
**Wireless Wizard** catalogs, a server-side firmware proxy, and a fix for
`LittleFS is full`.

Lives at **https://flash.miroslav.diy**.

## Why

### 1. "Failed to download firmware: Failed to fetch"

All public web flashers download `.bin` files straight from GitHub releases. GitHub
answers with a `302` to `release-assets.githubusercontent.com`, and **that redirect
carries no `Access-Control-Allow-Origin` header** — so the browser aborts the
cross-site `fetch()`. The page gets an empty error and cannot fix it on its side.

Verified with a single command:

```bash
curl -sI -H "Origin: https://example.com" \
  https://github.com/BruceDevices/firmware/releases/download/1.16/Bruce-CYD-2432S028.bin \
  | grep -i access-control      # empty
```

Here the firmware is fetched by `fw-proxy` on the server and served from the same
domain — CORS is not involved at all. Side benefits: an on-disk cache (re-flashing
is instant and works even when GitHub is unreachable) and no GitHub API limit of
60 requests/hour.

### 2. "LittleFS is full" ([BruceDevices/firmware#2298](https://github.com/BruceDevices/firmware/issues/2298))

When LittleFS is full, Bruce shows a red bar and blocks until a button is pressed —
there is nowhere to delete files from. The patch from the issue opens the serial
handler before the error screen, but it requires rebuilding the firmware.

The **"Fix LittleFS is full"** button solves this without a rebuild:

1. reads the partition table **from the board itself** (`readFlash(0x8000, 0xC00)`);
2. finds the filesystem partition (subtype `0x82 spiffs` / `0x83 littlefs`);
3. fills **that partition** with `0xFF` — the erased-flash pattern.

On the next boot `setupLittleFS()` fails to mount the FS, and `main.cpp` calls
`LittleFS.format()` — the filesystem comes up clean. The application and the `nvs`
partition (Wi-Fi, settings) are untouched. There is also a built-in **serial
monitor** — exactly the recovery path described in the issue (`help` and the build
commands).

### 3. CYD: 192 KB for files

| Build | partition csv | app | LittleFS |
|---|---|---|---|
| `Bruce-CYD-2432S028.bin` | `custom_4Mb_full.csv` | 3.75 MB | **192 KB** |
| `Bruce-LAUNCHER_CYD-2432S028.bin` | `custom_4Mb.csv` | 2.44 MB | **1.5 MB** |

The `LAUNCHER_` variant is built with `env_light` (`LITE_VERSION=1`, `-Os`, trimmed
IR protocols) — otherwise it does not fit. It is a features-for-space trade-off,
not a free upgrade. The UI states this explicitly.

## Structure

```
server/fwproxy.py         catalogs + binary proxy (stdlib, no dependencies)
server/fw-proxy.service   systemd unit (127.0.0.1:8781, ProtectSystem=strict)
web/index.html            the page
web/js/app.js             UI, catalog, actions
web/js/esp.js             everything that touches the device (esptool-js)
web/js/partitions.js      partition-table and image-header parsers (pure)
web/lib/esptool-bundle.js vendored esptool-js 0.5.x
tools/test-parsers.mjs    run the parsers against real .bin files
deploy.sh                 rollout to /var/www/esp-flasher and /opt/fw-proxy
```

## Proxy API

| Request | Response |
|---|---|
| `GET /api/health` | `{"ok":true}` |
| `GET /api/sources` | list of sources |
| `GET /api/catalog?src=bruce\|launcher\|espterminator\|wizard[&refresh=1]` | normalized catalog |
| `GET /api/bin?u=<url>` | binary served from the same origin, `X-Fw-Cache: hit\|miss` |

`/api/bin` allows only `https` and only hosts from a static allowlist plus those
that appear in the current catalogs. Cache — `/var/cache/fw-proxy/bins`,
LRU-trimmed to 3 GB.

## Deploy

```bash
bash deploy.sh                 # static files + service + health check
systemctl reload caddy         # if the vhost changed
```

Caddy on the NUC serves the `flash.miroslav.diy` vhost (`/api/*` → `127.0.0.1:8781`,
everything else is static). On the edge the domain is added to the shared host
list; TLS is issued automatically.

## Checks

```bash
node tools/test-parsers.mjs /tmp/Bruce-CYD-2432S028.bin      # parsers on a real image
curl -s https://flash.miroslav.diy/api/health
curl -s "https://flash.miroslav.diy/api/catalog?src=bruce" | head -c 200
```

## Limitations

* Web Serial is available only in Chrome / Edge / Opera on desktop, and only over `https`.
* Firmware images belong to their authors — this site only proxies and flashes them.
* The flashing logic is validated by parsing real images and running the catalogs;
  actual writes to hardware are only ever verified on a live board.
