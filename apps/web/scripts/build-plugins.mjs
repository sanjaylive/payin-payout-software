// Packs the PHP SDK and the WooCommerce / OpenCart plugins (../../integrations) into zips served
// from /downloads. Runs before `next build`; the zips are build output, never committed.
// A minimal ZIP writer (stored entries, CRC-32) so the build needs no zip tool or dependency.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../../integrations');
const out = join(here, '../public/downloads');
mkdirSync(out, { recursive: true });

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === 'tests' || name.startsWith('.')) return [];
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

function zip(srcDir, prefix, target) {
  const locals = [];
  const central = [];
  let offset = 0;
  // Fixed timestamp (2026-01-01) so builds are reproducible.
  const time = 0;
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const file of files(srcDir).sort()) {
    const name = Buffer.from(prefix + relative(srcDir, file).split('\\').join('/'));
    const data = readFileSync(file);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(join(out, target), Buffer.concat([...locals, cd, end]));
  console.log(`  downloads/${target}`);
}

zip(join(root, 'woocommerce/pay2all-payments'), 'pay2all-payments/', 'pay2all-woocommerce-1.0.0.zip');
zip(join(root, 'opencart/pay2all'), '', 'pay2all-opencart-1.0.0.ocmod.zip');
zip(join(root, 'php'), 'pay2all-php/', 'pay2all-php-1.0.0.zip');
