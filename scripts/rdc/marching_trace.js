/*
 * marching_trace.js — 用 marching squares 提取每个连通域的轮廓，Douglas–Peucker 简化，
 * 并逐个域做栅格化自校验（IoU 必须接近 1），最后输出归一化顶点表。
 *
 * 为什么不用 Moore 跟踪/手工共线合并：
 *   - Moore 跟踪会在细颈处走丢（实测漏掉 1538 px）；
 *   - 手工在 (u,v) 里合并共线，前提是"所有边都是竖直或 45°"，但实测 V 的右臂约
 *     53°，前提不成立，结果一条边都没合并掉。
 * marching squares 直接给出亚像素等值线，配上逐域 IoU 校验，错了一眼就能看出来。
 *
 * 用法：node rdc_analysis/marching_trace.js [--png ...] [--tol 1.5] [--thr 128] [--min 400]
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
const im = readPNG(path.join(PACK, argOf('png', '1789124983903.png')));
const W = im.w, H = im.h, THR = parseInt(argOf('thr', 128), 10);
const TOL = parseFloat(argOf('tol', 1.5));
const MIN = parseInt(argOf('min', 400), 10);

// 场：白=+1，黑=-1（等值线取 0，即交界中点）
const fld = new Float32Array(W * H);
for (let i = 0, n = W * H; i < n; i++) {
    const p = i * im.ch;
    const g = im.ch >= 3 ? 0.299 * im.px[p] + 0.587 * im.px[p + 1] + 0.114 * im.px[p + 2] : im.px[p];
    fld[i] = g - THR;      // >0 为白
}

// 连通域（8 邻接），用于把轮廓归属到域
const comp = new Int32Array(W * H).fill(-1);
const comps = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (comp[y * W + x] >= 0 || fld[y * W + x] <= 0) continue;
    const id = comps.length; const st = [x, y]; comp[y * W + x] = id; let n = 0;
    while (st.length) {
        const cy = st.pop(), cx = st.pop(); n++;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            if (comp[ny * W + nx] >= 0 || fld[ny * W + nx] <= 0) continue;
            comp[ny * W + nx] = id; st.push(nx, ny);
        }
    }
    comps.push({ id, n });
}
const big = comps.filter(c => c.n >= MIN);
console.log(`连通域 ${comps.length} 个，保留 ${big.length} 个：` + big.map(c => `${c.id}(${c.n}px)`).join(' '));

// ---------- marching squares ----------
// 情形编号：位 0=(x,y) 位 1=(x+1,y) 位 2=(x+1,y+1) 位 3=(x,y+1)，1 表示白
function segsForCell(x, y) {
    const v = [fld[y * W + x] > 0, fld[y * W + x + 1] > 0, fld[(y + 1) * W + x + 1] > 0, fld[(y + 1) * W + x] > 0];
    const code = (v[0] ? 1 : 0) | (v[1] ? 2 : 0) | (v[2] ? 4 : 0) | (v[3] ? 8 : 0);
    if (code === 0 || code === 15) return null;
    // 边上的交点（中间值）
    const T = (a, b) => a / (a - b);            // 从 a 到 b 的插值参数
    const top = () => [x + T(fld[y * W + x], fld[y * W + x + 1]), y];
    const right = () => [x + 1, y + T(fld[y * W + x + 1], fld[(y + 1) * W + x + 1])];
    const bottom = () => [x + T(fld[(y + 1) * W + x], fld[(y + 1) * W + x + 1]), y + 1];
    const left = () => [x, y + T(fld[y * W + x], fld[(y + 1) * W + x])];
    switch (code) {
        case 1: case 14: return [[left(), top()]];
        case 2: case 13: return [[top(), right()]];
        case 3: case 12: return [[left(), right()]];
        case 4: case 11: return [[right(), bottom()]];
        case 6: case 9: return [[top(), bottom()]];
        case 7: case 8: return [[left(), bottom()]];
        case 5: {   // 鞍点：白在 (x,y) 与 (x+1,y+1)
            const c = (fld[y * W + x] + fld[(y + 1) * W + x + 1]) / 2 - (fld[y * W + x + 1] + fld[(y + 1) * W + x]) / 2;
            if (c > 0) return [[left(), top()], [right(), bottom()]];
            return [[left(), bottom()], [top(), right()]];
        }
        case 10: {  // 鞍点：白在 (x+1,y) 与 (x,y+1)
            const c = (fld[y * W + x + 1] + fld[(y + 1) * W + x]) / 2 - (fld[y * W + x] + fld[(y + 1) * W + x + 1]) / 2;
            if (c > 0) return [[top(), right()], [left(), bottom()]];
            return [[left(), top()], [right(), bottom()]];
        }
        default: return null;
    }
}

// 收集所有线段并按端点串成环（坐标量化为 1e-4 以避免浮点误差）
const segs = [];
for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
    const s = segsForCell(x, y);
    if (s) for (const sg of s) segs.push(sg);
}
const q = v => Math.round(v * 10000) / 10000;
const P2K = p => `${q(p[0])},${q(p[1])}`;
const adj = new Map();
for (const [a, b] of segs) {
    const ka = P2K(a), kb = P2K(b);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka).push({ to: kb, pt: b, from: ka, fpt: a });
    adj.get(kb).push({ to: ka, pt: a, from: kb, fpt: b });
}
const usedE = new Set();
const EK = (a, b) => a < b ? a + '|' + b : b + '|' + a;
const loops = [];
for (const [k0, lst] of adj) {
    for (const e0 of lst) {
        if (usedE.has(EK(k0, e0.to))) continue;
        const loop = [];
        let cur = k0, e = e0, guard = 0;
        while (true) {
            loop.push(e.fpt);
            usedE.add(EK(cur, e.to));
            cur = e.to;
            if (cur === k0) break;
            const cands = adj.get(cur);
            let nxt = null;
            for (const c of cands) if (!usedE.has(EK(cur, c.to))) { nxt = c; break; }
            if (!nxt) break;
            e = nxt;
            if (++guard > 2000000) break;
        }
        if (loop.length >= 8) loops.push(loop);
    }
}
console.log(`等值线环 ${loops.length} 个`);

function areaOf(p) {
    let a = 0;
    for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; a += x1 * y2 - x2 * y1; }
    return a / 2;
}
function dp(points, tol) {
    if (points.length < 4) return points.slice();
    const keepF = new Uint8Array(points.length);
    keepF[0] = keepF[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
        const [i0, i1] = stack.pop();
        if (i1 <= i0 + 1) continue;
        const [x0, y0] = points[i0], [x1, y1] = points[i1];
        const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1e-9;
        let maxD = -1, maxI = -1;
        for (let i = i0 + 1; i < i1; i++) {
            const [px, py] = points[i];
            const d = Math.abs((px - x0) * dy - (py - y0) * dx) / len;
            if (d > maxD) { maxD = d; maxI = i; }
        }
        if (maxD > tol) { keepF[maxI] = 1; stack.push([i0, maxI], [maxI, i1]); }
    }
    return points.filter((_, i) => keepF[i]);
}

// 域归属：用环面积符号筛外轮廓（逆时针），再按环上一点落在哪个域
function compAt(px, py) {
    const x = Math.floor(px), y = Math.floor(py);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (fld[ny * W + nx] > 0) return comp[ny * W + nx];
    }
    return -1;
}

const polys = [];
const byComp = new Map();
loops.forEach((L, i) => {
    const a = areaOf(L);
    const s = dp(L, TOL);
    const cid = compAt(L[0][0], L[0][1]);
    const tag = a > 0 ? '外' : '洞';
    const nSeg = s.reduce((t, p, k) => t + Math.hypot(p[0] - s[(k + 1) % s.length][0], p[1] - s[(k + 1) % s.length][1]), 0);
    console.log(`  环 ${i}: ${L.length} 点 -> ${s.length} 点  面积 ${a.toFixed(1)} [${tag}]  域 ${cid}  周长 ${nSeg.toFixed(1)}`);
    // 注意：本实现的环是顺时针（面积为负），外轮廓取 a < 0
    if (a < 0 && big.some(c => c.id === cid)) {
        polys.push(s);
        byComp.set(cid, (byComp.get(cid) || 0) + 1);
    }
});

// ---------- 全局栅格化校验 ----------
function inside(x, y) {
    let ins = false;
    for (const p of polys) {
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
    return ins;
}
let tp = 0, fp = 0, fn = 0;
const badList = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ref = big.some(c => c.id === comp[y * W + x]);
    const mine = inside(x + 0.5, y + 0.5);
    if (ref && mine) tp++;
    else if (mine) { fp++; if (badList.length < 10) badList.push(`+(${x},${y})`); }
    else if (ref) { fn++; if (badList.length < 10) badList.push(`-(${x},${y})`); }
}
console.log(`\n栅格化自校验：IoU=${(tp / (tp + fp + fn)).toFixed(5)}  漏 ${fn} px  多 ${fp} px  顶点合计 ${polys.reduce((t, p) => t + p.length, 0)}`);
if (badList.length) console.log('  差异样例: ' + badList.join(' '));

// ---------- 归一化输出 ----------
let X0 = 1e9, Y0 = 1e9, X1 = -1, Y1 = -1;
for (const p of polys) for (const [x, y] of p) { X0 = Math.min(X0, x); X1 = Math.max(X1, x); Y0 = Math.min(Y0, y); Y1 = Math.max(Y1, y); }
const BW = X1 - X0, BH = Y1 - Y0;
console.log(`\n统一设计框：x ${X0.toFixed(2)}..${X1.toFixed(2)}  y ${Y0.toFixed(2)}..${Y1.toFixed(2)}  即 ${BW.toFixed(2)} x ${BH.toFixed(2)}`);
polys.forEach((p, i) => {
    console.log(`-- 多边形 ${i}：${p.length} 点`);
    console.log('  ' + p.map(([x, y]) => `${((x - X0) / BW - 0.5).toFixed(5)},${((y - Y0) / BH - 0.5).toFixed(5)}`).join('  '));
});
fs.writeFileSync(path.resolve(__dirname, 'trace_result.json'), JSON.stringify({
    box: { w: BW, h: BH, x0: X0, y0: Y0 },
    polys: polys.map(p => p.map(([x, y]) => [(x - X0) / BW - 0.5, (y - Y0) / BH - 0.5]))
}, null, 1) + '\n');
console.log('\n已写出 trace_result.json');
