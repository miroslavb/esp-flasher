// Browser-level contract for the "Мои прошивки" source and its deep link.
// Serves a copy of web/ plus a fixture /fw/ (one published ESP32-C3 image, one
// unpublished ESP32-P4 entry) from a local static server and drives it with
// agent-browser. Set OWN_UI_FIXTURE_DIR to choose where the fixture copy is
// created (not TMPDIR: Chrome inherits it and its socket path gets too long).
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browser = (args) => execFileSync('agent-browser', args, { encoding: 'utf8' }).trim();
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const evalJson = (expr) => {
  const decoded = JSON.parse(browser(['eval', expr]));
  return typeof decoded === 'string' ? JSON.parse(decoded) : decoded;
};

async function unusedLocalPort() {
  const probe = createServer();
  await new Promise((resolveListen) => probe.listen(0, '127.0.0.1', resolveListen));
  const { port } = probe.address();
  await new Promise((resolveClose) => probe.close(resolveClose));
  return port;
}

// ------------------------------------------------------------------ fixture site
const site = mkdtempSync(join(process.env.OWN_UI_FIXTURE_DIR || tmpdir(), 'esp-flasher-own-'));
cpSync(resolve(root, 'web'), site, { recursive: true });
mkdirSync(join(site, 'fw', 'fixture'), { recursive: true });
const image = new Uint8Array(0x9000).fill(0xff);
image.set([0xe9, 0x03, 0x02, 0x20], 0);
image[12] = 0x05; // ESP32-C3
writeFileSync(join(site, 'fw', 'fixture', 'fixture-c3-1.0.0.bin'), image);
const sha256 = createHash('sha256').update(image).digest('hex');
writeFileSync(join(site, 'fw', 'manifest.json'), JSON.stringify({
  firmwares: [
    { id: 'fixture-c3', title: 'Fixture C3', project: 'Fixture', chip: 'ESP32-C3', version: '1.0.0',
      file: 'fixture/fixture-c3-1.0.0.bin', offset: 0, size: image.length, sha256, native_usb: true,
      setup: '/fixture/', wiring: '/fixture/wiring.html', notes: 'fixture note' },
    { id: 'fixture-p4', title: 'Fixture P4', project: 'Fixture', chip: 'ESP32-P4', version: '0.1.0',
      file: 'fixture/fixture-p4-0.1.0.bin', offset: 0, size: null, sha256: null, setup: '/fixture/' },
  ],
}));

const port = await unusedLocalPort();
const staticServer = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', site], {
  stdio: 'ignore',
});
const base = `http://127.0.0.1:${port}`;

try {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`${base}/`);
      if (response.ok) break;
    } catch { /* server is still starting */ }
    if (attempt === 29) throw new Error('local static server did not become ready');
    await delay(100);
  }

  try { browser(['close']); } catch { /* no stale session */ }

  // 1. Deep link preselects the entry and shows its card with setup/wiring links.
  browser(['open', `${base}/?src=own&fw=fixture-c3`]);
  browser(['wait', 800]);
  const ui = evalJson(`JSON.stringify({
    activeSource: document.querySelector('#sources .source.on')?.textContent,
    cards: [...document.querySelectorAll('#ownCards .own-card')].map((c) => c.dataset.fw),
    onCard: document.querySelector('#ownCards .own-card.on')?.dataset.fw,
    links: [...document.querySelectorAll('#ownCards .own-card.on .own-links a')].map((a) => a.getAttribute('href')),
    pickGridHidden: document.getElementById('pickGrid').classList.contains('hidden'),
    nativeUsb: document.getElementById('nativeUsb').checked,
    files: document.getElementById('fileList').textContent,
    unpublished: document.querySelector('[data-fw="fixture-p4"]')?.textContent,
  })`);
  assert.match(ui.activeSource, /Мои прошивки/);
  assert.deepEqual(ui.cards, ['fixture-c3', 'fixture-p4']);
  assert.equal(ui.onCard, 'fixture-c3');
  assert.deepEqual(ui.links, ['/fixture/', '/fixture/wiring.html']);
  assert.equal(ui.pickGridHidden, true);
  assert.equal(ui.nativeUsb, true);
  assert.match(ui.files, /fixture-c3-1\.0\.0\.bin.*0x000000/);
  assert.match(ui.files, new RegExp(`SHA-256: ${sha256}`));
  assert.match(ui.unpublished, /ещё не опубликована/);
  console.log('deep link /?src=own&fw=fixture-c3 preselects the card: OK');

  // 2. The verified download runs in the real browser (crypto.subtle, same origin).
  const dl = evalJson(`(async () => {
    const m = await import('./js/own.js?v=1.1.0');
    const cat = await m.loadOwnManifest();
    const f = cat.groups[0].devices[0].versions[0].files[0];
    const ok = (await m.fetchOwnBinary(f)).length;
    const errs = [];
    for (const bad of [{ ...f, sha256: '0'.repeat(64) }, { ...f, url: './fw/fixture/missing.bin' }, { ...f, url: './index.html' }]) {
      try { await m.fetchOwnBinary(bad); errs.push('accepted'); } catch (e) { errs.push(e.message); }
    }
    return JSON.stringify({ ok, errs });
  })()`);
  assert.equal(dl.ok, image.length);
  assert.match(dl.errs[0], /SHA-256/);
  assert.match(dl.errs[1], /404/);
  assert.match(dl.errs[2], /вместо файла пришла страница/);
  console.log('verified same-origin download (size + SHA-256, HTML fallback refused): OK');

  // 3. Clicking another card updates the selection and the shareable URL.
  const after = evalJson(`(async () => {
    document.querySelector('[data-fw="fixture-p4"] .own-pick').click();
    await new Promise((r) => setTimeout(r, 100));
    return JSON.stringify({ url: location.search, on: document.querySelector('#ownCards .own-card.on')?.dataset.fw,
      nativeUsb: document.getElementById('nativeUsb').checked });
  })()`);
  assert.equal(after.url, '?src=own&fw=fixture-p4');
  assert.equal(after.on, 'fixture-p4');
  assert.equal(after.nativeUsb, false);
  console.log('card click updates selection and URL: OK');

  // 4. The default page still starts on Bruce and lists every source.
  browser(['open', `${base}/`]);
  browser(['wait', 500]);
  const plain = evalJson(`JSON.stringify({
    sources: [...document.querySelectorAll('#sources .source strong')].map((s) => s.textContent),
    active: document.querySelector('#sources .source.on strong')?.textContent,
    ownHidden: document.getElementById('ownCards').classList.contains('hidden'),
  })`);
  assert.deepEqual(plain.sources, ['Bruce', 'Launcher', 'ESP Terminator', 'Wireless Wizard', 'Мои прошивки', 'HaleHound', 'Capybara Pet']);
  assert.equal(plain.active, 'Bruce');
  assert.equal(plain.ownHidden, true);
  console.log('default page unchanged (Bruce first, own cards hidden): OK');
} finally {
  try { browser(['close']); } catch { /* best-effort cleanup */ }
  staticServer.kill('SIGTERM');
  rmSync(site, { recursive: true, force: true });
}
