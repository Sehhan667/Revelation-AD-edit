/*
 * dump_png.js — 把 PNG 的某个矩形区域写成新的 PNG（无损，放大整数倍）
 * 用法：node rdc_analysis/dump_png.js <src.png> <x> <y> <w> <h> <scale> <out.png>
 * 只依赖 zlib，输出 RGB8 无滤波 PNG。
 */
const fs = require('fs');
const zlib = require('zlib');
const { readPNG } = require('./png_read');

const [src, X, Y, Wd, Hd, SC, out] = process.argv.slice(2);
const x0 = +X, y0 = +Y, w = +Wd, h = +Hd, sc = +SC;
const im = readPNG(src);
const ow = w * sc, oh = h * sc;
const raw = Buffer.alloc(oh * (1 + ow * 3));
for (let y = 0; y < oh; y++) {
    const rowStart = y * (1 + ow * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < ow; x++) {
        const sx = Math.min(im.w - 1, x0 + Math.floor(x / sc));
        const sy = Math.min(im.h - 1, y0 + Math.floor(y / sc));
        const i = (sy * im.w + sx) * im.ch;
        const o = rowStart + 1 + x * 3;
        raw[o] = im.px[i]; raw[o + 1] = im.px[i + 1]; raw[o + 2] = im.px[i + 2];
    }
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
}
let TBL = null;
function crc32(buf) {
    if (!TBL) {
        TBL = new Int32Array(256);
        for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; TBL[n] = c; }
    }
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = TBL[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return c ^ -1;
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(ow, 0); ihdr.writeUInt32BE(oh, 4);
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
fs.writeFileSync(out, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
]));
console.log(`已写出 ${out}  ${ow}x${oh}（区域 ${x0},${y0} ${w}x${h} 放大 ${sc}x）`);
