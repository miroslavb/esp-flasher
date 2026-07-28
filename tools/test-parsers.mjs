// Run the real firmware images through the browser parsers.
//   node tools/test-parsers.mjs <file.bin> [...]
// Exits non-zero if a parse looks wrong, so it can gate a deploy.
import { readFileSync } from 'node:fs';
import {
  inspectImage,
  findFilesystemPartitions,
  fmtBytes,
  fmtHex,
} from '../web/js/partitions.js';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node tools/test-parsers.mjs <firmware.bin> [...]');
  process.exit(2);
}

let failures = 0;
for (const path of files) {
  const bytes = new Uint8Array(readFileSync(path));
  const info = inspectImage(bytes, 0);
  console.log(`\n== ${path} (${fmtBytes(bytes.length)})`);
  if (!info.header) {
    console.log('   !! no image header found at 0x0 or 0x1000');
    failures++;
    continue;
  }
  console.log(
    `   header @ ${fmtHex(info.header.offset)}  chip=${info.header.chipName ?? `id 0x${info.header.chipId.toString(16)}`}` +
      `  flash=${info.header.flashSize}  segments=${info.header.segments}  merged=${info.merged}`
  );
  for (const p of info.partitions) {
    console.log(
      `     ${p.label.padEnd(10)} ${p.typeName}/${p.subtypeName.padEnd(9)} @ ${fmtHex(p.offset)}  ${fmtBytes(p.size)}`
    );
  }
  const fs = findFilesystemPartitions(info.partitions);
  if (info.merged && fs.length === 0) {
    // Legitimate for Launcher images: they declare only nvs/otadata/phy_init/test
    // and manage the remaining flash themselves. Informational, not a failure.
    console.log('   -> no filesystem partition declared (Launcher-style layout)');
  } else if (fs.length) {
    console.log(`   -> LittleFS/SPIFFS: ${fs.map((p) => `${p.label} ${fmtBytes(p.size)} @ ${fmtHex(p.offset)}`).join(', ')}`);
  }
}
console.log(failures ? `\nFAILED (${failures})` : '\nOK');
process.exit(failures ? 1 : 0);
