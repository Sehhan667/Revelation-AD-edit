#!/usr/bin/env node
'use strict';

/**
 * 宏 / 声明同名冲突检查（独立脚本，不改动 preproc_check 的基线）
 *
 * 为什么需要它：
 *   2026-11-11 deferred11 崩溃，Iris 报
 *     "no viable alternative at input 'const float 0.02'"
 *   根因是 `#define PLANE_DIST_SENS_TS 0.02` 与
 *   `const float PLANE_DIST_SENS_TS = 0.02;` 同名 —— 预处理把名字换成 0.02，
 *   于是这一行变成 `const float 0.02 = 0.02;`。
 *   现有三套脚本都只做文本级检查、不做 GLSL 语法解析，抓不到这类错误，
 *   只有 Iris 里的 ANTLR 编译器会拒绝。本脚本补这个盲区。
 *
 * 判定口径（刻意保守，宁少报不乱报）：
 *   1. 只看**对象式宏**（`#define X v`）。函数式宏 `#define X(...)` 不会被
 *      `X = ...` 触发替换，安全，直接跳过。
 *   2. 只看**同一文件内**的冲突 —— 这是严格必然成立的错误，退出码 1。
 *      跨文件的默认不输出（不同 pass 是不同编译单元，宏本来就不互相影响），
 *      加 `--cross` 才列出，仅作人工参考。
 *   3. 只看**替换值不是单一标识符**的宏。`#define CLEAR_IMAGE skyMapImg` 后面接
 *      `vec4 CLEAR_IMAGE;` 是合法的别名用法（展开成 `vec4 skyMapImg;`）；
 *      而 `#define X 0.02` 后面接 `float X;` 会展开成 `float 0.02;` —— 后者才炸。
 *   4. 带**分支互斥判定**：同名的宏与声明若处在 `#if/#elif/#else` 的不同分支，
 *      视为互斥、跳过（例如 Entities.frag 的 `#define geoNormal` 与 `#else` 里的
 *      `in vec3 geoNormal`）。
 *   5. 带**顺序判定**：预处理是自上而下的一次扫描，声明写在宏定义**之前**时，
 *      那几行根本没被替换过，不算冲突（ffx_common_types.glsl 就是这种情况：
 *      类型别名宏在 250 行之后定义，同名函数在第 92~127 行使用）。
 *   6. 跳过 `//` 与 `/* *\/` 注释内的文本。
 *
 * 用法：
 *   node scripts/macro_collision_check.js                 # 检查 shaders/
 *   node scripts/macro_collision_check.js --root <dir>    # 检查指定目录
 *   node scripts/macro_collision_check.js --verbose       # 列出全部跨文件提示
 *
 * 退出码：0 = 无文件内冲突；1 = 有冲突。
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const ROOT = path.resolve(getArg('--root', path.join(__dirname, '..', 'shaders')));
const VERBOSE = args.includes('--verbose');
const SHOW_CROSS = args.includes('--cross');

const EXTS = /\.(glsl|comp|frag|vsh|csh|gsh|tes|tcs)$/;

// 声明：可选的存储/插值限定符 + 类型 + 名字 + 可选的 `[...]` + `= ; ,`
const QUAL = '(?:(?:const|uniform|in|out|inout|centroid|flat|smooth|noperspective|highp|mediump|lowp)\\s+)*';
const TYPE = '(?:float|double|int|uint|bool|vec[234]|dvec[234]|ivec[234]|uvec[234]|bvec[234]|mat[234]|mat[234]x[234]|sampler\\w*|samplerCube\\w*|image\\w*|atomic_uint)';
const DECL_RE = new RegExp('(?:^|[;{}()\\s,])' + QUAL + TYPE + '\\s+([A-Za-z_]\\w*)\\s*(?:\\[[^\\]]*\\])?\\s*[=;,]', 'g');

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walk(fp, out);
    else if (EXTS.test(e.name)) out.push(fp);
  }
  return out;
}

/** 去掉注释；块注释跨行维护 inBlock。返回可参与匹配的代码文本。 */
function stripComments(line, state) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (state.inBlock) {
      const end = line.indexOf('*/', i);
      if (end === -1) return out;
      state.inBlock = false;
      i = end + 2;
      continue;
    }
    const b = line.indexOf('/*', i);
    const l = line.indexOf('//', i);
    if (l !== -1 && (b === -1 || l < b)) {
      out += line.slice(i, l);
      return out;
    }
    if (b !== -1) {
      out += line.slice(i, b);
      state.inBlock = true;
      i = b + 2;
      continue;
    }
    out += line.slice(i);
    break;
  }
  return out;
}

/** a、b 两条分支路径是否互斥（在同一个 #if 组里落在不同分支）。 */
function exclusive(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i].g !== b[i].g) return false; // 不同嵌套层，无法判定，按“不互斥”保守处理
    if (a[i].b !== b[i].b) return true;  // 同组不同分支 ⇒ 互斥
  }
  return false;
}

const fmt = (p) => path.relative(process.cwd(), p).replace(/\\/g, '/');

const files = walk(ROOT, []).sort();
const localProblems = [];
const crossHints = [];
const globalMacros = new Map(); // name -> [{file, line}]

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const state = { inBlock: false };
  const stack = [];
  let gid = 0;

  const macros = [];  // {name, line, path}
  const decls = [];   // {name, line, path}
  const pathSnapshot = () => stack.map((f) => ({ g: f.g, b: f.b }));

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = stripComments(raw, state);
    if (!code.trim()) continue;

    // 分支栈维护
    if (/^\s*#\s*(if|ifdef|ifndef)\b/.test(code)) {
      stack.push({ g: ++gid, b: 0 });
      // #if 行本身也可能带 #define（罕见），继续往下走
    } else if (/^\s*#\s*(elif|else)\b/.test(code)) {
      if (stack.length) stack[stack.length - 1].b++;
      continue;
    } else if (/^\s*#\s*endif\b/.test(code)) {
      if (stack.length) stack.pop();
      continue;
    }

    const dm = code.match(/^\s*#\s*define\s+([A-Za-z_]\w*)(\()?(.*)$/);
    if (dm && !dm[2]) {
      // 替换值是单一标识符 ⇒ 这是“起别名”的合法用法，声明同名变量不会炸
      const isAlias = /^[A-Za-z_]\w*$/.test((dm[3] || '').trim());
      if (!isAlias) {
        macros.push({ name: dm[1], line: i + 1, path: pathSnapshot() });
      }
      if (!globalMacros.has(dm[1])) globalMacros.set(dm[1], []);
      globalMacros.get(dm[1]).push({ file, line: i + 1, isAlias });
      continue;
    }
    if (dm && dm[2]) continue; // 函数式宏，跳过

    DECL_RE.lastIndex = 0;
    let m;
    while ((m = DECL_RE.exec(code)) !== null) {
      decls.push({ name: m[1], line: i + 1, path: pathSnapshot() });
    }
  }

  // 同文件冲突：宏 vs 声明，且不互斥
  const byName = new Map();
  for (const d of decls) {
    if (!byName.has(d.name)) byName.set(d.name, []);
    byName.get(d.name).push(d);
  }
  for (const mac of macros) {
    const ds = byName.get(mac.name);
    if (!ds) continue;
    for (const d of ds) {
      // 声明写在宏定义之前 ⇒ 预处理还没替换到它，不算冲突
      if (d.line < mac.line) continue;
      if (!exclusive(mac.path, d.path)) {
        localProblems.push({ file, macro: mac, decl: d });
        break; // 同一名字只报一次
      }
    }
  }
}

// 跨文件提示（不影响退出码，默认不显示；不同 pass 是不同编译单元，多数是噪音）
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const state = { inBlock: false };
  for (let i = 0; i < lines.length; i++) {
    const code = stripComments(lines[i], state);
    if (!code.trim()) continue;
    DECL_RE.lastIndex = 0;
    let m;
    while ((m = DECL_RE.exec(code)) !== null) {
      const name = m[1];
      const defs = (globalMacros.get(name) || []).filter((d) => !d.isAlias);
      if (!defs.length) continue;
      if (defs.some((d) => d.file === file)) continue; // 同文件的已在上面处理
      crossHints.push({ file, line: i + 1, name, defs });
    }
  }
}

// ---- 输出 ----
let failed = false;

if (localProblems.length) {
  failed = true;
  console.log('✗ 宏 / 声明同名冲突（同文件、非互斥分支）\n');
  for (const p of localProblems) {
    console.log(`  ${fmt(p.file)}`);
    console.log(`    宏   ${p.macro.name}   定义于 :${p.macro.line}`);
    console.log(`    声明 ${p.decl.name}   于 :${p.decl.line}`);
    console.log(`    → 预处理会把名字替换掉，Iris ANTLR 会报 "no viable alternative at input ..."\n`);
  }
}

if (crossHints.length && SHOW_CROSS) {
  const shown = VERBOSE ? crossHints : crossHints.slice(0, 15);
  console.log(`提示：跨文件同名 ${crossHints.length} 处（需人工确认；同文件互斥分支已排除）`);
  for (const h of shown) {
    const where = h.defs.map((d) => `${fmt(d.file)}:${d.line}`).join(', ');
    console.log(`  ${fmt(h.file)}:${h.line}  声明 ${h.name}  ← 宏见于 ${where}`);
  }
  if (!VERBOSE && crossHints.length > shown.length) {
    console.log(`  ...（其余 ${crossHints.length - shown.length} 条用 --verbose 查看）`);
  }
  console.log('');
}

if (!failed) {
  console.log(`OK: 未发现宏/声明同名冲突（扫描 ${files.length} 个文件）`);
  if (crossHints.length) {
    console.log(`（另有 ${crossHints.length} 处跨文件同名，默认不判定；需要时加 --cross 查看）`);
  }
}

process.exit(failed ? 1 : 0);
