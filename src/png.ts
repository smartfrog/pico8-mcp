/**
 * Zero-dependency PNG encoder for PICO-8 framebuffers.
 * Input: 8192-byte framebuffer (2 pixels/byte, low nibble = left pixel)
 * plus the 16-byte screen palette (0x5f10..0x5f1f).
 */
import { deflateSync } from "node:zlib";

// Standard PICO-8 palette (0-15)
const STD = [
  0x000000, 0x1d2b53, 0x7e2553, 0x008751, 0xab5236, 0x5f574f, 0xc2c3c7, 0xfff1e8,
  0xff004d, 0xffa300, 0xffec27, 0x00e436, 0x29adff, 0x83769c, 0xff77a8, 0xffccaa,
];
// Secret/extended palette (128-143)
const SECRET = [
  0x291814, 0x111d35, 0x422136, 0x125359, 0x742f29, 0x49333b, 0xa28879, 0xf3ef7d,
  0xbe1250, 0xff6c24, 0xa8e72e, 0x00b543, 0x065ab5, 0x754665, 0xff6e59, 0xff9d81,
];

function paletteRgb(v: number): number {
  return v & 0x80 ? SECRET[v & 0x0f] : STD[v & 0x0f];
}

let crcTable: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crcBuf]);
}

/**
 * Render a 128x128 PICO-8 framebuffer to a PNG, upscaled by `scale`.
 * @param fb 8192 bytes (0x6000..0x7fff)
 * @param screenPal 16 bytes (0x5f10..0x5f1f); pass undefined for identity
 */
export function framebufferToPng(fb: Uint8Array, screenPal?: Uint8Array, scale = 2): Buffer {
  const size = 128 * scale;
  // resolve 16-entry RGB lookup
  const lut = new Array<number>(16);
  for (let i = 0; i < 16; i++) {
    const v = screenPal ? screenPal[i] : i;
    lut[i] = paletteRgb(v);
  }
  // raw scanlines: each row prefixed by filter byte 0
  const raw = Buffer.alloc(size * (1 + size * 3));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter none
    const srcY = (y / scale) | 0;
    for (let x = 0; x < size; x++) {
      const srcX = (x / scale) | 0;
      const b = fb[srcY * 64 + (srcX >> 1)];
      const idx = srcX & 1 ? b >> 4 : b & 0x0f;
      const rgb = lut[idx];
      raw[o++] = (rgb >> 16) & 0xff;
      raw[o++] = (rgb >> 8) & 0xff;
      raw[o++] = rgb & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
