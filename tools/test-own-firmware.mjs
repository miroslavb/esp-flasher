// Checks for the "Мои прошивки" source and merged-image chip detection.
//   node tools/test-own-firmware.mjs                     # self-test (synthetic images)
//   node tools/test-own-firmware.mjs path/to/manifest.json
//       … additionally validates a real manifest and every published file next
//       to it (size, SHA-256, image header chip == manifest chip), so it can gate
//       a deploy of /fw/.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectImage, fmtHex } from '../web/js/partitions.js';
import { normalizeOwnManifest, fetchOwnBinary } from '../web/js/own.js';

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

/** Minimal merged image: bootloader header at `at`, partition table at 0x8000. */
function mergedImage(chipId, at) {
  const img = new Uint8Array(0x9000).fill(0xff);
  img.set([0xe9, 0x03, 0x02, 0x20], at);      // magic, segments, DIO, 4MB/40MHz
  img[at + 12] = chipId & 0xff;
  img[at + 13] = chipId >> 8;
  const entry = (i, type, subtype, offset, size, label) => {
    const o = 0x8000 + i * 32;
    const v = new DataView(img.buffer);
    v.setUint16(o, 0x50aa, true);
    img[o + 2] = type;
    img[o + 3] = subtype;
    v.setUint32(o + 4, offset, true);
    v.setUint32(o + 8, size, true);
    img.fill(0, o + 12, o + 28);
    [...label].forEach((c, j) => { img[o + 12 + j] = c.charCodeAt(0); });
    v.setUint32(o + 28, 0, true);
  };
  entry(0, 1, 0x02, 0x9000, 0x6000, 'nvs');
  entry(1, 0, 0x00, 0x10000, 0x300000, 'factory');
  img[0x8000 + 64] = 0xeb;
  img[0x8000 + 65] = 0xeb;
  return img;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ------------------------------------------------------------------ image header probe

await check('ESP32-C3 merged image: header at 0x0', () => {
  const info = inspectImage(mergedImage(0x0005, 0x0), 0);
  assert.equal(info.header.chipName, 'ESP32-C3');
  assert.equal(info.header.offset, 0x0);
  assert.equal(info.merged, true);
  assert.deepEqual(info.partitions.map((p) => p.label), ['nvs', 'factory']);
});

await check('ESP32 merged image: header at 0x1000', () => {
  const info = inspectImage(mergedImage(0x0000, 0x1000), 0);
  assert.equal(info.header.chipName, 'ESP32');
  assert.equal(info.header.offset, 0x1000);
});

await check('ESP32-P4 merged image: header at 0x2000 (was missed before)', () => {
  const info = inspectImage(mergedImage(0x0012, 0x2000), 0);
  assert.equal(info.header?.chipName, 'ESP32-P4');
  assert.equal(info.header.offset, 0x2000);
  assert.equal(info.merged, true);
});

await check('app blob at a non-zero address is not treated as merged', () => {
  const info = inspectImage(mergedImage(0x0005, 0x0), 0x10000);
  assert.equal(info.merged, false);
  assert.equal(info.header.chipName, 'ESP32-C3');
});

// ------------------------------------------------------------------ manifest

const good = {
  firmwares: [
    { id: 'demo-c3', title: 'Demo', chip: 'ESP32-C3', version: '1.2.3', file: 'demo/demo-c3-1.2.3.bin',
      offset: 0, size: 4, sha256: sha256(Buffer.from([1, 2, 3, 4])), native_usb: true,
      setup: '/demo/', wiring: '/demo/wiring.html', project: 'Demo' },
    { id: 'demo-p4', chip: 'ESP32-P4', version: '0.1.0', file: 'demo/demo-p4-0.1.0.bin',
      offset: '0x0', size: null, sha256: null, setup: 'https://evil.example/', wiring: '//evil.example/x' },
  ],
};

await check('manifest normalizes into the catalog shape', () => {
  const cat = normalizeOwnManifest(good);
  assert.equal(cat.device_count, 2);
  const [c3, p4] = cat.groups.flatMap((g) => g.devices);
  assert.equal(c3.published, true);
  assert.equal(c3.nativeUsb, true);
  assert.deepEqual(c3.links, { setup: '/demo/', wiring: '/demo/wiring.html' });
  assert.equal(c3.versions[0].files[0].url, './fw/demo/demo-c3-1.2.3.bin');
  assert.equal(p4.published, false, 'placeholder size/sha256 means unpublished');
  assert.equal(p4.versions[0].files[0].offset, 0);
  assert.deepEqual(p4.links, { setup: null, wiring: null }, 'off-site links are dropped');
});

for (const [why, file] of [
  ['parent traversal', '../secret.bin'],
  ['absolute path', '/etc/passwd'],
  ['URL', 'https://evil.example/x.bin'],
  ['dot segment', 'a/./b.bin'],
]) {
  await check(`manifest rejects ${why}`, () => {
    assert.throws(() => normalizeOwnManifest({ firmwares: [{ id: 'x', file }] }), /путь/);
  });
}

await check('manifest rejects duplicate ids', () => {
  assert.throws(() => normalizeOwnManifest({ firmwares: [good.firmwares[0], good.firmwares[0]] }), /повторяющийся/);
});

// ------------------------------------------------------------------ verified download

const file = normalizeOwnManifest(good).groups[0].devices[0].versions[0].files[0];
const fakeFetch = (body, type = 'application/octet-stream', status = 200) => async () =>
  new Response(body, { status, headers: { 'content-type': type } });

await check('download accepted when size and SHA-256 match', async () => {
  const data = await fetchOwnBinary(file, { fetchImpl: fakeFetch(new Uint8Array([1, 2, 3, 4])) });
  assert.deepEqual([...data], [1, 2, 3, 4]);
});

for (const [why, impl, re] of [
  ['HTML fallback page (missing file behind try_files)', fakeFetch('<!doctype html>', 'text/html; charset=utf-8'), /страница/],
  ['wrong size', fakeFetch(new Uint8Array([1, 2, 3])), /байт/],
  ['wrong SHA-256', fakeFetch(new Uint8Array([1, 2, 3, 5])), /SHA-256/],
  ['HTTP 404', fakeFetch('nope', 'text/plain', 404), /404/],
]) {
  await check(`download refused: ${why}`, async () => {
    await assert.rejects(fetchOwnBinary(file, { fetchImpl: impl }), re);
  });
}

await check('download refused for an unpublished entry', async () => {
  const unpublished = normalizeOwnManifest(good).groups[1].devices[0].versions[0].files[0];
  await assert.rejects(fetchOwnBinary(unpublished, { fetchImpl: fakeFetch('') }), /не опубликована/);
});

// ------------------------------------------------------------------ optional real manifest

const manifestPath = process.argv[2];
if (manifestPath) {
  const json = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const cat = normalizeOwnManifest(json);
  const root = dirname(resolve(manifestPath));
  for (const d of cat.groups.flatMap((g) => g.devices)) {
    const f = d.versions[0].files[0];
    const path = resolve(root, f.url.replace(/^\.\/fw\//, ''));
    if (!d.published) {
      console.log(`--  ${d.id}: not published yet (placeholder size/sha256)`);
      continue;
    }
    await check(`${d.id}: ${f.name} matches manifest and is a ${d.chip} image`, () => {
      assert.ok(existsSync(path), `missing ${path}`);
      const bytes = new Uint8Array(readFileSync(path));
      assert.equal(bytes.length, f.size, 'size');
      assert.equal(sha256(bytes), f.sha256, 'sha256');
      const info = inspectImage(bytes, f.offset);
      assert.ok(info.header, `no image header at 0x0/0x1000/0x2000`);
      assert.equal(info.header.chipName, d.chip, `header chip @ ${fmtHex(info.header.offset)}`);
    });
  }
}

console.log(`\nOK (${passed} checks)`);
