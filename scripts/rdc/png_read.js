/*
 * png_read.js — 极简 PNG 解码（8bit，灰度/RGB/RGBA），返回 {w,h,ch,px}
 * 供 rdc_analysis 下几个检查脚本共用。
 */
const fs = require('fs');
const zlib = require('zlib');

function readPNG(file) {
    const buf = fs.readFileSync(file);
    let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
    const idat = [];
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') {
            w = data.readUInt32BE(0); h = data.readUInt32BE(4);
            bitDepth = data[8]; colorType = data[9];
        } else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        pos += 12 + len;
    }
    if (bitDepth !== 8) throw new Error('只支持 8bit PNG，实际 ' + bitDepth);
    const ch = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : -1;
    if (ch < 0) throw new Error('不支持的 colorType ' + colorType);
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = w * ch;
    const out = Buffer.alloc(w * h * ch);
    let p = 0;
    for (let y = 0; y < h; y++) {
        const ft = raw[p++];
        const line = raw.subarray(p, p + stride); p += stride;
        const cur = out.subarray(y * stride, (y + 1) * stride);
        const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
        for (let i = 0; i < stride; i++) {
            const a = i >= ch ? cur[i - ch] : 0;
            const b = prev ? prev[i] : 0;
            const c = (prev && i >= ch) ? prev[i - ch] : 0;
            let v = line[i];
            if (ft === 1) v += a;
            else if (ft === 2) v += b;
            else if (ft === 3) v += (a + b) >> 1;
            else if (ft === 4) {
                const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
                v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
            }
            cur[i] = v & 0xff;
        }
    }
    return { w, h, ch, px: out };
}

function isWhite(im, x, y, thr) {
    if (x < 0 || y < 0 || x >= im.w || y >= im.h) return false;
    const i = (y * im.w + x) * im.ch;
    return im.px[i] >= thr && im.px[i + 1] >= thr && im.px[i + 2] >= thr;
}

// 返回某行（或某列，axis='x'）上所有连续白色区间
function runs(im, fixed, axis, thr) {
    const segs = [];
    const n = axis === 'y' ? im.w : im.h;
    let s = -1;
    for (let t = 0; t < n; t++) {
        const x = axis === 'y' ? t : fixed, y = axis === 'y' ? fixed : t;
        const w = isWhite(im, x, y, thr);
        if (w && s < 0) s = t; else if (!w && s >= 0) { segs.push([s, t - 1]); s = -1; }
    }
    if (s >= 0) segs.push([s, n - 1]);
    return segs;
}

module.exports = { readPNG, isWhite, runs };
