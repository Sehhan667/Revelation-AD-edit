/*
 * bbox_white.js — 量出 PNG 里"接近白色"像素的包围盒 / 行段分布
 * 用法：node rdc_analysis/bbox_white.js <png> [--thr 200] [--from 0] [--to 9999]
 * 目的是别再靠肉眼估坐标：直接给出白色区域在哪里、多宽多高。
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

const argOf = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? parseFloat(a.split('=')[1]) : d; };
const file = process.argv[2];
if (!file) { console.error('用法: node bbox_white.js <png> [--thr 200] [--from 0] [--to 9999] [--rows 20]'); process.exit(1); }
const THR = argOf('thr', 200), FROM = argOf('from', 0), TO = argOf('to', 1e9), NROWS = argOf('rows', 16);

const im = readPNG(file);
let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, count = 0;
const rowInfo = [];
for (let y = Math.max(0, FROM | 0); y < Math.min(im.h, TO | 0); y++) {
    let rmin = 1e9, rmax = -1, rc = 0;
    for (let x = 0; x < im.w; x++) {
        const i = (y * im.w + x) * im.ch;
        const r = im.px[i], g = im.px[i + 1], b = im.px[i + 2];
        if (r >= THR && g >= THR && b >= THR) {
            rc++; count++;
            if (x < rmin) rmin = x;
            if (x > rmax) rmax = x;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
    }
    rowInfo.push({ y, rc, rmin, rmax });
}

console.log(`${file}  ${im.w}x${im.h} ch=${im.ch}  阈值>=${THR}`);
if (count === 0) { console.log('  没有白色像素'); process.exit(0); }
console.log(`  包围盒 x ${x0}..${x1} (${x1 - x0 + 1} px)  y ${y0}..${y1} (${y1 - y0 + 1} px)  共 ${count} px`);

// 按白像素行数分组，找出 logo 的若干块（主字形 / AD Edit）
const groups = [];
let cur = null;
for (const r of rowInfo) {
    if (r.rc > 0) {
        if (!cur) cur = { y0: r.y, y1: r.y, rows: [{ ...r }] };
        else { cur.y1 = r.y; cur.rows.push({ ...r }); }
    } else if (cur) { groups.push(cur); cur = null; }
}
if (cur) groups.push(cur);
console.log(`  连续块数：${groups.length}`);
for (const g of groups) {
    let gx0 = 1e9, gx1 = -1, tot = 0;
    for (const r of g.rows) { if (r.rmin < gx0) gx0 = r.rmin; if (r.rmax > gx1) gx1 = r.rmax; tot += r.rc; }
    console.log(`    块 y ${g.y0}..${g.y1} (${g.y1 - g.y0 + 1} 行)  x ${gx0}..${gx1} (${gx1 - gx0 + 1} px)  ${tot} px`);
}

// 采样若干行，打印该行白色段的起点/终点，用来判断"顶部横条 + 缝隙"是否还在
console.log('  行采样（每块等距取几行，列出白色连续段）：');
for (const g of groups) {
    const step = Math.max(1, Math.floor(g.rows.length / NROWS));
    for (let i = 0; i < g.rows.length; i += step) {
        const y = g.y0 + i;
        const segs = [];
        let s = -1;
        for (let x = 0; x < im.w; x++) {
            const p = (y * im.w + x) * im.ch;
            const isW = im.px[p] >= THR && im.px[p + 1] >= THR && im.px[p + 2] >= THR;
            if (isW && s < 0) s = x;
            else if (!isW && s >= 0) { segs.push(`${s}-${x - 1}`); s = -1; }
        }
        if (s >= 0) segs.push(`${s}-${im.w - 1}`);
        if (segs.length) console.log(`    y=${y}: ${segs.join(' | ')}`);
    }
}
