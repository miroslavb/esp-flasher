// app.js — UI wiring: catalog browsing, flashing, LittleFS repair, serial monitor.

import {
  hasWebSerial, connect, release, choosePort, portChosen, getPort,
  readDevicePartitions, writeParts, wipeFilesystemPartition,
  eraseEverything, reset, SerialConsole,
} from './esp.js';
import { inspectImage, findFilesystemPartitions, fmtBytes, fmtHex } from './partitions.js';

const $ = (id) => document.getElementById(id);
const API = './api';

const SOURCES = [
  { id: 'bruce', title: 'Bruce', desc: 'bruce.computer' },
  { id: 'launcher', title: 'Launcher', desc: 'bmorcelli' },
  { id: 'espterminator', title: 'ESP Terminator', desc: 'сводный каталог' },
  { id: 'wizard', title: 'Wireless Wizard', desc: 'bkenned1' },
  // HaleHound protects board manifests and firmware downloads with a per-user
  // human-verification token. Preserve that control with an official hand-off.
  { id: 'halehound', title: 'HaleHound', desc: 'официальный прошивальщик', href: 'https://flash.halehound.com/' },
];

const state = {
  source: 'bruce',
  catalog: null,
  devices: [],      // flattened, filtered
  device: null,
  version: null,
  busy: false,
  console: null,
};

// ------------------------------------------------------------------ utilities

function log(line = '') {
  const el = $('log');
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}
function setStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status ' + kind;
}
function setProgress(pct) {
  $('progressWrap').classList.remove('hidden');
  $('progressBar').style.width = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
}
function hideProgress() {
  $('progressWrap').classList.add('hidden');
  $('progressBar').style.width = '0%';
}
const espTerminal = {
  clean() {},
  writeLine(d) { log(d); },
  write(d) { $('log').textContent += d; },
};

function setBusy(on) {
  state.busy = on;
  for (const id of ['btnFlash', 'btnFixFs', 'btnErase', 'btnInspect', 'btnConsole']) {
    $(id).disabled = on;
  }
}

/** Everything device-touching funnels through here: one lock, one error path. */
async function withDevice(label, fn) {
  if (state.busy) return;
  if (!hasWebSerial()) { alert('Нужен Chrome/Edge по https — Web Serial недоступен.'); return; }
  if (state.console) await closeConsole();
  setBusy(true);
  hideProgress();
  try {
    setStatus(portChosen() ? `${label}: подключаюсь…` : 'Выберите COM-порт платы…', 'work');
    const conn = await connect({
      baud: parseInt($('baud').value, 10),
      nativeUsb: $('nativeUsb').checked,
      terminal: espTerminal,
    });
    log(`Чип: ${conn.chip} (${conn.baud} бод)`);
    await fn(conn);
  } catch (err) {
    console.error(err);
    setStatus('❌ ' + (err.message || err), 'err');
    log('ОШИБКА: ' + (err.message || err));
    log('Если плата не отвечает: отключите USB, зажмите BOOT, воткните кабель, отпустите через 2 с,');
    log('затем повторите на 115200. На CYD кнопки BOOT нет — попробуйте другой кабель/порт и 115200.');
  } finally {
    await release();
    setBusy(false);
  }
}

// ------------------------------------------------------------------ catalog

async function loadCatalog(src) {
  state.source = src;
  state.catalog = null;
  $('device').innerHTML = '<option>загружаю…</option>';
  $('version').innerHTML = '';
  $('fileList').innerHTML = '';
  renderSources();
  try {
    const res = await fetch(`${API}/catalog?src=${encodeURIComponent(src)}`);
    if (!res.ok) throw new Error(`каталог ${res.status}`);
    state.catalog = await res.json();
    if (state.catalog.stale) {
      log(`(каталог ${src} отдан из кеша: ${state.catalog.error || 'источник недоступен'})`);
    }
    $('sourceNote').textContent = state.catalog.note || '';
    renderDevices();
  } catch (err) {
    $('device').innerHTML = '<option>ошибка загрузки</option>';
    setStatus(`Не удалось загрузить каталог: ${err.message}`, 'err');
  }
}

function renderSources() {
  $('sources').innerHTML = '';
  for (const s of SOURCES) {
    const b = document.createElement(s.href ? 'a' : 'button');
    b.className = 'source' + (s.id === state.source ? ' on' : '');
    b.setAttribute('aria-label', `${s.title} ${s.desc}`);
    b.innerHTML = `<strong>${s.title}</strong><span>${s.desc}</span>`;
    if (s.href) {
      b.href = s.href;
      b.target = '_blank';
      b.rel = 'noopener noreferrer';
    } else {
      b.type = 'button';
      b.onclick = () => loadCatalog(s.id);
    }
    $('sources').appendChild(b);
  }
}

function renderDevices() {
  const q = $('filter').value.trim().toLowerCase();
  const sel = $('device');
  sel.innerHTML = '';
  state.devices = [];
  let shown = 0;
  for (const group of state.catalog.groups) {
    const matches = group.devices.filter(
      (d) => !q || d.name.toLowerCase().includes(q) || d.id.toLowerCase().includes(q) || group.name.toLowerCase().includes(q)
    );
    if (!matches.length) continue;
    const og = document.createElement('optgroup');
    og.label = group.name;
    for (const d of matches) {
      const idx = state.devices.push(d) - 1;
      const o = document.createElement('option');
      o.value = String(idx);
      o.textContent = d.family ? `${d.name} · ${d.family}` : d.name;
      og.appendChild(o);
      shown++;
    }
    sel.appendChild(og);
  }
  $('deviceCount').textContent = `(${shown} из ${state.catalog.device_count})`;
  if (!shown) {
    sel.innerHTML = '<option>ничего не найдено</option>';
    $('version').innerHTML = '';
    $('fileList').innerHTML = '';
    return;
  }
  // Convenience: with a CYD-ish filter, preselect the first hit.
  sel.selectedIndex = 0;
  onDeviceChange();
}

function onDeviceChange() {
  const d = state.devices[parseInt($('device').value, 10)];
  state.device = d;
  const vs = $('version');
  vs.innerHTML = '';
  if (!d) return;
  d.versions.forEach((v, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `${v.version}${v.published ? ` · ${v.published}` : ''}${v.prerelease ? ' · beta' : ''}`;
    vs.appendChild(o);
  });
  vs.selectedIndex = 0;
  onVersionChange();
}

function onVersionChange() {
  const v = state.device?.versions[parseInt($('version').value, 10)];
  state.version = v;
  const box = $('fileList');
  box.innerHTML = '';
  if (!v) return;
  for (const f of v.files) {
    const row = document.createElement('div');
    row.className = 'file';
    row.innerHTML =
      `<code>${f.name}</code><span>→ ${fmtHex(f.offset)}</span><span>${f.size ? fmtBytes(f.size) : ''}</span>`;
    box.appendChild(row);
  }
  if (state.device.note) {
    const n = document.createElement('p');
    n.className = 'hint';
    n.textContent = state.device.note;
    box.appendChild(n);
  }
  // Grounded advice, not a guess: this is the documented Bruce CYD layout split.
  if (state.source === 'bruce' && /^CYD-/i.test(state.device.id)) {
    const n = document.createElement('p');
    n.className = 'hint accent';
    n.innerHTML =
      'У обычной CYD-сборки (<code>custom_4Mb_full.csv</code>) под LittleFS отведено всего <b>192 КБ</b>. ' +
      'Сборка <code>LAUNCHER_' + state.device.id + '</code> (<code>custom_4Mb.csv</code>) даёт <b>1,5 МБ</b>, ' +
      'но это <b>light</b>-вариант: <code>LITE_VERSION=1</code>, урезан набор ИК-протоколов и часть функций — ' +
      'иначе прошивка не влезет в меньший раздел приложения.';
    box.appendChild(n);
  }
}

// ------------------------------------------------------------------ downloads

async function downloadParts(onNote) {
  const parts = [];
  for (const f of state.version.files) {
    onNote?.(`Скачиваю ${f.name}…`);
    const res = await fetch(`${API}/bin?u=${encodeURIComponent(f.url)}`);
    if (!res.ok) {
      let detail = `${res.status}`;
      try { detail = (await res.json()).error || detail; } catch { /* body not JSON */ }
      throw new Error(`не скачалось ${f.name}: ${detail}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const cache = res.headers.get('X-Fw-Cache') === 'hit' ? ' (из кеша)' : '';
    log(`  ${f.name} → ${fmtHex(f.offset)} · ${fmtBytes(buf.length)}${cache}`);
    parts.push({ data: buf, address: f.offset, name: f.name });
  }
  return parts;
}

// ------------------------------------------------------------------ partitions UI

function renderPartitions(partitions, { source }) {
  $('partCard').classList.remove('hidden');
  const body = $('partBody');
  body.innerHTML = '';
  for (const p of partitions) {
    const tr = document.createElement('tr');
    if (findFilesystemPartitions([p]).length) tr.className = 'fs';
    tr.innerHTML = `<td><code>${p.label || '—'}</code></td><td>${p.typeName}/${p.subtypeName}</td>` +
      `<td>${fmtHex(p.offset)}</td><td>${fmtBytes(p.size)}</td>`;
    body.appendChild(tr);
  }
  const advice = $('partAdvice');
  advice.innerHTML = '';
  const fs = findFilesystemPartitions(partitions);
  const p = document.createElement('p');
  p.className = 'hint';
  if (!fs.length) {
    p.textContent = `Источник: ${source}. Раздела файловой системы нет — чинить «LittleFS is full» нечего.`;
  } else {
    const small = fs.filter((x) => x.size <= 256 * 1024);
    p.innerHTML = `Источник: ${source}. ФС: ` +
      fs.map((x) => `<code>${x.label}</code> ${fmtBytes(x.size)} @ ${fmtHex(x.offset)}`).join(', ') +
      (small.length
        ? ' — <b>меньше 256 КБ</b>, забивается быстро: рассмотрите сборку с бо́льшим разделом.'
        : '.');
  }
  advice.appendChild(p);
}

// ------------------------------------------------------------------ actions

function inspectAction() {
  return withDevice('Чтение разделов', async ({ loader }) => {
    setStatus('Читаю таблицу разделов…', 'work');
    const { partitions } = await readDevicePartitions(loader);
    if (!partitions.length) {
      setStatus('Таблица разделов не читается — флеш пустая или повреждена. Прошейте плату целиком.', 'warn');
      log('Таблица разделов по адресу 0x8000 не распознана.');
      return;
    }
    renderPartitions(partitions, { source: 'прочитано с устройства' });
    log(`Разделов: ${partitions.length}`);
    setStatus('✅ Разделы прочитаны.', 'ok');
    await reset(loader);
  });
}

function flashAction() {
  if (!state.version) { alert('Сначала выберите плату и версию.'); return; }
  const eraseAll = $('eraseAll').checked;
  if (eraseAll && !confirm('Стереть ВСЮ флеш перед прошивкой? Пропадут Wi-Fi-настройки и все файлы.')) return;

  return withDevice('Прошивка', async ({ loader, chip }) => {
    const parts = await downloadParts((m) => setStatus(m, 'work'));

    // Chip sanity check from the image header itself — no guessing by name.
    const info = inspectImage(parts[0].data, parts[0].address);
    if (info.header?.chipName && !String(chip).toUpperCase().startsWith(info.header.chipName.toUpperCase())) {
      if (!confirm(`Прошивка собрана для ${info.header.chipName}, а подключён ${chip}. Всё равно прошить?`)) {
        throw new Error('отменено: чип не совпадает');
      }
    }
    if (info.merged && info.partitions.length) {
      renderPartitions(info.partitions, { source: `образ ${parts[0].name}` });
    }

    setStatus(eraseAll ? 'Стираю и пишу… не отключайте плату.' : 'Пишу прошивку… не отключайте плату.', 'work');
    await writeParts(loader, parts, { eraseAll, compress: true, onProgress: setProgress });
    setProgress(100);
    const ok = await reset(loader);
    setStatus(ok ? '✅ Прошито. Плата перезагружена.' : '✅ Прошито. Передёрните USB, чтобы плата стартовала.', 'ok');
  });
}

function fixFsAction() {
  return withDevice('Починка LittleFS', async ({ loader }) => {
    setStatus('Читаю таблицу разделов…', 'work');
    const { partitions, filesystems } = await readDevicePartitions(loader);
    if (!partitions.length) throw new Error('таблица разделов не читается — прошейте плату целиком');
    renderPartitions(partitions, { source: 'прочитано с устройства' });

    if (!filesystems.length) throw new Error('раздел файловой системы не найден — чинить нечего');
    let target = filesystems[0];
    if (filesystems.length > 1) {
      const names = filesystems.map((p, i) => `${i + 1}) ${p.label} ${fmtBytes(p.size)}`).join('\n');
      const pick = prompt(`Найдено несколько разделов ФС:\n${names}\nНомер:`, '1');
      const idx = parseInt(pick, 10) - 1;
      if (!(idx >= 0 && idx < filesystems.length)) throw new Error('отменено');
      target = filesystems[idx];
    }

    const okMsg =
      `Очистить раздел «${target.label}» (${fmtBytes(target.size)} @ ${fmtHex(target.offset)})?\n\n` +
      `Файлы на плате будут удалены.\nПрошивка и настройки Wi-Fi (раздел nvs) сохранятся.`;
    if (!confirm(okMsg)) throw new Error('отменено пользователем');

    setStatus(`Очищаю раздел ${target.label}…`, 'work');
    log(`Пишу 0xFF в ${fmtHex(target.offset)} … ${fmtHex(target.offset + target.size)} (${fmtBytes(target.size)})`);
    await wipeFilesystemPartition(loader, target, { onProgress: setProgress });
    setProgress(100);
    const ok = await reset(loader);
    log('Готово. При старте прошивка не смонтирует ФС и выполнит LittleFS.format() — файловая система будет чистой.');
    setStatus(
      ok ? '✅ Раздел очищен. Плата перезагружается — ФС переформатируется сама.'
         : '✅ Раздел очищен. Передёрните USB — при старте ФС переформатируется сама.',
      'ok'
    );
  });
}

function eraseAction() {
  if (!confirm('Стереть ВСЮ флеш? Плата останется без прошивки, потребуется полная перепрошивка.')) return;
  return withDevice('Полное стирание', async ({ loader }) => {
    setStatus('Стираю всю флеш, это 10–40 секунд…', 'work');
    await eraseEverything(loader);
    setStatus('✅ Флеш стёрта. Теперь нажмите «Прошить».', 'ok');
  });
}

// ------------------------------------------------------------------ console

async function openConsole() {
  if (state.busy) return;
  if (!hasWebSerial()) { alert('Нужен Chrome/Edge по https.'); return; }
  try {
    if (!portChosen()) await choosePort();
    await release(); // esptool must let go of the port before we open it raw
    const port = getPort();
    const out = $('consoleOut');
    out.textContent = '';
    state.console = new SerialConsole(port, {
      onData: (text) => { out.textContent += text; out.scrollTop = out.scrollHeight; },
      onClose: () => { state.console = null; },
    });
    await state.console.open(115200);
    $('consoleCard').classList.remove('hidden');
    $('consoleLine').focus();
    setStatus('🖥 Монитор открыт на 115200. Наберите help.', 'ok');
  } catch (err) {
    setStatus('❌ монитор: ' + (err.message || err), 'err');
  }
}

async function closeConsole() {
  if (state.console) {
    await state.console.close();
    state.console = null;
  }
  $('consoleCard').classList.add('hidden');
}

// ------------------------------------------------------------------ boot

function init() {
  if (!hasWebSerial()) {
    $('envWarn').classList.remove('hidden');
    for (const id of ['btnFlash', 'btnFixFs', 'btnErase', 'btnInspect', 'btnConsole']) $(id).disabled = true;
  }
  renderSources();
  loadCatalog('bruce');

  $('filter').addEventListener('input', () => state.catalog && renderDevices());
  $('device').addEventListener('change', onDeviceChange);
  $('version').addEventListener('change', onVersionChange);
  $('btnInspect').addEventListener('click', inspectAction);
  $('btnFlash').addEventListener('click', flashAction);
  $('btnFixFs').addEventListener('click', fixFsAction);
  $('btnErase').addEventListener('click', eraseAction);
  $('btnConsole').addEventListener('click', openConsole);
  $('btnConsoleClose').addEventListener('click', closeConsole);
  $('btnHelp').addEventListener('click', () => state.console?.send('help'));
  $('consoleForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const line = $('consoleLine').value;
    if (!state.console) return;
    state.console.send(line);
    $('consoleOut').textContent += `> ${line}\n`;
    $('consoleLine').value = '';
  });
}

init();
