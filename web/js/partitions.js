// partitions.js — pure parsers for the ESP-IDF partition table and image header.
//
// No I/O here: everything takes a Uint8Array so it can be unit-tested off-device
// (see tools/test-parsers.mjs, which runs the real firmware binaries through it).

/** ESP-IDF partition table entry is 32 bytes, magic 0x50AA (little endian). */
const ENTRY_MAGIC = 0x50aa;
/** The table is terminated by an MD5 entry whose first two bytes are 0xEBEB. */
const MD5_MAGIC = 0xebeb;

export const PARTITION_TABLE_OFFSET = 0x8000;
export const PARTITION_TABLE_SIZE = 0xc00; // 3 KB = 96 entries max

const APP_SUBTYPES = {
  0x00: 'factory',
  0x20: 'test',
};
const DATA_SUBTYPES = {
  0x00: 'ota',
  0x01: 'phy',
  0x02: 'nvs',
  0x03: 'coredump',
  0x04: 'nvs_keys',
  0x05: 'efuse',
  0x06: 'undefined',
  0x80: 'esphttpd',
  0x81: 'fat',
  0x82: 'spiffs',
  0x83: 'littlefs',
};

/** esp_chip_id_t → human name. Used only to warn about a wrong-chip image. */
const CHIP_IDS = {
  0x0000: 'ESP32',
  0x0002: 'ESP32-S2',
  0x0005: 'ESP32-C3',
  0x0009: 'ESP32-S3',
  0x000c: 'ESP32-C2',
  0x000d: 'ESP32-C6',
  0x0010: 'ESP32-H2',
  0x0012: 'ESP32-P4',
  0x0014: 'ESP32-C61',
  0x0017: 'ESP32-C5',
};

const FLASH_SIZE_NIBBLE = ['1MB', '2MB', '4MB', '8MB', '16MB', '32MB', '64MB', '128MB'];

/**
 * Parse a raw partition-table image.
 * @param {Uint8Array} buf 0xC00 bytes read from flash offset 0x8000
 * @returns {{partitions: Array, truncated: boolean}}
 */
export function parsePartitionTable(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const partitions = [];
  let truncated = true;
  for (let i = 0; i + 32 <= buf.length; i += 32) {
    const magic = view.getUint16(i, true);
    if (magic === MD5_MAGIC) { truncated = false; break; }
    if (magic !== ENTRY_MAGIC) {
      // Trailing 0xFF padding means we reached the end of a table with no MD5 entry.
      if (buf[i] === 0xff && buf[i + 1] === 0xff) { truncated = false; break; }
      continue;
    }
    const type = buf[i + 2];
    const subtype = buf[i + 3];
    const offset = view.getUint32(i + 4, true);
    const size = view.getUint32(i + 8, true);
    let label = '';
    for (let j = i + 12; j < i + 28; j++) {
      if (buf[j] === 0) break;
      label += String.fromCharCode(buf[j]);
    }
    partitions.push({
      label,
      type,
      subtype,
      offset,
      size,
      flags: view.getUint32(i + 28, true),
      typeName: type === 0 ? 'app' : type === 1 ? 'data' : `0x${type.toString(16)}`,
      subtypeName:
        (type === 0 ? APP_SUBTYPES[subtype] : type === 1 ? DATA_SUBTYPES[subtype] : null) ||
        `0x${subtype.toString(16).padStart(2, '0')}`,
    });
  }
  return { partitions, truncated: truncated && partitions.length === 0 };
}

/**
 * Pick the partitions that hold the on-device filesystem Bruce/Launcher use.
 *
 * Matched by *subtype* first (0x82 spiffs — what Bruce's custom_*.csv declares —
 * and 0x83 littlefs), then by label as a fallback for custom tables.
 * @param {Array} partitions
 */
export function findFilesystemPartitions(partitions) {
  return partitions.filter((p) => {
    if (p.type !== 1) return false;
    if (p.subtype === 0x82 || p.subtype === 0x83 || p.subtype === 0x81) return true;
    return /^(spiffs|littlefs|storage|ffat|fatfs|fs)$/i.test(p.label);
  });
}

/**
 * Parse an esp_image_header_t (24 bytes) at `at`.
 * @returns {null|{chipId:number, chipName:string, flashSize:string, segments:number, offset:number}}
 */
export function parseImageHeader(buf, at) {
  if (!buf || at + 24 > buf.length) return null;
  if (buf[at] !== 0xe9) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const chipId = view.getUint16(at + 12, true);
  return {
    offset: at,
    segments: buf[at + 1],
    flashSize: FLASH_SIZE_NIBBLE[(buf[at + 3] >> 4) & 0x0f] || 'unknown',
    chipId,
    chipName: CHIP_IDS[chipId] || null,
  };
}

/**
 * Inspect a downloaded firmware image: is it a merged image (bootloader + table
 * + app), which chip is it for, and what partition table does it carry?
 *
 * ESP32/ESP32-S2 keep the bootloader at 0x1000; the newer parts put it at 0x0.
 * A merged image therefore starts either with 0xE9 or with 0xFF padding.
 * @param {Uint8Array} bytes whole firmware file
 * @param {number} writeAddress the address the file will be written to
 */
export function inspectImage(bytes, writeAddress = 0) {
  const result = { merged: false, header: null, partitions: [], note: null };
  if (writeAddress !== 0) {
    // A part written at a non-zero offset is an app/fs blob, not a merged image.
    result.header = parseImageHeader(bytes, 0);
    return result;
  }
  const header = parseImageHeader(bytes, 0) || parseImageHeader(bytes, 0x1000);
  result.header = header;
  if (!header) return result;
  if (bytes.length > PARTITION_TABLE_OFFSET + 64) {
    const table = parsePartitionTable(
      bytes.subarray(PARTITION_TABLE_OFFSET, PARTITION_TABLE_OFFSET + PARTITION_TABLE_SIZE)
    );
    result.partitions = table.partitions;
    result.merged = table.partitions.length > 0;
  }
  return result;
}

export function fmtBytes(n) {
  if (n == null) return '—';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n % (1024 * 1024) ? 2 : 0)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function fmtHex(n) {
  return `0x${n.toString(16).toUpperCase().padStart(6, '0')}`;
}
