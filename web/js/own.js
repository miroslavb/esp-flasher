// own.js — the "Мои прошивки" source: the owner's own builds, published as static
// files next to this page (/fw/manifest.json + /fw/<file>).
//
// Same origin, so no fw-proxy is involved: the browser fetches the files directly.
// The server answers unknown paths with index.html (Caddy try_files), so every
// download is checked for content type, exact size and SHA-256 from the manifest
// before a single byte goes to the device. Pure helpers, testable in Node
// (tools/test-own-firmware.mjs).

export const OWN_BASE = './fw/';
export const OWN_MANIFEST_URL = `${OWN_BASE}manifest.json`;

const SAFE_FILE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const SAFE_LINK = /^\/(?!\/)[A-Za-z0-9._~\-/#?=&%]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

function parseOffset(v) {
  if (Number.isInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v)) return parseInt(v, 16);
  return null;
}

/** Only same-site absolute paths: the cards must never link off-site. */
function safeLink(v) {
  return typeof v === 'string' && SAFE_LINK.test(v) ? v : null;
}

/**
 * Validate the manifest and convert it to the catalog shape app.js renders
 * ({groups:[{name, devices:[{id, name, family, versions:[{version, files}]}]}]}).
 *
 * An entry without a real size/sha256 is kept but marked unpublished, so its
 * card (setup and wiring links) still shows while flashing is refused.
 */
export function normalizeOwnManifest(json, base = OWN_BASE) {
  if (!json || !Array.isArray(json.firmwares)) throw new Error('в манифесте нет списка firmwares');
  const groups = new Map();
  const seen = new Set();
  for (const fw of json.firmwares) {
    if (!fw || typeof fw.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(fw.id)) {
      throw new Error('запись манифеста без корректного id');
    }
    if (seen.has(fw.id)) throw new Error(`повторяющийся id в манифесте: ${fw.id}`);
    seen.add(fw.id);
    const file = typeof fw.file === 'string' ? fw.file : '';
    if (!SAFE_FILE.test(file) || file.split('/').some((p) => p === '..' || p === '.')) {
      throw new Error(`недопустимый путь файла у ${fw.id}`);
    }
    const offset = parseOffset(fw.offset ?? 0);
    if (offset === null) throw new Error(`недопустимое смещение у ${fw.id}`);
    const published = Number.isInteger(fw.size) && fw.size > 0 && SHA256.test(fw.sha256 || '');
    const device = {
      id: fw.id,
      name: fw.title || fw.id,
      family: fw.chip || '',
      chip: fw.chip || null,
      note: fw.notes || '',
      nativeUsb: fw.native_usb === true,
      published,
      links: { setup: safeLink(fw.setup), wiring: safeLink(fw.wiring) },
      versions: [{
        version: fw.version || '—',
        published: fw.date || '',
        files: [{
          name: file.split('/').pop(),
          url: base + file,
          offset,
          size: published ? fw.size : null,
          sha256: published ? fw.sha256 : null,
          local: true,
        }],
      }],
    };
    const groupName = fw.project || 'Мои прошивки';
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push(device);
  }
  return {
    source: 'own',
    note: json.note || 'Собственные сборки: файлы лежат на этом же сайте, перед прошивкой сверяются размер и SHA-256.',
    device_count: seen.size,
    groups: [...groups].map(([name, devices]) => ({ name, devices })),
  };
}

/** Fetch and normalize the manifest. A missing file comes back as index.html. */
export async function loadOwnManifest({ fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(OWN_MANIFEST_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`манифест: HTTP ${res.status}`);
  if (!/json/i.test(res.headers.get('content-type') || '')) {
    throw new Error('манифест собственных прошивок ещё не опубликован');
  }
  return normalizeOwnManifest(await res.json());
}

export function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Download one manifest file and prove it is the published image:
 * not an HTML fallback, exactly `size` bytes, and the expected SHA-256.
 */
export async function fetchOwnBinary(file, { fetchImpl = globalThis.fetch, subtle = globalThis.crypto?.subtle } = {}) {
  if (!file.sha256 || !file.size) throw new Error(`${file.name}: сборка ещё не опубликована`);
  if (!subtle) throw new Error('нет crypto.subtle — откройте страницу по https');
  const res = await fetchImpl(file.url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`не скачалось ${file.name}: HTTP ${res.status}`);
  if (/text\/html/i.test(res.headers.get('content-type') || '')) {
    throw new Error(`${file.name} нет на сервере (вместо файла пришла страница)`);
  }
  const data = new Uint8Array(await res.arrayBuffer());
  if (data.length !== file.size) {
    throw new Error(`${file.name}: ${data.length} байт, а в манифесте ${file.size}`);
  }
  const digest = toHex(await subtle.digest('SHA-256', data));
  if (digest !== file.sha256) {
    throw new Error(`${file.name}: SHA-256 не совпадает с манифестом (файл повреждён или подменён)`);
  }
  return data;
}
