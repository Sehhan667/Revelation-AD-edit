/*
 * simplify_uv.js — 在"剪切坐标"(u=x, v=x+y) 下把边界环简化成顶点表
 *
 * 关键认识：这个标志的每一条边都是**竖直**或**45°**的。
 * 在 (u,v) = (x, x+y) 坐标下，这两类边分别变成 u=const 与 v=const，
 * 于是像素边界那些"横一格竖一格"的楼梯会立刻塌成一条直线。
 * 在 (u,v) 里做共线合并，再回到 (x,y)，就能得到干净、精确的顶点表。
 *
 * 同时做栅格化自校验：把简化后的多边形按像素中心重新采样，与原掩膜逐像素比对，
 * 必须 IoU=1（或只差抗锯齿边缘的少量像素）。
 *
 * 用法：node rdc_analysis/simplify_uv.js [--png ...] [--tol 0]
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

// 连通域
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
const keepIds = new Set(comps.filter(c => c.n >= 400).map(c => c.id));

// ---------- 边界环（网格坐标，逆时针）----------
const edgeMap = new Map();
const key = (x, y) => y * (W + 1) + x;
const add = (x1, y1, x2, y2) => { const k = key(x1, y1); if (!edgeMap.has(k)) edgeMap.set(k, []); edgeMap.get(k).push([x2, y2]); };
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!keepIds.has(comp[y * W + x])) continue;
    if (!lit(x, y - 1)) add(x, y, x + 1, y);
    if (!lit(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!lit(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!lit(x - 1, y)) add(x, y + 1, x, y);
}
const used = new Set();
const EK = (a, b, c, d) => `${a},${b}>${c},${d}`;
const rings = [];
for (const [sk, outs] of edgeMap) {
    for (const o of outs) {
        const sx = sk % (W + 1), sy = Math.floor(sk / (W + 1));
        if (used.has(EK(sx, sy, o[0], o[1]))) continue;
        const ring = [];
        let cx = sx, cy = sy, nx = o[0], ny = o[1], guard = 0;
        while (true) {
            ring.push([cx, cy]);
            used.add(EK(cx, cy, nx, ny));
            cx = nx; cy = ny;
            if (cx === sx && cy === sy) break;
            const cand = edgeMap.get(key(cx, cy));
            let next = null;
            if (cand) for (const c of cand) if (!used.has(EK(cx, cy, c[0], c[1]))) { next = c; break; }
            if (!next) break;
            nx = next[0]; ny = next[1];
            if (++guard > 4000000) break;
        }
        if (ring.length >= 4) rings.push(ring);
    }
}
console.log(`边界环 ${rings.length} 个`);

// ---------- 在 (u,v) 下做共线合并 ----------
// (u,v) = (x, x+y)。只保留方向发生变化处的顶点。
function simplifyUV(ring) {
    const uv = ring.map(([x, y]) => [x, x + y]);
    const n = uv.length;
    const out = [];
    for (let i = 0; i < n; i++) {
        const p0 = uv[(i - 1 + n) % n], p1 = uv[i], p2 = uv[(i + 1) % n];
        const d1u = p1[0] - p0[0], d1v = p1[1] - p0[1];
        const d2u = p2[0] - p1[0], d2v = p2[1] - p1[1];
        const cross = d1u * d2v - d1v * d2u;
        if (cross !== 0) out.push(p1);
    }
    // 回到 (x,y)： x=u, y=v-u
    return out.map(([u, v]) => [u, v - u]);
}

function area2(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
        a += x1 * y2 - x2 * y1;
    }
    return a / 2;
}

const polys = [];
for (const r of rings) {
    const s = simplifyUV(r);
    const a = area2(s);
    console.log(`\n环: ${r.length} 边界点 -> (u,v) 共线合并后 ${s.length} 点  面积 ${a.toFixed(1)} ${a > 0 ? '逆时针(外轮廓)' : '顺时针(洞)'}`);
    console.log('  顶点(x,y): ' + s.map(([x, y]) => `(${x},${y})`).join(' '));
    console.log('  顶点(u,v): ' + s.map(([x, y]) => `(${x},${x + y})`).join(' '));
    // 边长与方向
    console.log('  各边:');
    for (let i = 0; i < s.length; i++) {
        const [ax, ay] = s[i], [bx, by] = s[(i + 1) % s.length];
        const du = bx - ax, dv = (bx + by) - (ax + ay);
        const dir = du === 0 ? '竖直 (v 变化)' : dv === 0 ? '45° (u 变化)' : `未知方向 du=${du} dv=${dv}`;
        console.log(`    ${i}: (${ax},${ay}) -> (${bx},${by})  长 ${Math.hypot(bx - ax, by - ay).toFixed(1)}  ${dir}`);
    }
    if (a > 0) polys.push(s);
}

// ---------- 栅格化自校验（用像素中心 + 0.5 偏移，与掩膜像素中心对齐）----------
function insidePolys(x, y) {
    let inside = false;
    for (const p of polys) {
        let j = p.length - 1;
        for (let i = 0; i < p.length; i++) {
            const [xi, yi] = p[i], [xj, yj] = p[j];
            if ((yi > y) !== (yj > y)) {
                const xx = xi + (y - yi) / (yj - yi) * (xj - xi);
                if (x < xx) inside = !inside;
            }
            j = i;
        }
    }
    return inside;
}
let tp = 0, fp = 0, fn = 0;
const bad = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ref = keepIds.has(comp[y * W + x]);
    const mine = insidePolys(x + 0.5, y + 0.5);
    if (ref && mine) tp++;
    else if (mine) { fp++; if (bad.length < 12) bad.push(`+ (${x},${y})`); }
    else if (ref) { fn++; if (bad.length < 12) bad.push(`- (${x},${y})`); }
}
console.log(`\n栅格化自校验：IoU=${(tp / (tp + fp + fn)).toFixed(5)}  漏 ${fn} px  多 ${fp} px`);
if (bad.length) console.log('  差异样例: ' + bad.join('  '));

fs.writeFileSync(path.resolve(__dirname, 'uv_polys.json'), JSON.stringify(polys, null, 1) + '\n');
console.log(`\n已写出 uv_polys.json（${polys.length} 个多边形）`);
