/*
 * raster_shader_mark.js — 用 JS 精确复刻 StartupLogo.glsl 里 RenderStartupMark 的算法，
 * 栅格化出来和 SVG 预览/原图对比，确认 shader 端的多边形并集 + 射线法判定是对的。
 *
 * 网页预览用的是浏览器 SVG 填充，和 shader 里的"最短距离 + 射线法"是两套实现；
 * 只信 SVG 预览的话，shader 里写错了也看不出来。所以这里独立复刻一遍。
 *
 * 用法：node rdc_analysis/raster_shader_mark.js [--w 504] [--h 238] [--fill 1.0] [--out x.png]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const argOf = (k, d) => {
    for (let i = 0; i < process.argv.length; i++) {
        const a = process.argv[i];
        if (a === `--${k}` && i + 1 < process.argv.length) return process.argv[i + 1];
        if (a.startsWith(`--${k}=`)) return a.slice(k.length + 3);
    }
    return d;
};

const PACK = path.resolve(__dirname, '..');
const glsl = fs.readFileSync(path.join(PACK, 'shaders', 'lib', 'post', 'StartupLogo.glsl'), 'utf8');
const num = n => parseFloat(new RegExp(`#define\\s+${n}\\s+([-0-9.]+)`).exec(glsl)[1]);
const BOX_W = num('LOGO_BOX_W'), BOX_H = num('LOGO_BOX_H');
const POLY_COUNT = num('LOGO_POLY_COUNT');

const POLYS = [];
for (let i = 0; i < POLY_COUNT; i++) {
    const re = new RegExp(`const vec2 LOGO_POLY${i}\\[(\\d+)\\] = vec2\\[\\d+\\]\\(([\\s\\S]*?)\\n\\);`);
    const m = re.exec(glsl);
    let pts = [...m[2].matchAll(/vec2\(([^)]+)\)/g)].map(x => x[1].split(',').map(s => parseFloat(s.trim())));
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) pts = pts.slice(0, -1);
    POLYS.push(pts);
}
console.log(`读入 ${POLYS.length} 个多边形：${POLYS.map(p => p.length + ' 点').join(', ')}`);

// ---- 复刻 RenderStartupMark 的数学部分 ----
// PROGRESS < 0 表示不做扫掠（画完）。>=0 时复刻斜向扫掠。
const PROGRESS = parseFloat(argOf('progress', -1));
function markCov(px, py) {
    // 设计框内坐标 -> 归一化居中坐标
    const qx = px / BOX_W - 0.5, qy = py / BOX_H - 0.5;

    let minSq = 1e9;
    let inside = false;
    for (const P of POLYS) {
        for (let i = 0; i < P.length; i++) {
            const a = P[i], b = P[(i + 1) % P.length];
            const ex = b[0] - a[0], ey = b[1] - a[1];
            const wx = qx - a[0], wy = qy - a[1];
            const dd = ex * ex + ey * ey;
            const t = Math.max(0, Math.min(1, dd > 1e-12 ? (wx * ex + wy * ey) / dd : 0));
            const bx = wx - ex * t, by = wy - ey * t;
            minSq = Math.min(minSq, bx * bx + by * by);
            // 射线法
            if ((qy < a[1]) !== (qy < b[1])) {
                const xInt = a[0] + (qy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]);
                if (qx < xInt) inside = !inside;
            }
        }
    }
    const d = Math.sqrt(minSq);
    const signedD = inside ? -d : d;
    // 覆盖：aa 用 1 源像素的 0.5 近似（离线没有 fwidth）
    const sd = signedD * BOX_H;
    const aa = 0.5;
    let c = 1 - smoothstep(-aa, aa, sd);

    if (PROGRESS >= 0) {
        // 复刻 GLSL： v = (p.x + p.y)/LOGO_BOX_W ; 隐藏 v > sweep 的部分
        const v = (px + py) / BOX_W;
        const vMax = (BOX_W + BOX_H) / BOX_W;
        const sweep = (-0.02) + (vMax + 0.02 - (-0.02)) * PROGRESS;
        c *= 1 - smoothstep(sweep - 0.012, sweep + 0.012, v);
    }
    return c;
}
function smoothstep(e0, e1, x) {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

const W = parseInt(argOf('w', Math.round(BOX_W)), 10);
const H = parseInt(argOf('h', Math.round(BOX_H)), 10);
const FILL = parseFloat(argOf('fill', 1.0));

// 逐像素：设计坐标 = (i+0.5) * BOX_W/W
const img = new Float32Array(W * H);
let cov1 = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const px = (x + 0.5) * BOX_W / W;
    const py = (y + 0.5) * BOX_H / H;
    const c = markCov(px, py);
    img[y * W + x] = c;
    if (c > 0.5) cov1++;
}
const ratio = cov1 / (W * H);
console.log(`栅格化 ${W}x${H}，覆盖率(>0.5) ${(ratio * 100).toFixed(2)}%  (源图实测约 24.7%)`);

const out = argOf('out', null);
if (out) {
    const raw = Buffer.alloc(H * (1 + W * 3));
    for (let y = 0; y < H; y++) {
        const rs = y * (1 + W * 3);
        raw[rs] = 0;
        for (let x = 0; x < W; x++) {
            const v = Math.round(Math.max(0, Math.min(1, img[y * W + x] * FILL)) * 255);
            const o = rs + 1 + x * 3;
            raw[o] = raw[o + 1] = raw[o + 2] = v;
        }
    }
    let TBL = null;
    const crc32 = buf => {
        if (!TBL) { TBL = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; TBL[n] = c; } }
        let c = -1; for (let i = 0; i < buf.length; i++) c = TBL[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return c ^ -1;
    };
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    fs.writeFileSync(out, Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
    ]));
    console.log(`已写出 ${out}`);
}

// ASCII 抽查：确认 Z 的顶部横条与 V 的中缝都在
const COLS = parseInt(argOf('cols', 120), 10);
const cw = W / COLS, chh = cw * 2;
const ROWS = Math.round(H / chh);
console.log(`\nASCII 抽查 (${COLS}x${ROWS}):`);
for (let r = 0; r < ROWS; r++) {
    let line = '';
    for (let c = 0; c < COLS; c++) {
        let n = 0, t = 0;
        for (let y = Math.floor(r * chh); y < Math.ceil((r + 1) * chh) && y < H; y++)
            for (let x = Math.floor(c * cw); x < Math.ceil((c + 1) * cw) && x < W; x++) { t++; if (img[y * W + x] > 0.5) n++; }
        const f = t ? n / t : 0;
        line += f > 0.75 ? '#' : f > 0.35 ? '+' : f > 0.1 ? '.' : ' ';
    }
    console.log('  ' + line);
}
