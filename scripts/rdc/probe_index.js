/*
 * probe_index.js — 直接打印若干下标处的字形原始数据，用来定位"哪个下标是哪个字母"
 * 用法：node rdc_analysis/probe_index.js 34 37 38 86 87
 */
const fs = require('fs');
const path = require('path');
const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'hersheytext.json'), 'utf8'));
const F = j.futural.chars;
const idxs = process.argv.slice(2).map(Number);
if (!idxs.length) { console.log('用法: node probe_index.js <idx> [idx...]'); process.exit(0); }
for (const i of idxs) {
    const g = F[i];
    console.log(`--- idx ${i}  o=${g ? g.o : '-'} ---`);
    console.log('   ' + (g ? g.d : '(无)'));
}
