/*
 * stabilize_trace.js — 对 marching squares 的追踪结果做"顶点稳定化"
 *
 * 问题：marching squares + Douglas–Peucker 会留下一些"亚像素级的假拐点"
 * （顶点成对出现、距离 < 1.5 px，实际是一条直线上的锯齿），顶点数虚高。
 * 做法：反复合并满足以下任一条件的相邻顶点
 *   a) 两点距离 < mergeDist（默认 1.5）
 *   b) 去掉中间点后，该点到新弦的距离 < colTol（默认 0.7），即几乎共线
 * 每合并一次就重新做栅格化 IoU 校验；只接受 IoU 不下降的合并（贪心，取最优）。
 *
 * 用法：node rdc_analysis/stabilize_trace.js [--merge 1.5] [--col 0.7] [--tol 0.4]
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
const MERGE = parseFloat(argOf('merge', 1.5));
const COL = parseFloat(argOf('col', 0.7));

// 复用 marching_trace.js 的追踪逻辑：以子进程方式拿到 trace_result.json 太重，
// 这里直接 require 其导出的数据结构：读取上一次运行写出的文件。
const traceFile = path.resolve(__dirname, 'trace_result.json');
if (!fs.existsSync(traceFile)) { console.error('先运行 marching_trace.js'); process.exit(1); }
const tr = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
const BW = tr.box.w, BH = tr.box.h, X0 = tr.box.x0, Y0 = tr.box.y0;

// 归一化 -> 源图像素
let polys = tr.polys.map(p => p.map(([nx, ny]) => [(nx + 0.5) * BW + X0, (ny + 0.5) * BH + Y0]));
console.log(`读入 ${polys.length} 个多边形，顶点 ${polys.map(p => p.length).join(', ')}`);

// 参考掩膜
const im = readPNG(path.join(PACK, '1789124983903.png'));
const W = im.w, H = im.h, THR = 128;
const lit = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    const i = (y * W + x) * im.ch;
    const g = im.ch >= 3 ? 0.299 * im.px[i] + 0.587 * im.px[i + 1] + 0.114 * im.px[i + 2] : im.px[i];
    return g >= THR;
};
// 参考只取两个主连通域（排除水印）：用面积筛选
const comp = new Int32Array(W * H).fill(-1);
const sizes = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (comp[y * W + x] >= 0 || !lit(x, y)) continue;
    const id = sizes.length; const st = [x, y]; comp[y * W + x] = id; let n = 0;
    while (st.length) {
        const cy = st.pop(), cx = st.pop(); n++;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            if (lit(nx, ny) && comp[ny * W + nx] < 0) { comp[ny * W + nx] = id; st.push(nx, ny); }
        }
    }
    sizes.push(n);
}
const keepIds = new Set(sizes.map((n, i) => [n, i]).filter(([n]) => n >= 400).map(([, i]) => i));

let roiX0 = 1e9, roiY0 = 1e9, roiX1 = -1, roiY1 = -1;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (keepIds.has(comp[y * W + x])) {
        if (x < roiX0) roiX0 = x; if (x > roiX1) roiX1 = x;
        if (y < roiY0) roiY0 = y; if (y > roiY1) roiY1 = y;
    }
}

function score(ps) {
    let tp = 0, fp = 0, fn = 0;
    for (let y = roiY0 - 1; y <= roiY1 + 1; y++) for (let x = roiX0 - 1; x <= roiX1 + 1; x++) {
        const ref = comp[y * W + x] >= 0 && keepIds.has(comp[y * W + x]);
        let ins = false;
        for (const p of ps) {
            let j = p.length - 1;
            for (let i = 0; i < p.length; i++) {
                const [xi, yi] = p[i], [xj, yj] = p[j];
                if ((yi > y) !== (yj > y)) {
                    const xx = xi + (y - yi) / (yj - yi) * (xj - xi);
                    if (x < xx) ins = !ins;
                }
                j = i;
            }
        }
        if (ref && ins) tp++; else if (ins) fp++; else if (ref) fn++;
    }
    return { iou: tp / (tp + fp + fn), fp, fn };
}

const base = score(polys);
console.log(`初始：IoU=${base.iou.toFixed(5)}  漏 ${base.fn}  多 ${base.fp}`);

// 贪心合并
function distToSeg(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

let improved = true, rounds = 0;
while (improved && rounds++ < 400) {
    improved = false;
    for (let pi = 0; pi < polys.length; pi++) {
        const p = polys[pi];
        if (p.length <= 4) continue;
        for (let i = 0; i < p.length; i++) {
            const prev = p[(i - 1 + p.length) % p.length];
            const cur = p[i];
            const next = p[(i + 1) % p.length];
            const near = Math.hypot(cur[0] - next[0], cur[1] - next[1]) < MERGE;
            const flat = distToSeg(cur, prev, next) < COL;
            if (!near && !flat) continue;
            const trial = polys.map((q, k) => k === pi ? q.filter((_, m) => m !== i) : q);
            if (trial[pi].length < 4) continue;
            const s = score(trial);
            if (s.iou >= base.iou - 1e-6) {
                polys = trial;
                console.log(`  去掉顶点 (${cur[0].toFixed(1)},${cur[1].toFixed(1)})  ${near ? '[太近]' : '[近共线]'}  IoU=${s.iou.toFixed(5)} 顶点数 ${polys.reduce((t, q) => t + q.length, 0)}`);
                improved = true;
                break;
            }
        }
        if (improved) break;
    }
}

const fin = score(polys);
console.log(`\n最终：IoU=${fin.iou.toFixed(5)}  漏 ${fin.fn}  多 ${fin.fp}  顶点 ${polys.map(p => p.length).join(' + ')} = ${polys.reduce((t, p) => t + p.length, 0)}`);

// 输出归一化顶点（统一设计框）
let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
for (const p of polys) for (const [x, y] of p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
const bw = x1 - x0, bh = y1 - y0;
console.log(`\n设计框 x ${x0.toFixed(2)}..${x1.toFixed(2)}  y ${y0.toFixed(2)}..${y1.toFixed(2)}  = ${bw.toFixed(2)} x ${bh.toFixed(2)}`);
polys.forEach((p, i) => {
    console.log(`-- 多边形 ${i}（${p.length} 点）`);
    console.log('  ' + p.map(([x, y]) => `${((x - x0) / bw - 0.5).toFixed(5)},${((y - y0) / bh - 0.5).toFixed(5)}`).join('  '));
});
fs.writeFileSync(path.resolve(__dirname, 'stable_result.json'), JSON.stringify({
    box: { w: bw, h: bh, x0, y0, iou: fin.iou }, polys: polys.map(p => p.map(([x, y]) => [(x - x0) / bw - 0.5, (y - y0) / bh - 0.5]))
}, null, 1) + '\n');
console.log('\n已写出 stable_result.json');
