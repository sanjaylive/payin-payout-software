import { describe, expect, it } from 'vitest';
import { ImageRejected, inspectImage } from './image-inspect';

const png = (w: number, h: number) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const jpeg = (w: number, h: number) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3]), Buffer.alloc(16)]);

describe('inspectImage', () => {
  it('identifies formats by their bytes and reads dimensions', () => {
    expect(inspectImage(png(512, 128))).toEqual({ type: 'image/png', width: 512, height: 128 });
    expect(inspectImage(jpeg(300, 200))).toEqual({ type: 'image/jpeg', width: 300, height: 200 });
    const ico = Buffer.alloc(22);
    ico.writeUInt16LE(1, 2);
    ico.writeUInt16LE(1, 4);
    ico[6] = 0;
    ico[7] = 0;
    expect(inspectImage(ico)).toEqual({ type: 'image/x-icon', width: 256, height: 256 });
    expect(inspectImage(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><rect width="64" height="32" fill="#2563eb"/></svg>'))).toEqual({ type: 'image/svg+xml', width: 64, height: 32 });
  });

  it('rejects non-images and active SVG content', () => {
    expect(() => inspectImage(Buffer.from('%PDF-1.7 not an image at all'))).toThrow(ImageRejected);
    const svg = (inner: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${inner}</svg>`);
    expect(() => inspectImage(svg('<script>alert(1)</script>'))).toThrow(/scripts/);
    expect(() => inspectImage(svg('<rect onload="alert(1)"/>'))).toThrow(/event handlers/);
    expect(() => inspectImage(svg('<image href="https://evil.example/x.png"/>'))).toThrow(/external/);
    expect(() => inspectImage(svg('<a href="javascript:alert(1)">x</a>'))).toThrow();
    expect(() => inspectImage(svg('<foreignObject><div/></foreignObject>'))).toThrow(/embedded/);
    expect(() => inspectImage(Buffer.from('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>'))).toThrow();
    expect(() => inspectImage(svg('<style>@import url(https://x)</style>'))).toThrow();
    expect(inspectImage(svg('<linearGradient id="g"/><rect fill="url(#g)"/>')).type).toBe('image/svg+xml');
  });
});
