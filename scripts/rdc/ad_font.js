/*
 * ad_font.js — 读取 StartupLogo.glsl 里的 "AD Edit" 字模，供各预览脚本共用。
 *
 * 字模本身由 gen_ad_font.js 生成（下标映射也从那里来）。这里只负责解析，
 * 这样所有预览脚本（实机尺寸预览、翻转对照、字模大图）用的是同一份数据，
 * 不会再出现"某个脚本自己按 ascii 推算下标"导致预览和 shader 不一致的情况。
 */
const fs = require('fs');
const path = require('path');

function loadAdFont(glslPath) {
    const glsl = fs.readFileSync(glslPath, 'utf8');
    const num = n => {
        const m = new RegExp(`#define\\s+${n}\\s+([-0-9.]+)`).exec(glsl);
        if (!m) throw new Error(`找不到 #define ${n}`);
        return parseFloat(m[1]);
    };
    const GLYPH_COUNT = num('AD_GLYPH_COUNT'), SLOTS = num('AD_GLYPH_SLOTS');

    const strokesRaw = /const vec4 AD_STROKES\[(\d+)\] = vec4\[\d+\]\(([\s\S]*?)\n\);/.exec(glsl);
    if (!strokesRaw) throw new Error('找不到 AD_STROKES');
    const strokes = [...strokesRaw[2].matchAll(/vec4\(([^)]+)\)/g)].map(x => {
        const parts = x[1].split(',').map(s => parseFloat(s.trim())).filter(v => !Number.isNaN(v));
        // GLSL 里零段写作 vec4(0.0)，只有一个分量；这里补齐成 4 个
        if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
        if (parts.length !== 4) throw new Error(`AD_STROKES 里出现 ${parts.length} 个分量的 vec4：${x[0]}`);
        return parts;
    });
    if (strokes.length !== GLYPH_COUNT * SLOTS) {
        throw new Error(`AD_STROKES 段数 ${strokes.length} != ${GLYPH_COUNT}×${SLOTS}`);
    }

    const advRaw = /const float AD_ADVANCE\[(\d+)\] = float\[\d+\]\(([\s\S]*?)\n\);/.exec(glsl);
    if (!advRaw) throw new Error('找不到 AD_ADVANCE');
    const advance = advRaw[2].split(',').map(s => parseFloat(s.trim()));

    // 字形局部坐标 -> 设计框坐标的缩放（× 大写高）
    const AD_H = num('LOGO_AD_H'), BOX_H = num('LOGO_BOX_H'), AD_GAP = num('LOGO_AD_GAP');
    // 笔画宽度现在是"源像素"常量（不再是字号的比例）
    const strokeWidth = num('LOGO_AD_STROKE');

    // AD_ADVANCE 里已经是最终格宽（× 大写高，含左右留白），不需要再乘别的系数
    const totalAdv = advance.reduce((a, b) => a + b, 0);
    const x0 = num('LOGO_BOX_W') * 0.5 - totalAdv * AD_H * 0.5;
    const y0 = BOX_H + AD_GAP;

    // 展开成设计框坐标下的线段（跳过零长度段）
    const segments = [];
    let penX = x0;
    for (let g = 0; g < GLYPH_COUNT; g++) {
        const ox = penX;
        penX += advance[g] * AD_H;
        for (let s = 0; s < SLOTS; s++) {
            const st = strokes[g * SLOTS + s];
            if (Math.hypot(st[2] - st[0], st[3] - st[1]) < 1e-4) continue;
            segments.push({
                glyph: g, slot: s,
                x1: ox + st[0] * AD_H, y1: y0 + st[1] * AD_H,
                x2: ox + st[2] * AD_H, y2: y0 + st[3] * AD_H
            });
        }
    }
    return {
        glsl, GLYPH_COUNT, SLOTS, strokes, advance, AD_H, AD_GAP, BOX_H,
        BOX_W: num('LOGO_BOX_W'), strokeWidth, strokeHalf: strokeWidth * 0.5,
        totalW: totalAdv * AD_H, x0, y0, segments
    };
}

module.exports = { loadAdFont };
