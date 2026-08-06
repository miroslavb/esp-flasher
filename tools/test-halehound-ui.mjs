// Browser-level contract for the official HaleHound hand-off.
// It runs the actual browser application from a local static server.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = resolve(root, 'web');
const browser = (args) => execFileSync('agent-browser', args, { encoding: 'utf8' }).trim();
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function unusedLocalPort() {
  const probe = createServer();
  await new Promise((resolveListen) => probe.listen(0, '127.0.0.1', resolveListen));
  const { port } = probe.address();
  await new Promise((resolveClose) => probe.close(resolveClose));
  return port;
}

const port = await unusedLocalPort();
const staticServer = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', webRoot], {
  stdio: 'ignore',
});

try {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) break;
    } catch { /* server is still starting */ }
    if (attempt === 29) throw new Error('local static server did not become ready');
    await delay(100);
  }

  try { browser(['close']); } catch { /* no stale session */ }
  browser(['open', `http://127.0.0.1:${port}/`]);
  browser(['wait', 500]);

  const raw = browser(['eval', `JSON.stringify((() => {
    const link = Array.from(document.querySelectorAll('#sources a.source'))
      .find((element) => element.textContent.includes('HaleHound'));
    return link && {
      href: link.href,
      target: link.target,
      rel: link.rel,
      ariaLabel: link.getAttribute('aria-label'),
    };
  })())`]);
  const decoded = JSON.parse(raw);
  const link = typeof decoded === 'string' ? JSON.parse(decoded) : decoded;

  assert.deepEqual(link, {
    href: 'https://flash.halehound.com/',
    target: '_blank',
    rel: 'noopener noreferrer',
    ariaLabel: 'HaleHound официальный прошивальщик',
  });
  console.log('HaleHound official hand-off: OK');
} finally {
  try { browser(['close']); } catch { /* best-effort cleanup */ }
  staticServer.kill('SIGTERM');
}
