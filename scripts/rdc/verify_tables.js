/*
 * verify_tables.js — 核对 shader 里各常量表的"声明长度 vs 实际条目数"是否一致
 * 用法：node rdc_analysis/verify_tables.js
 */
const fs = require('fs');
const path = require('path');
const PACK = path.resolve(__dirname, '..');
const g = fs.readFileSync(path.join(PACK, 'shaders', 'lib', 'post', 'StartupLogo.glsl'), 'utf8');

let bad = 0;
function check(name, re, countRe) {
    const m = re.exec(g);
    if (!m) { console.log(`  ${name}: !!! 没找到`); bad++; return; }
    const declared = parseFloat(m[1]);
    const items = [...m[2].matchAll(countRe)].length;
    const ok = declared === items;
    if (!ok) bad++;
    console.log(`  ${name}: 声明 ${declared}，实际 ${items} ${ok ? 'OK' : '!!! 不一致'}`);
}

check('LOGO_POLY0', /const vec2 LOGO_POLY0\[(\d+)\] = vec2\[\d+\]\(([\s\S]*?)\n\);/, /vec2\(/g);
check('LOGO_POLY1', /const vec2 LOGO_POLY1\[(\d+)\] = vec2\[\d+\]\(([\s\S]*?)\n\);/, /vec2\(/g);
check('AD_STROKES', /const vec4 AD_STROKES\[(\d+)\] = vec4\[\d+\]\(([\s\S]*?)\n\);/, /vec4\(/g);

// 归一化顶点必须落在 [-0.5, 0.5]
for (const n of ['LOGO_POLY0', 'LOGO_POLY1']) {
    const re = new RegExp(`const vec2 ${n}\\[(\\d+)\\] = vec2\\[\\d+\\]\\(([\\s\\S]*?)\\n\\);`);
    const m = re.exec(g);
    const pts = [...m[2].matchAll(/vec2\(([^)]+)\)/g)].map(x => x[1].split(',').map(Number));
    const out = pts.filter(([x, y]) => x < -0.5001 || x > 0.5001 || y < -0.5001 || y > 0.5001);
    console.log(`  ${n}: 越界顶点 ${out.length} 个 ${out.length ? '!!! ' + JSON.stringify(out) : 'OK'}`);
    if (out.length) bad++;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    console.log(`    x ${Math.min(...xs).toFixed(4)}..${Math.max(...xs).toFixed(4)}   y ${Math.min(...ys).toFixed(4)}..${Math.max(...ys).toFixed(4)}`);
}

// 重复的 #define
const seen = new Map();
fs.readFileSync(path.join(PACK, 'shaders', 'lib', 'post', 'StartupLogo.glsl'), 'utf8').split(/\r?\n/).forEach((l, i) => {
    const m = /^\s*#define\s+(\w+)/.exec(l);
    if (!m) return;
    if (seen.has(m[1])) { console.log(`  !!! 重复宏 ${m[1]}：行 ${seen.get(m[1]) + 1} 与 ${i + 1}`); bad++; }
    else seen.set(m[1], i);
});
console.log(`  宏 ${seen.size} 个，无重复`);

console.log(bad ? `\n发现 ${bad} 处问题` : `\n全部一致`);
process.exit(bad ? 1 : 0);
