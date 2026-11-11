#!/usr/bin/env node
/*
  shader_semantic_check.js —— GLSL 语义级静态检查（jcpp 查不到的那一类）

  为什么需要：`preproc_check.js` 只管宏定义，`shader_static_check.js` 只管编码/配平，
  真正导致"每次检查都能查出问题"的是**语义类错误**，它们都能被模式化检测：

    R1  坐标空间混用：半分辨率画布的 pass 里用了全分辨率换算
        · `texelToUv()` 用的是 `viewPixelSize`（全分辨率像素尺寸）
        · 把画布纹素直接传给 `loadDepth0()` / `FetchXxx()`（需要屏幕纹素）
    R2  符号/单位：`ScreenToViewDepth()` 返回**负**视深，对它取 `max(x, 0.0)` 恒为 0
    R3  模式门控：新缓冲只在某个 `#ifdef` 下写入，读取却没有同一层保护
    R4  GLSL API 误用：`textureSize(image2D)`（image 只能用 `imageSize`）等

  用法：node scripts/shader_semantic_check.js
  退出码：0 = 通过，1 = 发现问题
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

// 移除注释，保留行号
function codeLines(file) {
  const src = fs.readFileSync(file, 'utf8').split('\n');
  const out = [];
  let inBlock = false;
  for (const line of src) {
    let code = '';
    let k = 0;
    while (k < line.length) {
      if (inBlock) {
        if (line[k] === '*' && line[k + 1] === '/') { inBlock = false; k += 2; continue; }
        k++; continue;
      }
      if (line[k] === '/' && line[k + 1] === '/') break;
      if (line[k] === '/' && line[k + 1] === '*') { inBlock = true; k += 2; continue; }
      code += line[k++];
    }
    out.push(code);
  }
  return out;
}

let issues = 0;
const report = (tag, file, line, msg, text) => {
  issues++;
  console.log(`${tag.padEnd(6)} ${file}:${line}  ${msg}${text ? '  |  ' + text.trim().slice(0, 90) : ''}`);
};

// 半分辨率画布的 pass 集合（这些文件里 texelPos 是画布坐标）
const canvasPasses = /program\/(diffuse\/(EAWF|VarianceEstimate|Accumulate|GIHistoryStore|GIStabilize|GIPrepass)\.comp)$|program\/diffuse\/Accumulate\.frag$/;

for (const file of walk(ROOT)) {
  const lines = codeLines(file);
  const isCanvas = canvasPasses.test(file.replace(/\\/g, '/')) || /halfViewSize/.test(lines.join('\n'));

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const n = i + 1;

    // R4 GLSL API 误用
    if (/textureSize\s*\(\s*colorimg/i.test(l)) report('R4', file, n, 'image2D 不能用 textureSize（应 imageSize）', l);
    if (/imageLoad\s*\(\s*colortex/i.test(l)) report('R4', file, n, 'sampler 不能用 imageLoad', l);
    if (/texelFetch\s*\(\s*colorimg/i.test(l)) report('R4', file, n, 'image2D 不能用 texelFetch', l);

    // R2 对（负）视深取 max(...,0)
    // 允许嵌套括号：max(ScreenToViewDepth(loadDepth0(t)), 0.0)
    if (/max\s*\(.*(ViewDepth|viewPos\.z|viewZ).*,\s*0\.0\s*\)/i.test(l)) {
      report('R2', file, n, 'ScreenToViewDepth/viewPos.z 是负值，max(x,0) 恒为 0（应 abs）', l);
    }

    // R1 画布 pass 里用全分辨率换算
    // 只有当 UV 进入视线/位置重建时才是错的：象限画布用 texelToUv 采样 colortex* 是正确的
    if (isCanvas && /texelToUv\s*\(/.test(l) && /ScreenToView/.test(l)) {
      report('R1', file, n, '画布坐标的 texelToUv 被用于视线/位置重建（UV 被压缩）', l);
    }
    if (isCanvas && /(loadDepth0|FetchSurfaceNormal|FetchGeometryNormal)\s*\(\s*texelPos\s*\)/.test(l)
        && !/#include/.test(l)) {
      report('R1', file, n, '画布纹素直接传给需要屏幕纹素的函数', l);
    }
  }
}

// R3 模式门控：colortex22/23 只在 VOXEL_GI_NRD_ACTIVE 下写入
{
  const gatedBuffers = ['colortex22', 'colortex23'];
  for (const file of walk(ROOT)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let depth = 0;
    const gatedStack = [];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^#\s*(if|ifdef|ifndef)/.test(t)) { depth++; gatedStack.push(/VOXEL_GI_NRD_ACTIVE/.test(t)); }
      if (/^#\s*endif/.test(t)) { depth--; gatedStack.pop(); }
      if (!/[\\/]program[\\/]/.test(file)) continue;
      for (const b of gatedBuffers) {
        if (!lines[i].includes(b)) continue;
        if (/^\s*\/\//.test(t) || /^\s*#include/.test(t) || /\/\*/.test(t)) continue;
        // 只关心"读取"：texelFetch/texture/sampler 取值
        if (!/(texelFetch|texture|textureLod)\s*\(/.test(lines[i])) continue;
        const protected_ = gatedStack.some(Boolean);
        if (!protected_) report('R3', file, i + 1, `${b} 在非 NRD 保护下被读取（该缓冲只在 NRD 模式写入）`, lines[i]);
      }
    }
  }
}

console.log(issues === 0 ? 'OK: 语义级检查全部通过' : `共 ${issues} 处问题`);
process.exitCode = issues === 0 ? 0 : 1;
