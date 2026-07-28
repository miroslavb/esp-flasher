// esp.js — every device-touching operation, on top of the vendored esptool-js.
//
// Design notes carried over from the kbd / c6-enviro installers on this host:
//   * one shared SerialPort object, re-wrapped in a fresh Transport per action,
//     so the user picks the port once and the serial monitor can take it over;
//   * writeFlash() data must be a *binary string* (esptool-js 0.5.x contract);
//   * flashSize/Mode/Freq: 'keep' — never re-stamp the vendor's image header;
//   * hardReset() is wrapped: a failing reset must not mask a successful write.

import { ESPLoader, Transport } from '../lib/esptool-bundle.js';
import {
  PARTITION_TABLE_OFFSET,
  PARTITION_TABLE_SIZE,
  parsePartitionTable,
  findFilesystemPartitions,
} from './partitions.js';

let sharedPort = null;
let active = null; // { transport, loader }

export function hasWebSerial() {
  return 'serial' in navigator && window.isSecureContext;
}

export function portChosen() {
  return sharedPort !== null;
}

/** The SerialPort the user picked, so the serial monitor can reuse it. */
export function getPort() {
  return sharedPort;
}

export async function choosePort() {
  sharedPort = await navigator.serial.requestPort();
  return sharedPort;
}

export function forgetPort() {
  sharedPort = null;
}

/** Close whatever we hold so another mode (or another tab) can open the port. */
export async function release() {
  if (active) {
    try { await active.transport.disconnect(); } catch { /* already gone */ }
    active = null;
  }
  if (sharedPort) {
    try { if (sharedPort.readable || sharedPort.writable) await sharedPort.close(); } catch { /* ignore */ }
  }
}

/**
 * Connect and run the flasher stub.
 *
 * `nativeUsb` keeps rom and main baud equal: on ESP32-C3/C6/S3 with built-in
 * USB-Serial/JTAG the baud is virtual, and the mid-session change esptool-js
 * would otherwise perform is a known cause of corrupted writes. Boards with a
 * real USB-UART bridge (all CYDs: CP2102 / CH340) benefit from the speed-up.
 *
 * On failure we retry once at a plain 115200/115200, which rescues flaky
 * CH340 clones that cannot survive the baud switch.
 */
export async function connect({ baud = 460800, nativeUsb = false, terminal } = {}) {
  if (!sharedPort) await choosePort();
  await release();
  const attempts = nativeUsb
    ? [{ baudrate: baud, romBaudrate: baud }]
    : [{ baudrate: baud, romBaudrate: 115200 }, { baudrate: 115200, romBaudrate: 115200 }];

  let lastErr;
  for (const [i, opts] of attempts.entries()) {
    try {
      const transport = new Transport(sharedPort, false);
      const loader = new ESPLoader({ transport, ...opts, terminal });
      const chip = await loader.main();
      active = { transport, loader };
      return { loader, transport, chip, baud: opts.baudrate };
    } catch (err) {
      lastErr = err;
      try { await release(); } catch { /* ignore */ }
      if (i < attempts.length - 1) {
        terminal?.writeLine(`Не вышло на ${opts.baudrate} бод (${err.message}) — повторяю на 115200…`);
      }
    }
  }
  throw lastErr;
}

/** ArrayBuffer → binary string, chunked so fromCharCode.apply never overflows. */
export function toBinaryString(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return s;
}

/**
 * Read and parse the device's own partition table.
 * Requires the stub (readFlash is a stub command), which connect() already ran.
 */
export async function readDevicePartitions(loader) {
  const raw = await loader.readFlash(PARTITION_TABLE_OFFSET, PARTITION_TABLE_SIZE);
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const { partitions } = parsePartitionTable(bytes);
  return { partitions, filesystems: findFilesystemPartitions(partitions) };
}

/**
 * Write the firmware parts.
 * @param {object} loader
 * @param {Array<{data: ArrayBuffer, address: number}>} parts
 * @param {{eraseAll?: boolean, compress?: boolean, onProgress?: (pct:number)=>void}} opts
 */
export async function writeParts(loader, parts, { eraseAll = false, compress = true, onProgress } = {}) {
  const fileArray = parts.map((p) => ({ data: toBinaryString(p.data), address: p.address }));
  const totals = fileArray.map((f) => f.data.length);
  const grand = totals.reduce((a, b) => a + b, 0) || 1;
  const done = totals.map(() => 0);
  await loader.writeFlash({
    fileArray,
    flashSize: 'keep',
    flashMode: 'keep',
    flashFreq: 'keep',
    eraseAll,
    compress,
    reportProgress: (idx, written) => {
      done[idx] = written;
      onProgress?.((done.reduce((a, b) => a + b, 0) / grand) * 100);
    },
  });
}

/**
 * THE LittleFS-full fix (BruceDevices/firmware#2298).
 *
 * Overwrite the filesystem partition with 0xFF — the erased-flash pattern — so
 * the LittleFS superblock is gone. Bruce's setupLittleFS() then fails on the
 * next boot and main.cpp calls LittleFS.format(), producing a clean, empty
 * filesystem. The app image and NVS (Wi-Fi credentials, settings) are never
 * touched, so this is a repair, not a reinstall.
 *
 * Cheap on the wire: 0xFF blocks compress to almost nothing, and writeFlash
 * erases each sector before writing it anyway.
 */
export async function wipeFilesystemPartition(loader, partition, { onProgress } = {}) {
  const blank = new Uint8Array(partition.size).fill(0xff);
  await writeParts(loader, [{ data: blank, address: partition.offset }], {
    eraseAll: false,
    compress: true,
    onProgress,
  });
}

export async function eraseEverything(loader) {
  await loader.eraseFlash();
}

export async function reset(loader) {
  try {
    await loader.hardReset();
    return true;
  } catch {
    return false; // native-USB boards often refuse; the caller tells the user to replug
  }
}

/** Raw serial monitor on the same port — the recovery route from issue #2298. */
export class SerialConsole {
  constructor(port, { onData, onClose } = {}) {
    this.port = port;
    this.onData = onData;
    this.onClose = onClose;
    this.reader = null;
    this.running = false;
  }

  async open(baudRate = 115200) {
    await this.port.open({ baudRate });
    this.running = true;
    this._pump();
  }

  async _pump() {
    const decoder = new TextDecoder();
    while (this.running && this.port.readable) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) this.onData?.(decoder.decode(value, { stream: true }));
        }
      } catch (err) {
        if (this.running) this.onData?.(`\n[ошибка чтения: ${err.message}]\n`);
        break;
      } finally {
        try { this.reader.releaseLock(); } catch { /* ignore */ }
        this.reader = null;
      }
    }
    this.onClose?.();
  }

  async send(line) {
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(line + '\r\n'));
    } finally {
      writer.releaseLock();
    }
  }

  async close() {
    this.running = false;
    try { await this.reader?.cancel(); } catch { /* ignore */ }
    try { await this.port.close(); } catch { /* ignore */ }
  }
}
