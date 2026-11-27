/*
 * find_space.js — 找出字体里"空格"的下标（= 没有笔画、只有字距的条目）
 * 用法：node rdc_analysis/find_space.js
 */
const fs = require('fs');
const path = require('path');
const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'hersheytext.json'), 'utf8'));
const F = j.futural.chars;

function segCount(d) {
    let n = 0;
    for (const sub of d.trim().split(/\s*M/).filter(Boolean)) {
        const c = [...sub.matchAll(/(-?\d+),(-?\d+)/g)].length;
        if (c >= 2) n += c - 1;
    }
    return n;
}
console.log('idx  o  段数  内容');
F.forEach((g, i) => {
    const n = segCount(g.d);
    if (n === 0 || n === 1) console.log(String(i).padStart(3) + String(g.o).padStart(4) + String(n).padStart(5) + '  ' + JSON.stringify(g.d));
});
console.log('\n段数为 0 的下标：' + F.map((g, i) => [i, segCount(g.d)]).filter(([, n]) => n === 0).map(([i]) => i).join(', ') || '(无)');
console.log('o 最小的前 6 个：' + F.map((g, i) => [i, g.o]).sort((a, b) => a[1] - b[1]).slice(0, 6).map(([i, o]) => `${i}(o=${o})`).join(', '));
