/*
 * edge_vertices.js — 直接从掩膜里量出各"直边"的端点，给出可手改的顶点建议
 *
 * 做法：对每个连通域
 *   1) 求凸包（logo 的每一笔都是凸多边形）→ 得到一组候选顶点；
 *   2) 对凸包每条边，用掩膜验证"该边是否为真实边界"（边两侧是否真的黑白分明）；
 *   3) 打印每条边的端点与左右两侧的实测黑白比例，方便确认/裁剪。
 * 用法：node rdc_analysis/edge_vertices.js [--png ...] [--comp 0]
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
const W = im.w, H = im.h, THR = 128;
const lit = (x, y) => x >= 0 && y >= 0 && x < W && y < H && im.px[(y * W + x) * im.ch] >= THR;

// 连通域（8 邻接）
const comp = new Int32Array(W * H).fill(-1);
const comps = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (comp[y * W + x] >= 0 || !lit(x, y)) continue;
    const id = comps.length; const st = [x, y]; comp[y * W + x] = id; const pts = [];
    while (st.length) {
        const cy = st.pop(), cx = st.pop(); pts.push([cx, cy]);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx, ny = cy + dy;
            if (!lit(nx, ny) || comp[ny * W + nx] >= 0) continue;
            comp[ny * W + nx] = id; st.push(nx, ny);
        }
    }
    comps.push({ id, pts });
}
comps.sort((a, b) => b.pts.length - a.pts.length);
console.log(`连通域：${comps.map(c => c.pts.length).join(', ')}`);

function convexHull(P) {
    const p = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
    lower.pop(); upper.pop();
    return lower.concat(upper);
}

for (const c of comps) {
    const hull = convexHull(c.pts);
    console.log(`\n=== 域 ${c.id}（${c.pts.length} px）凸包 ${hull.length} 点 ===`);
    hull.forEach(([x, y], i) => {
        // 到下一条边的方向上的邻居，估计边长
        console.log(`  v${i}: (${x}, ${y})`);
    });
    // 逐边输出：端点、长度、法向外/内的黑白比
    for (let i = 0; i < hull.length; i++) {
        const [ax, ay] = hull[i], [bx, by] = hull[(i + 1) % hull.length];
        const L = Math.hypot(bx - ax, by - ay);
        const nx = -(by - ay) / L, ny = (bx - ax) / L;
        let outW = 0, outN = 0, inW = 0, inN = 0;
        for (let t = 0.15; t <= 0.85; t += 0.05) {
            const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
            for (let d = 3; d <= 12; d++) {
                const lx = Math.round(px + nx * d), ly = Math.round(py + ny * d);
                const rx = Math.round(px - nx * d), ry = Math.round(py - ny * d);
                if (lit(lx, ly)) outW++; outN++;
                if (lit(rx, ry)) inW++; inN++;
            }
        }
        const fo = outW / outN, fi = inW / inN;
        const dir = nx > 0.3 ? '→' : nx < -0.3 ? '←' : (ny > 0 ? '↓' : '↑');
        console.log(`  边 ${i}: (${ax},${ay}) -> (${bx},${by})  长 ${L.toFixed(1)}  外法向${dir}(${nx.toFixed(2)},${ny.toFixed(2)})  外侧白 ${fo.toFixed(2)}  内侧白 ${fi.toFixed(2)}`);
    }
}
