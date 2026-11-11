#!/usr/bin/env node
/*
  shader_static_check.js —— GLSL 源码"预处理级"静态检查

  为什么需要：Iris 用 jcpp 做预处理，以下任何一条都会让整个包加载失败，
  但 `preproc_check.js`（宏定义检查）看不到它们。2026-11-08 就因一条注释里混进
  form feed (0x0C) —— jcpp 把它当换行，`//` 注释被切断，后面的全角括号成了代码 ——
  导致 `GLSL source pre-processing failed / Bad token [Unknown65288]`。

  检查项：
    1. 控制字符（0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F）：0x0C 会切断注释，其余多为粘贴事故
    2. 代码区非 ASCII：jcpp 会把全角标点当 Bad token（注释里没问题，代码里致命）
    3. 块注释符号平衡、以及文件结束时是否仍在块注释内
    4. #if/#ifdef/#ifndef 与 #endif 配平
    5. `//` 注释以反斜杠结尾（行拼接会把下一行吞进注释）
    6. 二进制/编码异常：文件必须能按严格 UTF-8 解码

  用法：node scripts/shader_static_check.js
  退出码：0 = 通过，1 = 有问题
*/
const fs = require('fs');
const path = require('path');

const ROOT = 'shaders';
const EXT = /\.(frag|comp|glsl|vsh|fsh|csh)$/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.test(e.name)) out.push(p);
  }
  return out;
}

function stripComments(line, ref) {
  let out = '';
  let k = 0;
  while (k < line.length) {
    if (ref.inBlock) {
      if (line[k] === '*' && line[k + 1] === '/') { ref.inBlock = false; k += 2; continue; }
      k++; continue;
    }
    if (line[k] === '/' && line[k + 1] === '/') break;
    if (line[k] === '/' && line[k + 1] === '*') { ref.inBlock = true; k += 2; continue; }
    out += line[k++];
  }
  return out;
}

let issues = 0;
const report = (tag, file, line, msg, text) => {
  issues++;
  console.log(`${tag.padEnd(9)} ${file}:${line}  ${msg}${text ? '  |  ' + text.trim().slice(0, 90) : ''}`);
};

for (const file of walk(ROOT)) {
  const buf = fs.readFileSync(file);
  let txt;
  try {
    txt = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    report('ENCODING', file, 0, '不是合法 UTF-8');
    continue;
  }
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) report('BOM', file, 1, '存在 UTF-8 BOM');

  const lines = txt.split('\n');
  const ref = { inBlock: false };
  let depth = 0;

  lines.forEach((line, i) => {
    const n = i + 1;
    // 1) 控制字符
    const ctrl = [...line].filter(c => {
      const p = c.codePointAt(0);
      return (p <= 8) || p === 11 || p === 12 || (p >= 14 && p <= 31);
    });
    if (ctrl.length) {
      report('CTRL', file, n, '控制字符 ' + ctrl.map(c => '0x' + c.codePointAt(0).toString(16).toUpperCase()).join(','),
        line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '?'));
    }
    // 2) 代码区非 ASCII
    const code = stripComments(line, ref);
    const nonAscii = [...code].filter(c => c.codePointAt(0) > 127);
    if (nonAscii.length) report('NONASCII', file, n, '代码区含非 ASCII「' + nonAscii.join('') + '」', line);
    // 5) // 注释反斜杠结尾
    if (/\/\/[^\n]*\\\s*$/.test(line)) report('SPLICE', file, n, '// 注释以 \\ 结尾（行拼接）', line);
    // 4) 条件编译配平
    const t = line.trim();
    if (/^#\s*(if|ifdef|ifndef)\b/.test(t)) depth++;
    if (/^#\s*endif\b/.test(t)) depth--;
  });

  // 3) 块注释
  if (ref.inBlock) report('BLOCK', file, lines.length, '文件结束时仍在 /* 块注释内');
  // 4) 条件编译
  if (depth !== 0) report('IFDEF', file, lines.length, '#if/#endif 不配平（差 ' + depth + '）');
}

console.log(issues === 0 ? 'OK: 静态检查全部通过' : `共 ${issues} 处问题`);
process.exitCode = issues === 0 ? 0 : 1;
