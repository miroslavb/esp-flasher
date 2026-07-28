#!/usr/bin/env python3
"""fw-proxy — server-side firmware catalog + binary proxy for the ESP flasher.

Why this exists
---------------
Public web flashers fail with "Failed to download firmware: Failed to fetch"
because GitHub answers a release-asset request with a 302 to
release-assets.githubusercontent.com and that 302 carries **no**
Access-Control-Allow-Origin header, so the browser aborts the cross-origin
fetch. Nothing on the page can work around that. The fix is to fetch the
binary server-side and re-serve it same-origin, which is what /api/bin does.

The same proxy also:
  * caches the three upstream catalogs (GitHub API is 60 req/h unauthenticated),
  * normalises them into one schema so the UI has a single code path,
  * caches downloaded binaries on disk so a re-flash is instant and works even
    if GitHub is unreachable at that moment.

Stdlib only, no dependencies. Binds to localhost; Caddy terminates TLS.
"""

from __future__ import annotations

import hashlib
import html
import json
import logging
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# --------------------------------------------------------------------------- config

HOST = os.environ.get("FWPROXY_HOST", "127.0.0.1")
PORT = int(os.environ.get("FWPROXY_PORT", "8781"))
CACHE_DIR = os.environ.get("FWPROXY_CACHE", "/var/cache/fw-proxy")
BIN_DIR = os.path.join(CACHE_DIR, "bins")
CATALOG_TTL = int(os.environ.get("FWPROXY_CATALOG_TTL", str(6 * 3600)))
BIN_CACHE_MAX_BYTES = int(os.environ.get("FWPROXY_BIN_CACHE_MAX", str(3 * 1024**3)))
UA = "esp-flasher.miroslav.diy (+https://flash.miroslav.diy)"
HTTP_TIMEOUT = 60

BRUCE_REPO = "BruceDevices/firmware"
LAUNCHER_REPO = "bmorcelli/Launcher"
LAUNCHER_MANIFEST = "https://bmorcelli.github.io/Launcher/manifest.json"
ESPTERM_MANIFEST = "https://espterminator.com/firmware/manifest.json"
WIZARD_BASE = "https://wireless-wizard-flasher.bkenned1.workers.dev/"

# Hosts we will proxy binaries from no matter what the catalogs say.
STATIC_ALLOWED_HOSTS = {
    "github.com",
    "api.github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "codeload.github.com",
    "bmorcelli.github.io",
    "espterminator.com",
    "proxy.espterminator.com",
    "wireless-wizard-flasher.bkenned1.workers.dev",
}
# Hosts learned from the catalogs at refresh time (ESP Terminator lists a few
# vendor-hosted binaries). Guarded by _allow_lock.
_dynamic_allowed_hosts: set[str] = set()
_allow_lock = threading.Lock()

log = logging.getLogger("fwproxy")

# --------------------------------------------------------------------------- helpers


def _http_get(url: str, accept: str | None = None) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    if accept:
        req.add_header("Accept", accept)
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return resp.read()


def _http_get_json(url: str):
    return json.loads(_http_get(url, accept="application/vnd.github+json").decode("utf-8"))


def _atomic_write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _guess_family(name: str) -> str | None:
    """Very conservative chip-family hint from a build name.

    Only fires on unambiguous, delimiter-bounded tokens. The authoritative
    answer comes from the image header, which the browser parses at flash
    time, so a None here is perfectly fine — it just means "unknown".
    """
    n = name.lower()
    for token, family in (
        ("esp32-s3", "ESP32-S3"),
        ("esp32s3", "ESP32-S3"),
        ("esp32-c3", "ESP32-C3"),
        ("esp32c3", "ESP32-C3"),
        ("esp32-c5", "ESP32-C5"),
        ("esp32c5", "ESP32-C5"),
        ("esp32-c6", "ESP32-C6"),
        ("esp32c6", "ESP32-C6"),
        ("esp32-s2", "ESP32-S2"),
        ("esp32s2", "ESP32-S2"),
    ):
        if token in n:
            return family
    if re.search(r"(^|[-_])s3([-_]|$)", n):
        return "ESP32-S3"
    if re.search(r"(^|[-_])c3([-_]|$)", n):
        return "ESP32-C3"
    if re.search(r"(^|[-_])c5([-_]|$)", n):
        return "ESP32-C5"
    if re.search(r"(^|[-_])c6([-_]|$)", n):
        return "ESP32-C6"
    return None


def _norm_key(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


# --------------------------------------------------------------------------- catalogs
#
# Normalised catalog schema (identical for all three sources so the UI has one
# code path):
#
# { source, title, homepage, fetched_at, note,
#   groups: [ { name, devices: [ { id, name, family, link, note,
#                                  versions: [ { version, published, files: [
#                                      { name, url, offset, size } ] } ] } ] } ] }


def _bruce_group(build: str) -> str:
    b = build.lower()
    if b.startswith("launcher_"):
        return "Bruce over Launcher (большой раздел LittleFS)"
    if "cyd" in b:
        return "CYD"
    if b.startswith("m5stack") or "stick" in b or "cardputer" in b or "dinmeter" in b:
        return "M5Stack"
    if b.startswith("lilygo") or b.startswith("t-") or "t-embed" in b or "t-deck" in b:
        return "Lilygo"
    if "elecrow" in b:
        return "Elecrow"
    if "marauder" in b:
        return "Marauder-совместимые"
    if "waveshare" in b:
        return "Waveshare"
    if b.startswith("esp32") or b.startswith("headless") or "generic" in b:
        return "Generic ESP32"
    return "Прочие"


def _github_releases(repo: str, limit: int = 12) -> list:
    return _http_get_json(f"https://api.github.com/repos/{repo}/releases?per_page={limit}")


def _build_bruce_catalog() -> dict:
    releases = _github_releases(BRUCE_REPO)
    devices: dict[str, dict] = {}
    for rel in releases:
        if rel.get("draft"):
            continue
        tag = rel.get("tag_name") or rel.get("name") or "?"
        published = (rel.get("published_at") or "")[:10]
        for asset in rel.get("assets", []):
            name = asset.get("name", "")
            if not name.endswith(".bin"):
                continue
            build = re.sub(r"^Bruce-", "", name[:-4])
            dev = devices.setdefault(
                build,
                {
                    "id": build,
                    "name": build,
                    "family": _guess_family(build),
                    "link": None,
                    "group": _bruce_group(build),
                    "versions": [],
                },
            )
            dev["versions"].append(
                {
                    "version": tag,
                    "published": published,
                    "prerelease": bool(rel.get("prerelease")),
                    "files": [
                        {
                            "name": name,
                            "url": asset.get("browser_download_url"),
                            "offset": 0,  # Bruce ships merged images written at 0x0
                            "size": asset.get("size"),
                        }
                    ],
                }
            )
    return _pack(
        "bruce",
        "Bruce",
        "https://bruce.computer/flasher",
        devices,
        note="Bruce публикует слитые (merged) образы — пишутся целиком по адресу 0x0.",
    )


def _build_launcher_catalog() -> dict:
    releases = _github_releases(LAUNCHER_REPO)
    meta: dict[str, dict] = {}
    try:
        manifest = json.loads(_http_get(LAUNCHER_MANIFEST).decode("utf-8"))
        for vendor, entries in manifest.items():
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                for key in filter(None, (entry.get("id"), entry.get("name"))):
                    meta[_norm_key(str(key))] = {
                        "vendor": vendor,
                        "name": entry.get("name"),
                        "family": entry.get("family"),
                        "link": entry.get("link") or None,
                    }
    except Exception as exc:  # metadata is a nicety, never fatal
        log.warning("launcher manifest unavailable: %s", exc)

    devices: dict[str, dict] = {}
    for rel in releases:
        if rel.get("draft"):
            continue
        tag = rel.get("tag_name") or rel.get("name") or "?"
        published = (rel.get("published_at") or "")[:10]
        for asset in rel.get("assets", []):
            name = asset.get("name", "")
            if not name.endswith(".bin"):
                continue
            build = re.sub(r"^Launcher-", "", name[:-4])
            info = meta.get(_norm_key(build)) or meta.get(_norm_key(build.replace("-", ""))) or {}
            dev = devices.setdefault(
                build,
                {
                    "id": build,
                    "name": info.get("name") or build,
                    "family": info.get("family") or _guess_family(build),
                    "link": info.get("link"),
                    "group": info.get("vendor") or _bruce_group(build),
                    "versions": [],
                },
            )
            dev["versions"].append(
                {
                    "version": tag,
                    "published": published,
                    "prerelease": bool(rel.get("prerelease")),
                    "files": [
                        {
                            "name": name,
                            "url": asset.get("browser_download_url"),
                            "offset": 0,
                            "size": asset.get("size"),
                        }
                    ],
                }
            )
    return _pack(
        "launcher",
        "Launcher (bmorcelli)",
        "https://bmorcelli.github.io/Launcher/webflasher.html",
        devices,
        note="Launcher — мультизагрузчик: ставится как основная прошивка, дальше приложения ставятся поверх.",
    )


def _parse_addr(value, default: int = 0) -> int:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        v = value.strip()
        try:
            return int(v, 16) if v.lower().startswith("0x") else int(v, 0)
        except ValueError:
            return default
    return default


def _build_espterm_catalog() -> dict:
    raw = json.loads(_http_get(ESPTERM_MANIFEST).decode("utf-8"))
    options = raw.get("options") or []
    devices: dict[str, dict] = {}
    for opt in options:
        name = opt.get("name") or "?"
        fw_type = (opt.get("type") or "other").strip()
        key = f"{fw_type}/{name}"

        def files_of(entry) -> list:
            out = []
            for f in entry.get("files") or []:
                url = f.get("downloadUrl") or f.get("url")
                if not url:
                    continue
                out.append(
                    {
                        "name": f.get("name") or url.rsplit("/", 1)[-1],
                        "url": url,
                        "offset": _parse_addr(f.get("address"), 0),
                        "size": None,
                    }
                )
            if not out and entry.get("downloadUrl"):
                out = [
                    {
                        "name": entry["downloadUrl"].rsplit("/", 1)[-1],
                        "url": entry["downloadUrl"],
                        "offset": 0,
                        "size": None,
                    }
                ]
            return out

        versions = []
        seen = set()
        for entry in (opt.get("availableVersions") or []) + [opt]:
            ver = entry.get("version") or entry.get("name") or opt.get("version") or "?"
            if ver in seen:
                continue
            files = files_of(entry)
            if not files:
                continue
            seen.add(ver)
            versions.append(
                {
                    "version": ver,
                    "published": entry.get("releaseDate") or "",
                    "prerelease": False,
                    "files": files,
                }
            )
        if not versions:
            continue
        devices[key] = {
            "id": key,
            "name": name,
            "family": opt.get("device") or None,
            "link": opt.get("webUpdaterUrl") or None,
            "group": fw_type,
            "note": opt.get("note") or None,
            "versions": versions,
        }
    return _pack(
        "espterminator",
        "ESP Terminator",
        "https://espterminator.com/",
        devices,
        note="Сводный каталог ESP Terminator (Bruce, Launcher, Marauder, GhostESP, Meshtastic и др.).",
    )


def _wizard_group(dev_id: str) -> str:
    d = dev_id.lower()
    if d.startswith("cyd"):
        return "CYD"
    if d.startswith("xiao"):
        return "Seeed XIAO"
    return "Waveshare"


def _build_wizard_catalog() -> dict:
    """Wireless Wizard (bkenned1) — static esp-web-tools site on a Cloudflare Worker.

    The page's <select> is the device list; each device has an esp-web-tools
    manifest at manifests/<id>.json whose part paths are relative to the
    manifest itself. The inline DEVICES JS object only adds blurbs/notes, so
    it is parsed best-effort and is never fatal.
    """
    page = _http_get(WIZARD_BASE).decode("utf-8", "replace")
    options = re.findall(r'<option\s+value="([\w-]+)"\s*>([^<]*)</option>', page)

    meta: dict[str, dict] = {}
    for m in re.finditer(r"'([\w-]+)'\s*:\s*\{((?:\\.|[^}])*)\}", page):
        fields = {}
        for key in ("chip", "ver", "blurb", "note"):
            fm = re.search(key + r":\s*'((?:\\.|[^'\\])*)'", m.group(2))
            if fm:
                fields[key] = re.sub(r"\\(.)", r"\1", fm.group(1))
        if fields:
            meta[m.group(1)] = fields

    if not options:  # page redesign fallback: DEVICES keys, then manifest hrefs
        ids = list(meta) or sorted(set(re.findall(r"manifests/([\w-]+)\.json", page)))
        options = [(i, i) for i in ids]

    devices: dict[str, dict] = {}
    for dev_id, label in options:
        manifest_url = urllib.parse.urljoin(WIZARD_BASE, f"manifests/{dev_id}.json")
        try:
            manifest = json.loads(_http_get(manifest_url).decode("utf-8"))
        except Exception as exc:
            log.warning("wizard manifest %s unavailable: %s", dev_id, exc)
            continue
        files = []
        family = None
        for build in manifest.get("builds") or []:
            family = family or build.get("chipFamily")
            for part in build.get("parts") or []:
                path = part.get("path")
                if not path:
                    continue
                files.append(
                    {
                        "name": str(path).rsplit("/", 1)[-1],
                        "url": urllib.parse.urljoin(manifest_url, str(path)),
                        "offset": _parse_addr(part.get("offset"), 0),
                        "size": None,
                    }
                )
        if not files:
            continue
        info = meta.get(dev_id, {})
        devices[dev_id] = {
            "id": dev_id,
            "name": html.unescape(label).strip() or dev_id,
            "family": family or info.get("chip") or _guess_family(dev_id),
            "link": WIZARD_BASE,
            "group": _wizard_group(dev_id),
            "note": " ".join(filter(None, (info.get("blurb"), info.get("note")))) or None,
            "versions": [
                {
                    "version": manifest.get("version") or info.get("ver") or "?",
                    "published": "",
                    "prerelease": False,
                    "files": files,
                }
            ],
        }
    return _pack(
        "wizard",
        "Wireless Wizard",
        WIZARD_BASE,
        devices,
        note="Wireless Wizard (bkenned1): сборки для CYD и fleet-нод XIAO/Waveshare. "
        "На устройство — одна актуальная версия; при первой установке автор рекомендует "
        "полное стирание (галочка «стереть всю флеш»).",
    )


def _pack(source: str, title: str, homepage: str, devices: dict, note: str = "") -> dict:
    groups: dict[str, list] = {}
    hosts: set[str] = set()
    for dev in devices.values():
        dev["versions"].sort(key=lambda v: (v.get("published") or "", v.get("version") or ""), reverse=True)
        for ver in dev["versions"]:
            for f in ver["files"]:
                host = urllib.parse.urlparse(f["url"]).hostname
                if host:
                    hosts.add(host.lower())
        groups.setdefault(dev.pop("group", "Прочие"), []).append(dev)
    with _allow_lock:
        _dynamic_allowed_hosts.update(hosts)
    packed = [
        {"name": g, "devices": sorted(devs, key=lambda d: d["name"].lower())}
        for g, devs in sorted(groups.items())
    ]
    return {
        "source": source,
        "title": title,
        "homepage": homepage,
        "note": note,
        "fetched_at": int(time.time()),
        "device_count": sum(len(g["devices"]) for g in packed),
        "groups": packed,
    }


BUILDERS = {
    "bruce": _build_bruce_catalog,
    "launcher": _build_launcher_catalog,
    "espterminator": _build_espterm_catalog,
    "wizard": _build_wizard_catalog,
}

_catalog_locks = {name: threading.Lock() for name in BUILDERS}


def _catalog_path(src: str) -> str:
    return os.path.join(CACHE_DIR, f"catalog-{src}.json")


def _read_cached_catalog(src: str) -> dict | None:
    try:
        with open(_catalog_path(src), "rb") as fh:
            return json.loads(fh.read().decode("utf-8"))
    except Exception:
        return None


def get_catalog(src: str, force: bool = False) -> dict:
    """Return a catalog, refreshing it if stale. Never raises if a cache exists."""
    cached = _read_cached_catalog(src)
    fresh = cached and (time.time() - cached.get("fetched_at", 0) < CATALOG_TTL)
    if cached and fresh and not force:
        # Re-seed the binary allowlist from cache after a restart.
        _seed_hosts_from_catalog(cached)
        return cached
    with _catalog_locks[src]:
        cached2 = _read_cached_catalog(src)
        if cached2 and not force and time.time() - cached2.get("fetched_at", 0) < CATALOG_TTL:
            _seed_hosts_from_catalog(cached2)
            return cached2
        try:
            built = BUILDERS[src]()
            _atomic_write(_catalog_path(src), json.dumps(built, ensure_ascii=False).encode("utf-8"))
            log.info("catalog %s refreshed: %d devices", src, built["device_count"])
            return built
        except Exception as exc:
            log.warning("catalog %s refresh failed: %s", src, exc)
            if cached:
                cached["stale"] = True
                cached["error"] = str(exc)
                _seed_hosts_from_catalog(cached)
                return cached
            raise


def _seed_hosts_from_catalog(cat: dict) -> None:
    hosts = set()
    for group in cat.get("groups", []):
        for dev in group.get("devices", []):
            for ver in dev.get("versions", []):
                for f in ver.get("files", []):
                    host = urllib.parse.urlparse(f.get("url", "")).hostname
                    if host:
                        hosts.add(host.lower())
    if hosts:
        with _allow_lock:
            _dynamic_allowed_hosts.update(hosts)


def refresh_loop() -> None:
    while True:
        for src in BUILDERS:
            try:
                get_catalog(src)
            except Exception as exc:
                log.warning("background refresh %s: %s", src, exc)
        time.sleep(max(300, CATALOG_TTL // 2))


# --------------------------------------------------------------------------- binaries


def _host_allowed(url: str) -> bool:
    parts = urllib.parse.urlparse(url)
    if parts.scheme != "https" or not parts.hostname:
        return False
    host = parts.hostname.lower()
    if host in STATIC_ALLOWED_HOSTS:
        return True
    if host.endswith(".githubusercontent.com"):
        return True
    with _allow_lock:
        return host in _dynamic_allowed_hosts


def _bin_cache_path(url: str) -> str:
    return os.path.join(BIN_DIR, hashlib.sha256(url.encode("utf-8")).hexdigest() + ".bin")


def _prune_bin_cache() -> None:
    try:
        entries = []
        total = 0
        for name in os.listdir(BIN_DIR):
            if not name.endswith(".bin"):
                continue
            path = os.path.join(BIN_DIR, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            entries.append((st.st_atime, st.st_size, path))
            total += st.st_size
        if total <= BIN_CACHE_MAX_BYTES:
            return
        for _atime, size, path in sorted(entries):
            try:
                os.unlink(path)  # only ever files this process wrote into its own cache dir
                total -= size
            except OSError:
                pass
            if total <= BIN_CACHE_MAX_BYTES:
                break
    except FileNotFoundError:
        pass


def fetch_binary(url: str) -> tuple[str, bool]:
    """Return (path_on_disk, was_cached). Downloads through the server, not the browser."""
    path = _bin_cache_path(url)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        os.utime(path, None)
        return path, True
    os.makedirs(BIN_DIR, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/octet-stream"})
    fd, tmp = tempfile.mkstemp(dir=BIN_DIR, prefix=".dl-")
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp, os.fdopen(fd, "wb") as out:
            shutil.copyfileobj(resp, out, 1024 * 256)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    _prune_bin_cache()
    return path, False


# --------------------------------------------------------------------------- HTTP


class Handler(BaseHTTPRequestHandler):
    server_version = "fw-proxy/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # route through logging, not stderr spam
        log.info("%s %s", self.address_string(), fmt % args)

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, payload, extra: dict | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(code, body, "application/json; charset=utf-8", extra)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parts = urllib.parse.urlparse(self.path)
        route = parts.path.rstrip("/") or "/"
        query = urllib.parse.parse_qs(parts.query)

        if route in ("/api/health", "/health"):
            self._json(200, {"ok": True, "ts": int(time.time())})
            return

        if route == "/api/catalog":
            src = (query.get("src") or ["bruce"])[0]
            if src not in BUILDERS:
                self._json(404, {"error": f"unknown source {src!r}", "sources": list(BUILDERS)})
                return
            force = (query.get("refresh") or ["0"])[0] in ("1", "true", "yes")
            try:
                cat = get_catalog(src, force=force)
            except Exception as exc:
                self._json(502, {"error": f"catalog unavailable: {exc}"})
                return
            self._json(200, cat, {"Cache-Control": "public, max-age=300"})
            return

        if route == "/api/sources":
            self._json(
                200,
                {
                    "sources": [
                        {"id": "bruce", "title": "Bruce", "homepage": "https://bruce.computer/flasher"},
                        {
                            "id": "launcher",
                            "title": "Launcher",
                            "homepage": "https://bmorcelli.github.io/Launcher/webflasher.html",
                        },
                        {
                            "id": "espterminator",
                            "title": "ESP Terminator",
                            "homepage": "https://espterminator.com/",
                        },
                        {
                            "id": "wizard",
                            "title": "Wireless Wizard",
                            "homepage": WIZARD_BASE,
                        },
                    ]
                },
            )
            return

        if route == "/api/bin":
            url = (query.get("u") or [""])[0]
            if not url:
                self._json(400, {"error": "missing ?u="})
                return
            if not _host_allowed(url):
                self._json(403, {"error": "host not allowed", "url": url})
                return
            try:
                path, cached = fetch_binary(url)
            except urllib.error.HTTPError as exc:
                self._json(502, {"error": f"upstream {exc.code}", "url": url})
                return
            except Exception as exc:
                self._json(502, {"error": str(exc), "url": url})
                return
            size = os.path.getsize(path)
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(size))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "public, max-age=86400")
            self.send_header("X-Fw-Cache", "hit" if cached else "miss")
            self.end_headers()
            if self.command == "HEAD":
                return
            with open(path, "rb") as fh:
                shutil.copyfileobj(fh, self.wfile, 1024 * 256)
            return

        self._json(404, {"error": "not found", "path": route})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", stream=sys.stdout
    )
    os.makedirs(BIN_DIR, exist_ok=True)
    threading.Thread(target=refresh_loop, daemon=True).start()
    srv = Server((HOST, PORT), Handler)
    log.info("fw-proxy listening on http://%s:%d (cache %s)", HOST, PORT, CACHE_DIR)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
