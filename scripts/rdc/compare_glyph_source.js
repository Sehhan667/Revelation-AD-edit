/*
 * compare_glyph_source.js — 把 shader 表里的字形 与 hersheytext.json 里对应下标的字形
 * 逐段对照，定位"生成时取错下标 / 解析错"的问题。
 * 用法：node rdc_analysis/compare_glyph_source.js
 */
const fs = require('fs');
const path = require('path');
const PACK = path.resolve(__dirname, '..');
const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'hersheytext.json'), 'utf8'));
const F = j.futural.chars;
const glsl = fs.readFileSync(path.join(PACK, 'shaders', 'lib', 'post', 'StartupLogo.glsl'), 'utf8');

const SLOTS = parseInt(/#define\s+AD_GLYPH_SLOTS\s+(\d+)/.exec(glsl)[1], 10);
const COUNT = parseInt(/#define\s+AD_GLYPH_COUNT\s+(\d+)/.exec(glsl)[1], 10);
const raw = /const vec4 AD_STROKES\[(\d+)\] = vec4\[\d+\]\(([\s\S]*?)\n\);/.exec(glsl)[2];
const rows = [...raw.matchAll(/vec4\(([^)]+)\)/g)].map(x => x[1].split(',').map(s => parseFloat(s.trim())));
const labels = [...raw.matchAll(/\/\/\s*"(.+)"\s*\n\s*vec4\(/g)].map(m => m[1]);

// 复刻 gen_ad_font.js 的读取逻辑（含 GLYPH_INDEX）
const genSrc = fs.readFileSync(path.join(__dirname, 'gen_ad_font.js'), 'utf8');
const mapBlock = /const GLYPH_INDEX = \{([\s\S]*?)\n\};/.exec(genSrc)[1];
const GLYPH_INDEX = {};
for (const m of mapBlock.matchAll(/'(.+?)':\s*\{\s*idx:\s*(\d+)/g)) GLYPH_INDEX[m[1]] = parseInt(m[2], 10);
console.log('gen_ad_font.js 里的映射：', JSON.stringify(GLYPH_INDEX));

function parsePath(d) {
    const polys = [];
    for (const sub of d.trim().split(/\s*M/).filter(Boolean)) {
        const nums = [...sub.matchAll(/(-?\d+),(-?\d+)/g)].map(m => [+m[1], +m[2]]);
        if (nums.length >= 2) polys.push(nums);
    }
    return polys;
}
const U = 18, XOFF = 4, YOFF = 1;

console.log('\n字形逐一对照（表里的前 3 段 vs 源数据换算后应有的前 3 段）');
let bad = 0;
for (let g = 0; g < COUNT; g++) {
    const ch = labels[g];
    console.log(`\n--- 字形 ${g} ${JSON.stringify(ch)} ---`);
    const tbl = rows.slice(g * SLOTS, g * SLOTS + 3).map(r => r.map(v => v.toFixed(4)).join(', '));
    tbl.forEach((t, i) => console.log(`   表[${i}] ${t}`));

    if (ch === ' ') { console.log('   （空格，表里就是零段）'); continue; }
    const idx = GLYPH_INDEX[ch];
    if (idx === undefined) { console.log(`   !!! 映射里没有 ${JSON.stringify(ch)}`); bad++; continue; }
    const src = F[idx];
    const polys = parsePath(src.d);
    const flat = [];
    for (const p of polys) for (let i = 0; i + 1 < p.length; i++) flat.push([p[i], p[i + 1]]);
    const exp = flat.slice(0, 3).map(([[ax, ay], [bx, by]]) =>
        [((ax - XOFF) / U).toFixed(4), ((ay - YOFF) / U).toFixed(4), ((bx - XOFF) / U).toFixed(4), ((by - YOFF) / U).toFixed(4)].join(', '));
    exp.forEach((t, i) => console.log(`   源[${i}] ${t}   ${t === tbl[i] ? 'OK' : '<<< 不一致'}`));
    if (exp[0] !== tbl[0]) bad++;
    console.log(`   源路径 idx ${idx}: ${src.d.slice(0, 80)}`);
}
console.log(bad ? `\n${bad} 个字形不一致` : '\n全部一致');
