/*
 * side_by_side.js — 把 shader 多边形栅格化结果 与 源图掩膜 用同样的降采样并排打印
 * 用途：一眼看出形状是否上下/左右翻转、哪一部分不对。
 * 用法：node rdc_analysis/side_by_side.js [--cols 76]
 */
const fs = require('fs');
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
function insideShader(dx, dy) {
    const qx = dx / BOX_W - 0.5, qy = dy / BOX_H - 0.5;
    let ins = false;
    for (const P of POLYS) {
        let j = P.length - 1;
        for (let i = 0; i < P.length; i++) {
            const a = P[i], b = P[j];
            if ((a[1] > qy) !== (b[1] > qy)) {
                const xInt = a[0] + (qy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]);
                if (qx < xInt) ins = !ins;
            }
            j = i;
        }
    }
    return ins;
}

// 源掩膜
const im = readPNG(path.join(PACK, '1789124983903.png'));
const SW = im.w, SH = im.h, THR = 128;
const lit = (x, y) => {
    if (x < 0 || y < 0 || x >= SW || y >= SH) return false;
    const i = (y * SW + x) * im.ch;
    const g = im.ch >= 3 ? 0.299 * im.px[i] + 0.587 * im.px[i + 1] + 0.114 * im.px[i + 2] : im.px[i];
    return g >= THR;
};
// 取两个主连通域的 bbox
const comp = new Int32Array(SW * SH).fill(-1);
const sizes = [];
for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
    if (comp[y * SW + x] >= 0 || !lit(x, y)) continue;
    const id = sizes.length; const st = [x, y]; comp[y * SW + x] = id; let n = 0;
    while (st.length) {
        const cy = st.pop(), cx = st.pop(); n++;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= SW || ny >= SH) continue;
            if (lit(nx, ny) && comp[ny * SW + nx] < 0) { comp[ny * SW + nx] = id; st.push(nx, ny); }
        }
    }
    sizes.push(n);
}
const keepIds = new Set(sizes.map((n, i) => [n, i]).filter(([n]) => n >= 400).map(([, i]) => i));
let X0 = 1e9, Y0 = 1e9, X1 = -1, Y1 = -1;
for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
    if (keepIds.has(comp[y * SW + x])) { X0 = Math.min(X0, x); X1 = Math.max(X1, x); Y0 = Math.min(Y0, y); Y1 = Math.max(Y1, y); }
}

const COLS = parseInt(argOf('cols', 76), 10);
const cw = BOX_W / COLS, chh = cw * 2;
const ROWS = Math.round(BOX_H / chh);
console.log(`源图 bbox x ${X0}..${X1}  y ${Y0}..${Y1}   设计框 ${BOX_W} x ${BOX_H}`);
console.log(`降采样 ${COLS} x ${ROWS}   左 = shader 几何   右 = 源图掩膜\n`);

let header = '     ';
for (let c = 0; c < COLS; c += 10) header += String(Math.round(c * cw)).padEnd(10);
console.log(header + '   |');

for (let r = 0; r < ROWS; r++) {
    let left = '', right = '';
    for (let c = 0; c < COLS; c++) {
        const x0 = c * cw, x1 = (c + 1) * cw, y0 = r * chh, y1 = (r + 1) * chh;
        let n = 0, t = 0;
        for (let y = Math.floor(y0); y < Math.ceil(y1); y++)
            for (let x = Math.floor(x0); x < Math.ceil(x1); x++) { t++; if (insideShader(x, y)) n++; }
        left += (t ? n / t : 0) > 0.5 ? '#' : ' ';
        n = 0; t = 0;
        for (let y = Math.floor(y0); y < Math.ceil(y1); y++)
            for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
                t++;
                const sx = Math.round(X0 + x), sy = Math.round(Y0 + y);
                if (sx < SW && sy < SH && comp[sy * SW + sx] >= 0 && keepIds.has(comp[sy * SW + sx])) n++;
            }
        right += (t ? n / t : 0) > 0.5 ? '#' : ' ';
    }
    const same = left === right ? '' : '   <<< 不同';
    console.log(String(Math.round(r * chh)).padStart(4) + ' ' + left + '  |' + right + same);
}

// 逐块差异统计
let diffCells = 0, totalCells = 0;
for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
        const x0 = c * cw, x1 = (c + 1) * cw, y0 = r * chh, y1 = (r + 1) * chh;
        let n = 0, t = 0;
        for (let y = Math.floor(y0); y < Math.ceil(y1); y++)
            for (let x = Math.floor(x0); x < Math.ceil(x1); x++) { t++; if (insideShader(x, y)) n++; }
        const a = t ? n / t : 0;
        n = 0; t = 0;
        for (let y = Math.floor(y0); y < Math.ceil(y1); y++)
            for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
                t++;
                const sx = Math.round(X0 + x), sy = Math.round(Y0 + y);
                if (sx < SW && sy < SH && comp[sy * SW + sx] >= 0 && keepIds.has(comp[sy * SW + sx])) n++;
            }
        const b = t ? n / t : 0;
        totalCells++;
        if (Math.abs(a - b) > 0.5) diffCells++;
    }
}
console.log(`\n显著不同的格子：${diffCells} / ${totalCells}`);
