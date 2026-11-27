/*
 * mask_ascii.js — 把 logo 掩膜降采样成 ASCII，用来一眼看清几何结构
 * 用法：node rdc_analysis/mask_ascii.js [--cols 150] [--png 1789124983903.png]
 */
const path = require('path');
const { readPNG } = require('./png_read');

const argOf = (k, d) => {
    for (let i = 0; i < process.argv.length; i++) {
        const a = process.argv[i];
        if (a === `--${k}` && i + 1 < process.argv.length) return process.argv[i + 1];
        if (a.startsWith(`--${k}=`)) return a.slice(k.length + 3);
    }
    return d;
};
const PACK = path.resolve(__dirname, '..');
const im = readPNG(path.join(PACK, argOf('png', '1789124983903.png')));
const THR = 128;
const W = im.w, H = im.h;
const lit = (x, y) => x >= 0 && y >= 0 && x < W && y < H && im.px[(y * W + x) * im.ch] >= THR;

// 先找整体 bbox
let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (lit(x, y)) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
}
// 排除水印：只取左右各 1 列以上、且 y < H*0.7 的部分；这里直接限定 y <= y1 的最大连通主体
// 简化：用列直方图找主区域的 y 范围（水印在右下角，白像素少）
console.log(`全图白像素 bbox x ${x0}..${x1} y ${y0}..${y1}`);

// 主区域：取"每行白像素数 >= 2"的连续行段中最长者
const rowCount = [];
for (let y = 0; y < H; y++) { let n = 0; for (let x = 0; x < W; x++) if (lit(x, y)) n++; rowCount.push(n); }
let bs = -1, be = -1, cur = -1;
for (let y = 0; y <= H; y++) {
    const on = y < H && rowCount[y] >= 3;
    if (on && cur < 0) cur = y;
    if (!on && cur >= 0) { if (be < 0 || y - 1 - cur > be - bs) { bs = cur; be = y - 1; } cur = -1; }
}
let bx0 = 1e9, bx1 = -1;
for (let y = bs; y <= be; y++) for (let x = 0; x < W; x++) if (lit(x, y)) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; }
console.log(`主区域 bbox x ${bx0}..${bx1} (${bx1 - bx0 + 1})  y ${bs}..${be} (${be - bs + 1})`);

const COLS = parseInt(argOf('cols', 150), 10);
const bw = bx1 - bx0 + 1, bh = be - bs + 1;
const cw = bw / COLS, ch = cw * 2;      // 字符高宽比约 2:1
const ROWS = Math.max(1, Math.round(bh / ch));
console.log(`降采样：${COLS} x ${ROWS}  每格 ${cw.toFixed(2)} x ${ch.toFixed(2)} 源像素\n`);

let header = '     ';
for (let c = 0; c < COLS; c += 10) header += String(bx0 + Math.round(c * cw)).padEnd(10);
console.log(header);

for (let r = 0; r < ROWS; r++) {
    let line = '';
    for (let c = 0; c < COLS; c++) {
        const sx0 = bx0 + c * cw, sx1 = bx0 + (c + 1) * cw;
        const sy0 = bs + r * ch, sy1 = bs + (r + 1) * ch;
        let n = 0, tot = 0;
        for (let y = Math.floor(sy0); y < Math.ceil(sy1) && y < H; y++)
            for (let x = Math.floor(sx0); x < Math.ceil(sx1) && x < W; x++) { tot++; if (lit(x, y)) n++; }
        const f = tot ? n / tot : 0;
        line += f >= 0.75 ? '#' : f >= 0.4 ? '+' : f >= 0.12 ? '.' : ' ';
    }
    console.log(String(Math.round(bs + r * ch)).padStart(4) + ' ' + line);
}
