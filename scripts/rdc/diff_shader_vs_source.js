/*
 * diff_shader_vs_source.js — 把 shader 多边形栅格化结果和源图掩膜对齐后逐像素比对
 * 用途：确认 shader 端的多边形并集（不是网页 SVG 预览）真的还原了原图。
 * 用法：node rdc_analysis/diff_shader_vs_source.js
 */
const fs = require('fs');
const path = require('path');
const { readPNG } = require('./png_read');

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

// 源掩膜：只取两个主连通域，并求整体 bbox
const im = readPNG(path.join(PACK, '1789124983903.png'));
const SW = im.w, SH = im.h, THR = 128;
const lit = (x, y) => {
    if (x < 0 || y < 0 || x >= SW || y >= SH) return false;
    const i = (y * SW + x) * im.ch;
    const g = im.ch >= 3 ? 0.299 * im.px[i] + 0.587 * im.px[i + 1] + 0.114 * im.px[i + 2] : im.px[i];
    return g >= THR;
};
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
console.log(`源掩膜 bbox x ${X0}..${X1} (${X1 - X0 + 1})  y ${Y0}..${Y1} (${Y1 - Y0 + 1})`);
console.log(`shader 设计框 ${BOX_W} x ${BOX_H}`);
console.log(`尺寸差异：宽 ${(BOX_W - (X1 - X0 + 1)).toFixed(2)}  高 ${(BOX_H - (Y1 - Y0 + 1)).toFixed(2)}（应约等于 0）`);

// 用设计框归一化坐标判断：设计坐标 (dx,dy) -> 源像素 (X0+dx, Y0+dy)
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

let tp = 0, fp = 0, fn = 0;
const rows = [];
// 源掩膜与设计框的对应关系存在亚像素不确定性（bbox 差 0.55/0.71 px），
// 先做一次亚像素对齐搜索，再按最优偏移统计，避免把"错位"误当成"形状不对"。
function evalOffset(ox, oy) {
    let a = 0, b = 0, c = 0;
    for (let dy = 0; dy < BOX_H; dy += 1) for (let dx = 0; dx < BOX_W; dx += 1) {
        const sx = Math.floor(X0 + ox + dx), sy = Math.floor(Y0 + oy + dy);
        const ref = sx >= 0 && sy >= 0 && sx < SW && sy < SH && comp[sy * SW + sx] >= 0 && keepIds.has(comp[sy * SW + sx]);
        const mine = insideShader(dx + 0.5, dy + 0.5);
        if (ref && mine) a++; else if (mine) b++; else if (ref) c++;
    }
    return { iou: a / (a + b + c), fp: b, fn: c };
}
let best = null;
for (let ox = -1; ox <= 1.001; ox += 0.25) for (let oy = -1; oy <= 1.001; oy += 0.25) {
    const r = evalOffset(ox, oy);
    if (!best || r.iou > best.iou) best = { ...r, ox, oy };
}
console.log(`\n亚像素对齐搜索：最佳偏移 (${best.ox}, ${best.oy})  IoU=${best.iou.toFixed(5)}`);
tp = Math.round(best.iou * 1); // 占位，下面重新统计
{
    const ox = best.ox, oy = best.oy;
    tp = fp = fn = 0;
    for (let dy = 0; dy < BOX_H; dy++) {
        let line = '';
        for (let dx = 0; dx < BOX_W; dx++) {
            const sx = Math.floor(X0 + ox + dx), sy = Math.floor(Y0 + oy + dy);
            const ref = sx >= 0 && sy >= 0 && sx < SW && sy < SH && comp[sy * SW + sx] >= 0 && keepIds.has(comp[sy * SW + sx]);
            const mine = insideShader(dx + 0.5, dy + 0.5);
            if (ref && mine) { tp++; line += '#'; }
            else if (mine) { fp++; line += '+'; }
            else if (ref) { fn++; line += '-'; }
            else line += '.';
        }
        rows.push(line);
    }
}
const iou = tp / (tp + fp + fn);
console.log(`\nshader 几何 vs 源图：IoU=${iou.toFixed(5)}  漏 ${fn} px  多 ${fp} px`);

// 差异分布：按 12x12 分块统计，找出误差最大的区域
const BX = 12, BY = 12;
const bw = Math.ceil(BOX_W / BX), bh = Math.ceil(BOX_H / BY);
const blk = [];
for (let by = 0; by < BY; by++) {
    const row = [];
    for (let bx = 0; bx < BX; bx++) {
        let bad = 0;
        for (let y = by * bh; y < Math.min(BOX_H, (by + 1) * bh); y++)
            for (let x = bx * bw; x < Math.min(BOX_W, (bx + 1) * bw); x++) {
                const c = rows[Math.floor(y)][Math.floor(x)];
                if (c === '+' || c === '-') bad++;
            }
        row.push(bad);
    }
    blk.push(row);
}
const maxBad = Math.max(...blk.flat());
console.log(`\n差异热区（每格 ${bw.toFixed(0)}x${bh.toFixed(0)} 源像素，数字=误差像素数，最大 ${maxBad}）：`);
for (const row of blk) console.log('  ' + row.map(v => String(v).padStart(4)).join(''));
