/*
 * boundary_chain.js — 用"边界边成环"的精确方法提取掩膜的闭合边界多边形
 *
 * 为什么不用 Moore 跟踪：Moore 跟踪容易在细颈/斜角处走丢（实测漏掉 1538 px）。
 * 这里改用精确做法：
 *   1) 把每个白像素展开成 4 条单位边，只保留"邻格为黑"的那些 → 得到边界边集合；
 *   2) 按端点把边串成闭合环（每个顶点的入度=出度，可唯一配对）；
 *   3) 输出每个环的顶点数、面积、以及"每条边的方向"，用于判断真实直边。
 * 这样得到的多边形在像素栅格上与原掩膜**完全一致**（IoU 应为 1）。
 *
 * 用法：node rdc_analysis/boundary_chain.js [--png ...] [--min 400]
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
const W = im.w, H = im.h, THR = 128;
const lum = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return 0;
    const i = (y * W + x) * im.ch;
    return im.ch >= 3 ? Math.round(0.299 * im.px[i] + 0.587 * im.px[i + 1] + 0.114 * im.px[i + 2]) : im.px[i];
};
const lit = (x, y) => lum(x, y) >= THR;

// 连通域（8 邻接），用于筛掉水印
const comp = new Int32Array(W * H).fill(-1);
const comps = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (comp[y * W + x] >= 0 || !lit(x, y)) continue;
    const id = comps.length; const st = [x, y]; comp[y * W + x] = id; let n = 0;
    while (st.length) {
        const cy = st.pop(), cx = st.pop(); n++;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            if (!lit(nx, ny) || comp[ny * W + nx] >= 0) continue;
            comp[ny * W + nx] = id; st.push(nx, ny);
        }
    }
    comps.push({ id, n });
}
const MIN = parseInt(argOf('min', 400), 10);
const keep = new Set(comps.filter(c => c.n >= MIN).map(c => c.id));
console.log(`连通域 ${comps.length} 个，保留 ${keep.size} 个（>=${MIN} px）`);

// ---------- 边界边 ----------
// 顶点用 (gx, gy) 网格坐标，范围 [0..W]x[0..H]
// 白像素 (x,y) 占 [x,x+1]x[y,y+1]。四条边逆时针？这里用"左/下/右/上"保证外边界逆时针
const edgeMap = new Map();
const key = (x, y) => y * (W + 1) + x;
function addEdge(x1, y1, x2, y2) {
    const k = key(x1, y1);
    if (!edgeMap.has(k)) edgeMap.set(k, []);
    edgeMap.get(k).push([x2, y2]);
}
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!keep.has(comp[y * W + x])) continue;
    // 逆时针：下边 (x,y)->(x+1,y)? 用统一方向，靠后续判断
    if (!lit(x, y - 1)) addEdge(x, y, x + 1, y);           // 上边：向右
    if (!lit(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);   // 右边：向下
    if (!lit(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);   // 下边：向左
    if (!lit(x - 1, y)) addEdge(x, y + 1, x, y);           // 左边：向上
}

// ---------- 串环 ----------
const used = new Set();
const rings = [];
const ekey = (x1, y1, x2, y2) => `${x1},${y1}>${x2},${y2}`;
for (const [sk, outs] of edgeMap) {
    for (const o of outs) {
        const sx = sk % (W + 1), sy = Math.floor(sk / (W + 1));
        if (used.has(ekey(sx, sy, o[0], o[1]))) continue;
        const ring = [];
        let cx = sx, cy = sy, nx = o[0], ny = o[1];
        let guard = 0;
        while (true) {
            ring.push([cx, cy]);
            used.add(ekey(cx, cy, nx, ny));
            cx = nx; cy = ny;
            if (cx === sx && cy === sy) break;
            const cand = edgeMap.get(key(cx, cy));
            if (!cand) { console.warn('  环断了'); break; }
            let next = null;
            for (const c of cand) if (!used.has(ekey(cx, cy, c[0], c[1]))) { next = c; break; }
            if (!next) { console.warn('  环提前结束'); break; }
            nx = next[0]; ny = next[1];
            if (++guard > 4000000) break;
        }
        if (ring.length >= 4) rings.push(ring);
    }
}
console.log(`边界环 ${rings.length} 个`);

function area(r) {
    let a = 0;
    for (let i = 0; i < r.length; i++) {
        const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length];
        a += x1 * y2 - x2 * y1;
    }
    return a / 2;
}
rings.sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));

// ---------- 简化：合并共线 ----------
function simplify(r, tol) {
    const out = [];
    const n = r.length;
    for (let i = 0; i < n; i++) {
        const p0 = r[(i - 1 + n) % n], p1 = r[i], p2 = r[(i + 1) % n];
        const d1 = [p1[0] - p0[0], p1[1] - p0[1]], d2 = [p2[0] - p1[0], p2[1] - p1[1]];
        const cr = d1[0] * d2[1] - d1[1] * d2[0];
        const l1 = Math.hypot(...d1) || 1, l2 = Math.hypot(...d2) || 1;
        if (Math.abs(cr) / (l1 * l2) > tol) out.push(p1);   // 保留拐点
    }
    return out;
}

const reports = [];
rings.forEach((r, i) => {
    const a = area(r);
    const s = simplify(r, 1e-6);
    console.log(`\n环 ${i}: ${r.length} 边界点  面积 ${a.toFixed(1)}  ${a > 0 ? '(逆时针=外轮廓)' : '(顺时针=洞)'}  共线合并后 ${s.length} 点`);
    // 打印方向直方图，帮助确认真实直边方向
    const dirs = new Map();
    for (let k = 0; k < r.length; k++) {
        const [x1, y1] = r[k], [x2, y2] = r[(k + 1) % r.length];
        const dx = x2 - x1, dy = y2 - y1;
        const dk = dx === 0 ? (dy > 0 ? 'v-下' : 'v-上') : (dy === 0 ? (dx > 0 ? 'h-右' : 'h-左') : `${dx},${dy}`);
        dirs.set(dk, (dirs.get(dk) || 0) + 1);
    }
    console.log('  单位边方向统计: ' + [...dirs.entries()].map(([k, v]) => `${k}×${v}`).join('  '));
    if (a > 0) {
        console.log(`  外轮廓顶点（网格坐标）共 ${s.length} 个：`);
        console.log('    ' + s.map(([x, y]) => `(${x},${y})`).join(' '));
        reports.push({ i, pts: s, area: a });
    }
});

fs.writeFileSync(path.resolve(__dirname, 'boundary_rings.json'), JSON.stringify(reports, null, 1) + '\n');
console.log(`\n已写出 boundary_rings.json`);
