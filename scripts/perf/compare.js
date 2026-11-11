#!/usr/bin/env node
/*
 -------------------------------------------------------------------------------
    Revelation-AD-edit 性能对比工具（Node，无第三方依赖）
    ------------------------------------------------------------------
    用途：对比两次 RenderDoc 抓帧导出的 pass GPU 时序（rdc_export.py 产出），
          输出 markdown 表格，按绝对耗时变化排序，快速定位"哪个 pass 变了"。

    输入：两个（或多个）JSON 基线文件。
          第一个为基线（旧），其余为对比（新）。每个文件结构：
            {
              "name":  "baseline_forest_noon",      // 可选，场景/档位描述
              "frame": 123,                          // 可选，抓帧号
              "total_us": 12345.6,                   // 单帧 GPU 总耗时（微秒）
              "passes": [
                { "name": "DeferredLight", "us": 2300.5 },
                ...
              ]
            }
          相同 pass 名对齐；只出现在其中一边的行会标 新增/移除。

    用法：
      node compare.js old.json new.json [--top N] [-j]
        --top N   只显示 |Δus| 最大的前 N 行（默认全部）
        -j        同时输出 json 结果（供自动化/进一步汇总）

    输出：markdown 表写到 stdout，并覆盖写 perf_compare_<basename>.md。
 -------------------------------------------------------------------------------
*/

'use strict';

const fs = require('fs');
const path = require('path');

function load(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// 单个文件 -> map<passName, us>
function toMap(rec) {
  const m = new Map();
  for (const p of (rec.passes || [])) m.set(p.name, p.us);
  return m;
}

function main() {
  const args = process.argv.slice(2);
  let top = Infinity;
  let asJson = false;
  const files = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-j') { asJson = true; continue; }
    if (a === '--top') {
      if (i + 1 < args.length && /^\d+$/.test(args[i + 1])) {
        top = parseInt(args[i + 1], 10); i++;
      }
      continue;
    }
    if (a.startsWith('--top=')) { top = parseInt(a.slice(6), 10) || Infinity; continue; }
    if (a.startsWith('-')) { continue; }
    files.push(a);
  }

  if (files.length < 2) {
    console.error('用法: node compare.js baseline.json optimized.json [--top N] [-j]');
    process.exit(1);
  }

  const recs = files.map(f => ({ file: f, rec: load(f) }));
  const base = toMap(recs[0].rec);

  // ---- 核心对比：基线 vs 每个后续文件 ----
  const results = [];
  for (let c = 1; c < recs.length; c++) {
    const cmp = toMap(recs[c].rec);
    const out = [];
    const thisNames = new Set([...base.keys(), ...cmp.keys()]);
    for (const name of thisNames) {
      const o = base.has(name) ? base.get(name) : null;
      const n = cmp.has(name) ? cmp.get(name) : null;
      const dUs = (n != null ? n : 0) - (o != null ? o : 0);
      const pct = (o != null && o > 0 && n != null) ? ((n - o) / o) * 100 : null;
      out.push({ name, oldUs: o, newUs: n, dUs, pct });
    }
    // 按 |Δus| 降序
    out.sort((a, b) => Math.abs(b.dUs) - Math.abs(a.dUs));
    const shown = out.slice(0, top);

    const totalOld = recs[0].rec.total_us != null ? recs[0].rec.total_us : null;
    const totalNew = recs[c].rec.total_us != null ? recs[c].rec.total_us : null;

    results.push({ vs: recs[c].file, totalOld, totalNew, rows: shown });
  }

  // ---- 输出 ----
  let md = '';
  const main = results[0];
  if (!main) { console.error('至少需要一个对比文件'); process.exit(1); }

  // 汇总
  md += `# 性能对比：${recs[0].file} → ${main.vs}\n\n`;
  if (recs[0].rec.name && main && recs[0].file) {
    // 可选打印描述
  }
  if (main.totalOld != null && main.totalNew != null) {
    const dTotal = main.totalNew - main.totalOld;
    const pct = main.totalOld > 0 ? (dTotal / main.totalOld) * 100 : null;
    md += `## 帧总耗时\n\n`;
    md += `| 旧 (μs) | 新 (μs) | Δ (μs) | Δ% |\n|---|---|---|---|\n`;
    md += `| ${main.totalOld.toFixed(1)} | ${main.totalNew.toFixed(1)} | ${dTotal.toFixed(1)} | ${pct != null ? pct.toFixed(2) + '%' : '-'} |\n\n`;
  }
  md += `## Pass 级耗时（按 |Δ| 降序）\n\n`;
  md += `| Pass | 旧 (μs) | 新 (μs) | Δ (μs) | Δ% | 状态 |\n|---|---|---|---|---|---|\n`;
  for (const r of main.rows) {
    const o = r.oldUs != null ? r.oldUs.toFixed(1) : '-';
    const n = r.newUs != null ? r.newUs.toFixed(1) : '-';
    const d = r.oldUs == null ? `+${r.newUs.toFixed(1)}` : (r.newUs == null ? `-${r.oldUs.toFixed(1)}` : r.dUs.toFixed(1));
    const pct = r.pct != null ? (r.pct >= 0 ? '+' : '') + r.pct.toFixed(2) + '%' : '-';
    const status = r.oldUs == null ? '新增' : (r.newUs == null ? '移除' : '');
    md += `| ${r.name} | ${o} | ${n} | ${d} | ${pct} | ${status} |\n`;
  }
  md += `\n_共 ${main.rows.length} 个 pass（前 ${top === Infinity ? '全部' : top} 个）_\n`;

  // 多对比文件时附加其余
  for (let i = 1; i < results.length; i++) {
    const r = results[i];
    md += `\n---\n\n## vs ${r.vs}\n\n`;
  }

  const outFile = `perf_compare_${path.basename(main.vs, path.extname(main.vs))}.md`;
  fs.writeFileSync(outFile, md);
  console.log(md);

  if (asJson) {
    const json = {
      baseline: recs[0].file,
      compared: main.vs,
      total_us: { old: main.totalOld, new: main.totalNew },
      passes: main.rows,
    };
    const jf = `perf_compare_${path.basename(main.vs, path.extname(main.vs))}.json`;
    fs.writeFileSync(jf, JSON.stringify(json, null, 2));
    console.error(`json -> ${jf}`);
  }
}

main();