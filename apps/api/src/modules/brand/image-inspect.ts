/**
 * Brand images are identified by their bytes, never by the uploaded name or MIME type. Raster
 * dimensions come from the file header; SVGs must be plain drawings (no scripts, event handlers,
 * external references or DTDs) and are additionally served with a sandboxing CSP.
 */

export type BrandImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml' | 'image/x-icon';
export interface InspectedImage {
  type: BrandImageType;
  width: number | null;
  height: number | null;
}

export class ImageRejected extends Error {}

function jpegSize(b: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Buffer): { width: number; height: number } | null {
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8X' && b.length >= 30) return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === 'VP8L' && b.length >= 25) {
    const bits = b.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunk === 'VP8 ' && b.length >= 30) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  return null;
}

const UNSAFE_SVG = [
  [/<!DOCTYPE|<!ENTITY/i, 'DTDs and entities are not allowed'],
  [/<script\b/i, 'scripts are not allowed'],
  [/<(foreignObject|iframe|embed|object|audio|video|use)\b/i, 'embedded content is not allowed'],
  [/\son[a-z]+\s*=/i, 'event handlers are not allowed'],
  [/javascript:|vbscript:/i, 'script URLs are not allowed'],
  [/(?:xlink:)?href\s*=\s*["'](?!#|data:image\/(?:png|jpeg|webp);)/i, 'external references are not allowed'],
  [/url\(\s*["']?(?!#)/i, 'external references are not allowed'],
  [/@import/i, 'external styles are not allowed'],
] as const;

function svgSize(svg: string): { width: number | null; height: number | null } {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
  if (vb) return { width: Math.round(Number(vb[1])), height: Math.round(Number(vb[2])) };
  const w = /\swidth\s*=\s*["']([\d.]+)(px)?["']/i.exec(tag);
  const h = /\sheight\s*=\s*["']([\d.]+)(px)?["']/i.exec(tag);
  return { width: w ? Math.round(Number(w[1])) : null, height: h ? Math.round(Number(h[1])) : null };
}

export function inspectImage(b: Buffer): InspectedImage {
  if (b.length < 16) throw new ImageRejected('The file is too small to be an image');
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (b.toString('ascii', 12, 16) !== 'IHDR') throw new ImageRejected('This PNG is damaged');
    return { type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const s = jpegSize(b);
    return { type: 'image/jpeg', width: s?.width ?? null, height: s?.height ?? null };
  }
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const s = webpSize(b);
    return { type: 'image/webp', width: s?.width ?? null, height: s?.height ?? null };
  }
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && b.readUInt16LE(4) >= 1) {
    return { type: 'image/x-icon', width: b[6] || 256, height: b[7] || 256 };
  }
  const head = b.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg\b/i.test(head)) {
    const svg = b.toString('utf8');
    if (svg.includes('\uFFFD')) throw new ImageRejected('The SVG is not valid UTF-8');
    for (const [re, why] of UNSAFE_SVG) if (re.test(svg)) throw new ImageRejected(`SVG rejected: ${why}`);
    return { type: 'image/svg+xml', ...svgSize(svg) };
  }
  throw new ImageRejected('Upload a PNG, JPEG, WebP, SVG or ICO image');
}
