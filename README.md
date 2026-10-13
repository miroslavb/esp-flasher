# ESP Flasher — flash.miroslav.diy

Web-based ESP32 flasher with **Bruce**, **Launcher**, **ESP Terminator** and
**Wireless Wizard** catalogs, an official **HaleHound** hand-off, the owner's
**own firmware builds** ("Мои прошивки"), a server-side firmware proxy, and a fix
for `LittleFS is full`.

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
web/js/own.js             own-firmware manifest + verified same-origin download (pure)
web/lib/esptool-bundle.js vendored esptool-js 0.5.x
tools/test-parsers.mjs    run the parsers against real .bin files
tools/test-own-firmware.mjs unit checks: image-header probe (C3/ESP32/P4), manifest, downloads
tools/test-own-ui.mjs     browser test for the own-firmware cards and deep link
tools/test-halehound-ui.mjs browser test for the official HaleHound hand-off
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

## Own firmware ("Мои прошивки")

The owner's own builds are plain static files in the web root, deployed by the
project repos that own them (not by this repo):

```
/fw/manifest.json                  list of builds (format below)
/fw/<project>/<image>.bin          merged images
/<project>/                        project pages linked from the cards
                                   (e.g. /sleep-radar/ setup page, /sleep-radar/wiring.html)
```

They are same-origin, so `fw-proxy` is not involved: the front end reads
`/fw/manifest.json` itself (`web/js/own.js`) and flashes through the same
esptool-js path as every other source. A server-side builder in `fwproxy.py`
was rejected on purpose: it would add a second copy of the web-root path to the
proxy, make own builds depend on the proxy being up, and route local files
through a component whose job is fetching remote ones.

Manifest format (`schema` 1; unknown keys are ignored):

```jsonc
{
  "schema": 1,
  "firmwares": [
    {
      "id": "sleep-radar-c3",              // [A-Za-z0-9._-], unique; used by the deep link
      "project": "Sleep Radar",            // card group
      "title": "Sleep Radar — датчик (ESP32-C3)",
      "chip": "ESP32-C3",                  // esptool CHIP_NAME; must match the image header
      "version": "1.0.0",
      "date": "2026-10-13",
      "file": "sleep-radar/sleep-radar-c3-1.0.0.bin",  // relative to /fw/, no "..", no scheme
      "offset": 0,                         // integer or "0x…"
      "size": 1234567,                     // null until published
      "sha256": "…64 hex…",                // null until published
      "native_usb": true,                  // pre-ticks "Нативный USB" (USB-Serial-JTAG boards)
      "setup": "/sleep-radar/",            // same-site paths only; shown on the card
      "wiring": "/sleep-radar/wiring.html",
      "notes": "…"
    }
  ]
}
```

Safety checks before anything is written to a board:

* The server answers unknown paths with `index.html` (Caddy `try_files`), so a
  missing manifest or image arrives as HTML with status 200. Both are rejected by
  content type; images must also match the manifest's exact `size` and `sha256`
  (computed in the browser with `crypto.subtle`). Entries with `size`/`sha256`
  still `null` show their card and links but cannot be flashed.
* The chip family is read from the image header (`0x0`, `0x1000`, or `0x2000` —
  the ESP32-P4 bootloader offset, so P4 merged images written at `0x0` are
  recognised) and compared with esptool-js `CHIP_NAME` of the connected chip.

Deep link: `/?src=own&fw=<id>` opens the source and preselects the entry
(`?src=` works for every non-external source; `fw` matches the board id there).

## Deploy

```bash
bash deploy.sh                 # static files only (the default)
DEPLOY_PROXY=1 bash deploy.sh  # also install + restart the local fw-proxy and health-check it
```

In the current deployment the static root is mirrored to the public front proxy
every few minutes and `fw-proxy` runs on a separate host, so the default deploy
touches only the static files.

`deploy.sh` runs `rsync --delete` but excludes `/fw/` and `/sleep-radar/` (the
`KEEP` list), so deploying the flasher never erases the own-firmware files and
project pages, and those repos can deploy into their own subdirectories
independently. Add a directory to `KEEP` before another project publishes into
the web root.

Caddy on the NUC serves the `flash.miroslav.diy` vhost (`/api/*` → `127.0.0.1:8781`,
everything else is static). On the edge the domain is added to the shared host
list; TLS is issued automatically.

## Checks

```bash
node tools/test-parsers.mjs /tmp/Bruce-CYD-2432S028.bin      # parsers on a real image
node tools/test-own-firmware.mjs [/var/www/esp-flasher/fw/manifest.json]  # own builds: unit checks (+ a real manifest)
node tools/test-own-ui.mjs                                   # own-firmware cards + deep link in a browser
node tools/test-halehound-ui.mjs                             # official HaleHound link + security boundary
curl -s https://flash.miroslav.diy/api/health
curl -s "https://flash.miroslav.diy/api/catalog?src=bruce" | head -c 200
```

## HaleHound boundary

The HaleHound source card deliberately opens the official
[`flash.halehound.com`](https://flash.halehound.com/) installer instead of using
`fw-proxy`. Its publisher protects board manifests and firmware downloads with a
per-user human-verification token and validates SHA-256 firmware fingerprints.
Do not add a proxy adapter, mirror, token replay, or any other bypass: the direct
official hand-off preserves both of those upstream controls.

## Limitations

* Web Serial is available only in Chrome / Edge / Opera on desktop, and only over `https`.
* Firmware images belong to their authors — this site only proxies and flashes them.
* The flashing logic is validated by parsing real images and running the catalogs;
  actual writes to hardware are only ever verified on a live board.
