/*
 * poly_diff.js — 把 shader 里的 LOGO_PATH 多边形按扫描线做精确覆盖，
 * 和网页渲染出来的 PNG 逐行比对，找出"多边形应该填但没填"的地方。
 * 用法：node rdc_analysis/poly_diff.js <png> --offx N --offy N --scale N
 */
const fs = require('fs');
const path = require('path');
const { readPNG } = require('./png_read');
const PACK = path.resolve(__dirname, '..');

// 支持 --k=v 和 --k v 两种写法
const argOf = (k, d) => {
    for (let i = 0; i < process.argv.length; i++) {
        const a = process.argv[i];
        if (a === `--${k}` && i + 1 < process.argv.length) return parseFloat(process.argv[i + 1]);
        if (a.startsWith(`--${k}=`)) return parseFloat(a.slice(k.length + 3));
    }
    return d;
};
const png = process.argv[2];
const OFFX = argOf('offx', 0), OFFY = argOf('offy', 0), SC = argOf('scale', 1);

const glsl = fs.readFileSync(path.join(PACK, 'shaders', 'lib', 'post', 'StartupLogo.glsl'), 'utf8');
const num = n => parseFloat(new RegExp(`#define\\s+${n}\\s+([-0-9.]+)`).exec(glsl)[1]);
const BOX_W = num('LOGO_BOX_W'), BOX_H = num('LOGO_BOX_H');
const pb = /const vec2 LOGO_PATH\[(\d+)\] = vec2\[\d+\]\(([\s\S]*?)\n\);/.exec(glsl);
let P = [...pb[2].matchAll(/vec2\(([^)]+)\)/g)].map(m => m[1].split(',').map(s => parseFloat(s.trim())));
const seen = new Set();
P = P.filter(p => { const k = p.join(','); if (seen.has(k)) return false; seen.add(k); return true; })
     .map(([x, y]) => [(x + 0.5) * BOX_W, (y + 0.5) * BOX_H]);

// 扫描线：偶数规则，求多边形与 y=Y 的交点，成对得到填充区间
function scanline(Y) {
    const xs = [];
    for (let i = 0; i < P.length; i++) {
        const a = P[i], b = P[(i + 1) % P.length];
        if ((a[1] <= Y && b[1] > Y) || (b[1] <= Y && a[1] > Y))
            xs.push(a[0] + (Y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    const segs = [];
    for (let i = 0; i + 1 < xs.length; i += 2) segs.push([xs[i], xs[i + 1]]);
    return segs;
}

const im = readPNG(png);
const THR = 200;
console.log(`比对 ${png} (${im.w}x${im.h})  多边形框 ${BOX_W}x${BOX_H}  屏幕换算 off=${OFFX},${OFFY} scale=${SC}`);
console.log('设计y   期望区间(设计坐标)                      实测区间(换算回设计坐标)                 差异');
let bad = 0, checked = 0;
for (let dy = 2; dy < BOX_H - 1; dy += 6) {
    const exp = scanline(dy + 0.5);
    const py = Math.round(OFFY + dy * SC);
    if (py < 0 || py >= im.h) continue;
    const got = [];
    let s = -1;
    for (let x = 0; x < im.w; x++) {
        const i = (py * im.w + x) * im.ch;
        const w = im.px[i] >= THR && im.px[i + 1] >= THR && im.px[i + 2] >= THR;
        if (w && s < 0) s = x; else if (!w && s >= 0) { got.push([(s - OFFX) / SC, (x - 1 - OFFX) / SC]); s = -1; }
    }
    if (s >= 0) got.push([(s - OFFX) / SC, (im.w - 1 - OFFX) / SC]);
    const fe = exp.map(([a, b]) => `${a.toFixed(0)}-${b.toFixed(0)}`).join(' | ') || '(空)';
    const fg = got.map(([a, b]) => `${a.toFixed(0)}-${b.toFixed(0)}`).join(' | ') || '(空)';
    // 用区间总长度粗判
    const le = exp.reduce((t, [a, b]) => t + b - a, 0);
    const lg = got.reduce((t, [a, b]) => t + b - a, 0);
    const miss = Math.abs(le - lg) > 6 ? '  <<< 不一致' : '';
    if (miss) bad++;
    checked++;
    console.log(`${String(dy).padStart(4)}   ${fe.padEnd(42)} ${fg.padEnd(40)}${miss}`);
}
console.log(`\n检查 ${checked} 行，不一致 ${bad} 行`);
