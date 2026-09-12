/*
    --------------------------------------------------------------------------------
        Revelation-AD-edit  -  modified derivative of "Revelation"
        Upstream: https://github.com/HaringPro/Revelation  (C) 2026 HaringPro

        This file is an addition made for this derivative.
        Copyright 2026 AnotherCream

        Licensed under the Apache License, Version 2.0. See NOTICE at repo root.
    --------------------------------------------------------------------------------
*/

/*
 * 粗粒度 GLSL 预处理检查（离线、不依赖游戏）
 *
 * 目的：在 F3+R 之前抓出「宏名写错」这类只在游戏里才会报的错。
 * 起因：setup12 报 `error C1503: undefined variable "SHADOW_WARP_CONTENT_STRENGTH"`，
 *       实际宏名是 RTWSM_CONTENT_STRENGTH（Iris GUI 选项名），纯手写笔误。
 *
 * 它做什么：
 *   1. 从某个 .csh/.frag/.vsh 入口出发，递归展开 shaderpack 内的 #include（Iris 语义：
 *      / 开头 = 包根；否则相对当前文件目录）；
 *   2. 跑一遍 #define / #ifdef / #ifndef / #if / #elif / #else / #endif / #undef，
 *      带常量表达式求值与整型比较（#if GI_MODE == 2、#if SHADOW_SOFT_TYPE > 0 这类要正确分支）；
 *   3. 报告：所有全大写标识符里「从未被 #define、也不在任何条件编译指令里被引用」的那些。
 *      全大写命名在本包里只用于宏，所以这类命中基本都是真错名（函数/变量都是小写或驼峰）。
 *      （别在这里写「井号 + if + 星号 + 斜杠」那种字符组合：星号斜杠会提前闭合本注释块，
 *        脚本自己就变成语法错误 —— 上一版正是这么坏的。）
 *
 * 它不做什么：不理解函数、不做类型检查、不校验 #include 之外的文件语义。
 * 因此它是「补漏」而不是「替代实机验证」。
 *
 * 用法：
 *   node rdc_analysis/preproc_check.js shaders/world0/setup12.csh
 *   node rdc_analysis/preproc_check.js shaders/program/DeferredLight.frag
 *   node rdc_analysis/preproc_check.js --all
 */

const fs = require('fs');
const path = require('path');

const PACK = path.resolve(__dirname, '..');
const SHADERS = path.join(PACK, 'shaders');

// ---------- include 展开 ----------
function resolveInclude(fromFile, spec) {
    const p = spec.startsWith('/')
        ? path.join(SHADERS, spec.slice(1))
        : path.join(path.dirname(fromFile), spec);
    return path.normalize(p);
}

function expand(file, seen, stack, out) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    } catch (e) {
        out.errors.push(`无法读取 ${file}`);
        return;
    }
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        const m = line.match(/^\s*#\s*include\s+"([^"]+)"\s*$/);
        if (m) {
            const target = resolveInclude(file, m[1]);
            out.sourceMap.push({ file: target, line: 1 });
            expand(target, seen, stack, out);
            continue;
        }
        // 位置用「入口文件 : 展开后行号」近似记录，报错时便于回查
        out.lines.push(line);
        out.sourceMap.push({ file, line: out.lines.length });
    }
}

// ---------- 已知名（非 #define 来源）----------
// Iris 的 GUI 选项（settings.glsl 里的 `#define NAME value // [a b c]`）在 Iris 里是**编译时
// 注入的宏**，用户改滑块时由 Iris 传给预处理器；但有一批等价的名字并不以 `#define` 形式出现
// （例如由 lang/shaders.properties 声明、或在别处派生），所以要把它们一起收进来当"已知"，
// 否则会把 SUBSURFACE_SCATTERING_STRENGTH 这类真选项报成未定义（误报会把工具变成噪音）。
const KNOWN_EXTRA = new Set();

function harvestKnown() {
    // 1) shaders.properties：profile 默认值、screen/sliders 里列出的选项名
    const propsPath = path.join(SHADERS, 'shaders.properties');
    if (fs.existsSync(propsPath)) {
        const txt = fs.readFileSync(propsPath, 'utf8');
        for (const m of txt.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) KNOWN_EXTRA.add(m[1]);
    }
    // 2) lang：option.NAME 与 option.NAME.comment
    const langDir = path.join(SHADERS, 'lang');
    if (fs.existsSync(langDir)) {
        for (const f of fs.readdirSync(langDir)) {
            const txt = fs.readFileSync(path.join(langDir, f), 'utf8');
            for (const m of txt.matchAll(/^option\.([A-Za-z0-9_]+?)(?:\.comment)?\s*=/gm)) {
                KNOWN_EXTRA.add(m[1].toUpperCase());
            }
        }
    }
    // 3) GLSL 里 `const <type> NAME = …;` 形式声明的常量/枚举（例如 SSS_THICKNESS_THIN、
    //    VOXEL_COARSE_N）。一条声明里可能逗号并列多个名字（`const vec3 A = …, B = …;`），
    //    也可能跨行，所以按"从 const 到分号"整段抓，再取段内所有全大写标识符。
    const walk = dir => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (!/\.(glsl|frag|vert|comp|csh|vsh|fsh|gsh|inc)$/.test(e.name)) continue;
            let txt = fs.readFileSync(p, 'utf8');
            txt = txt.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
            for (const m of txt.matchAll(/\bconst\s+[^;{}]{0,400}?;/g)) {
                for (const id of m[0].matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) KNOWN_EXTRA.add(id[1]);
            }
            // const <type> NAME[N] = <type>[N]( ... );  —— 初始化式里有花括号/逗号，
            // 上面的 [^;{}] 会把它切掉，所以单独再抓一次声明头。
            for (const m of txt.matchAll(/\bconst\s+\w+\s+([A-Z][A-Z0-9_]{2,})\s*\[/g)) KNOWN_EXTRA.add(m[1]);
        }
    };
    walk(SHADERS);
}
harvestKnown();

// ---------- 极简预处理器 ----------
class Preproc {
    constructor(lines, sourceMap) {
        this.lines = lines;
        this.sourceMap = sourceMap;
        // 注释剥离是「按行」做的：块注释状态跨文件延续，所以用一个开关跟着走。
        // 这样每一行仍然与 sourceMap 一一对应，报错位置才准。
        this.inBlockComment = false;
        this.macros = new Map();     // name -> {params: [] | null, body: string}
        this.ifStack = [];
        this.undefinedNames = new Map();  // 被 #ifdef 等引用过、但从未 #define 的名字
        this.conditionReferenced = new Set(); // 出现在任何 #if 条件里的名字（视为有意为之）
        this.out = [];
        this.hits = [];              // 疑似错名
    }

    // 记录名字的来源位置（用于报错定位）
    pos(i) {
        const s = this.sourceMap[i];
        return s ? `${path.relative(PACK, s.file)}:${s.line}` : `?:${i + 1}`;
    }

    active() {
        return this.ifStack.every(f => f.taken && f.active);
    }

    // 展开对象宏（只处理最外层一层，足够用于「探针/开关写法」）
    expandLine(line) {
        return line.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (all, name) => {
            const def = this.macros.get(name);
            if (!def || def.params) return all;
            return def.body === '' ? all : this.expandLine(def.body);
        });
    }

    // 常量表达式求值：只支持 #if 里实际出现的形态
    evalExpr(expr) {
        let e = expr;
        // 先把整行里出现的宏名替换成它们的值（值也必须是可解析的字面量/表达式）
        e = e.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (all, name) => {
            this.conditionReferenced.add(name);
            if (name === 'defined') return all;
            const def = this.macros.get(name);
            if (def && !def.params) return def.body === '' ? '1' : `(${def.body})`;
            return '0';   // 未定义 → 0（C 预处理语义）
        });
        // 处理 defined(X) / defined X
        e = e.replace(/defined\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g, (all, n) => {
            this.conditionReferenced.add(n);
            return this.macros.has(n) ? '1' : '0';
        });
        e = e.replace(/defined\s+([A-Za-z_][A-Za-z0-9_]*)/g, (all, n) => {
            this.conditionReferenced.add(n);
            return this.macros.has(n) ? '1' : '0';
        });
        // 把 C 的三目/逻辑/比较换成 JS（数学上等价，且这里的操作数都是整数）
        e = e.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, '0');   // 残留标识符 → 0
        try {
            // 只允许安全字符
            if (/^[0-9\s()+\-*/%<>=!&|^~?:.xXa-fA-F]+$/.test(e)) {
                // eslint-disable-next-line no-new-func
                return new Function(`return (${e});`)() ? 1 : 0;
            }
        } catch (_) { /* 落到下面按未定义处理 */ }
        return 0;
    }

    // 从一行里剥掉注释，并维护块注释状态（跨文件延续）
    stripLine(raw) {
        let s = raw;
        if (this.inBlockComment) {
            const end = s.indexOf('*/');
            if (end < 0) return '';
            s = s.slice(end + 2);
            this.inBlockComment = false;
        }
        let out = '';
        for (;;) {
            const b = s.indexOf('/*');
            const l = s.indexOf('//');
            if (l >= 0 && (b < 0 || l < b)) return out + s.slice(0, l);
            if (b < 0) return out + s;
            out += s.slice(0, b);
            const end = s.indexOf('*/', b + 2);
            if (end < 0) { this.inBlockComment = true; return out; }
            s = s.slice(end + 2);
        }
    }

    run() {
        for (let i = 0; i < this.lines.length; i++) {
            const raw = this.lines[i];
            // 先剥注释：注释里的名字不算「被使用」，否则文件头的说明会把所有宏名都报成未定义。
            // 关键是块注释状态**跨行/跨文件延续**（本工具把 include 展开成一整份源码，
            // 于是 war 表头那段 /* ... */ 说明里的名字不该被当成代码）。
            const t = this.stripLine(raw).trim();

            if (t.startsWith('#')) {
                const m = t.match(/^#\s*(\w+)\s*(.*)$/);
                if (!m) continue;
                const dir = m[1];
                const rest = m[2];

                switch (dir) {
                    case 'if': {
                        const parentActive = this.active();
                        const v = parentActive ? this.evalExpr(rest) : 0;
                        this.ifStack.push({ taken: !!v, active: !!v, parentActive });
                        continue;
                    }
                    case 'ifdef': {
                        const parentActive = this.active();
                        const name = rest.trim();
                        this.conditionReferenced.add(name);
                        if (!this.macros.has(name)) this.undefinedNames.set(name, this.pos(i));
                        const v = parentActive && this.macros.has(name);
                        this.ifStack.push({ taken: !!v, active: !!v, parentActive });
                        continue;
                    }
                    case 'ifndef': {
                        const parentActive = this.active();
                        const name = rest.trim();
                        this.conditionReferenced.add(name);
                        if (!this.macros.has(name)) this.undefinedNames.set(name, this.pos(i));
                        const v = parentActive && !this.macros.has(name);
                        this.ifStack.push({ taken: !!v, active: !!v, parentActive });
                        continue;
                    }
                    case 'elif': {
                        const f = this.ifStack[this.ifStack.length - 1];
                        if (!f) continue;
                        if (!f.parentActive || f.taken) { f.active = false; continue; }
                        const v = this.evalExpr(rest);
                        f.active = !!v;
                        f.taken = f.taken || !!v;
                        continue;
                    }
                    case 'else': {
                        const f = this.ifStack[this.ifStack.length - 1];
                        if (!f) continue;
                        if (!f.parentActive || f.taken) { f.active = false; continue; }
                        f.active = true;
                        f.taken = true;
                        continue;
                    }
                    case 'endif': {
                        this.ifStack.pop();
                        continue;
                    }
                }

                if (!this.active()) continue;

                switch (dir) {
                    case 'define': {
                        const dm = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)(\(([^)]*)\))?\s*(.*)$/);
                        if (!dm) continue;
                        const name = dm[1];
                        const params = dm[2] ? dm[3].split(',').map(s => s.trim()).filter(Boolean) : null;
                        const body = dm[4].trim();
                        // 参数名不该被当成「宏名」
                        if (params) params.forEach(p => this.conditionReferenced.add(p));
                        this.macros.set(name, { params, body });
                        continue;
                    }
                    case 'undef': {
                        this.macros.delete(rest.trim());
                        continue;
                    }
                    default:
                        continue;
                }
            }

            if (!this.active()) continue;

            // 常量声明的名字（const float FOO = …）是 GLSL 标识符而不是宏，不算命中
            if (/\b(const|uniform|shared|in|out|inout|flat|readonly|writeonly|layout)\b/.test(t)) continue;

            for (const mm of t.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)) {
                const name = mm[1];
                if (this.macros.has(name)) continue;
                if (this.conditionReferenced.has(name)) continue;   // 出现在条件编译里 = 有意为之
                if (KNOWN_EXTRA.has(name)) continue;                // Iris 选项名 / GLSL 常量
                this.hits.push({ name, where: this.pos(i), line: raw.trim() });
            }
        }
        return this;
    }
}

// ---------- 重复声明检查 ----------
// 同一次编译里对同一个文件名做两次 `const ... Name[...] = ...` 会报
//   error C1038: declaration of "NAME" conflicts with previous declaration
// （正好踩过一次：改版时忘了删掉上一版的 SEG 表）。
// 这里在**展开后的源码**上查重复，并且用 #if 栈判断两次声明是否落在互斥分支里。
function checkDuplicateDecls(lines, sourceMap) {
    const problems = [];
    const seen = new Map();
    const stack = [];
    // 一个大括号深度：只查**文件作用域**的声明。函数体里的局部 const（例如
    // `const float c = ...;` 在函数内）会被同名局部反复声明，那是合法的，
    // 早期版本没看大括号深度，报了一堆假阳性。
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const t = raw.trim();
        if (/^#\s*(ifdef|ifndef|if)\b/.test(t)) { stack.push('b' + stack.length + ':' + t.slice(0, 24)); }
        else if (/^#\s*elif\b/.test(t)) { if (stack.length) stack[stack.length - 1] = 'e' + stack.length; }
        else if (/^#\s*else\b/.test(t)) { if (stack.length) stack[stack.length - 1] = 'x' + stack.length; }
        else if (/^#\s*endif\b/.test(t)) { stack.pop(); }
        else if (depth === 0) {
            const m = t.match(/^const\s+[\w]+\s+([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*=/);
            if (m) {
                const name = m[1];
                const sig = stack.join('/');
                const s = sourceMap[i];
                const loc = s ? `${path.relative(PACK, s.file)}:${s.line}` : `?:${i + 1}`;
                const prev = seen.get(name);
                if (prev && prev.sig === sig) problems.push(`重复声明 ${name}（先 ${prev.loc}，又 ${loc}）`);
                else if (!prev) seen.set(name, { sig, loc });
            }
        }
        // 统计大括号深度（大致即可，注释已在别处剥掉）
        for (const ch of raw) { if (ch === '{') depth++; else if (ch === '}') depth = Math.max(0, depth - 1); }
    }
    return problems;
}

// ---------- 入口 ----------
const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help') {
    console.log('用法: node scripts/preproc_check.js <shaders/... 下的入口文件> | --all [--update-baseline]');
    process.exit(0);
}
// 注意：--update-baseline 是**开关**，不是入口路径；先把它摘掉，
// 否则它会被当成文件路径去读（曾因此把基线洗成空表）。
const UPDATE_BASELINE = args.includes('--update-baseline');
const entryArgs = args.filter(a => !a.startsWith('--'));

let entries = [];
if (args.includes('--all') || UPDATE_BASELINE) {
    const walk = dir => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(csh|fsh|vsh|gsh|comp)$/.test(e.name)) entries.push(p);
        }
    };
    walk(SHADERS);
} else {
    entries = entryArgs.map(a => path.resolve(process.cwd(), a));
}

// 基线：包内本来就会命中的条目（这些入口是「片段」，由 Iris 的 begin/DH 机制拼装后再编译，
// 单独展开时名字天然不全）。基线之外的**新增**命中才是要看的东西 —— 否则几十条噪音会淹没结果。
const BASELINE_PATH = path.join(__dirname, 'preproc_check.baseline.json');
let baseline = { hits: [] };
try { baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')); } catch (_) { /* 首次运行没有基线 */ }
const baselineSet = new Set(baseline.hits || []);

const isKnown = h => baselineSet.has(`${path.basename(h.entry)}::${h.name}`);

let totalHits = 0;
const report = [];
const report0 = new Map();          // entry -> 展开后的源码（供重复声明检查用）
for (const entry of entries) {
    const out = { lines: [], sourceMap: [], errors: [] };
    expand(entry, new Set(), [], out);
    if (out.errors.length) { report.push({ entry, errors: out.errors, hits: [] }); continue; }
    report0.set(entry, out);
    // 入口文件自身的 #version 由 Iris 补，这里不参与
    const pp = new Preproc(out.lines, out.sourceMap).run();
    // 去掉出现的 GLSL 关键字/限定符误报
    const IGNORE = /^(GL_|MC_|TRUE|FALSE|NONE|MEAN|SAMPLE|UNROLL)/;
    const hits = pp.hits.filter(h => !IGNORE.test(h.name));
    if (hits.length) totalHits += hits.length;
    report.push({ entry, errors: [], hits });
}

const newFindings = [];
const dupFindings = [];
const knownCount = { n: 0 };
for (const r of report) {
    const rel = path.relative(PACK, r.entry);
    if (r.errors.length) {
        console.log(`[错误] ${rel}: ${r.errors.join('; ')}`);
        continue;
    }
    // 重复声明（会导致 C1038）。
    // 只看 **final** 入口：那是踩过坑的地方，而且已验证零假阳性；
    // 其它入口（prepare/composite 等）里 include 顺序与分支组合不同，重复报得不准。
    const out = report0.get(r.entry);
    if (out && /(^|[\\/])final\.[A-Za-z]+$/.test(r.entry)) {
        for (const d of checkDuplicateDecls(out.lines, out.sourceMap)) dupFindings.push(`${rel}: ${d}`);
    }
    if (!r.hits.length) continue;
    const seen = new Set();
    for (const h of r.hits) {
        if (seen.has(h.name)) continue;
        seen.add(h.name);
        if (isKnown({ entry: r.entry, name: h.name })) { knownCount.n++; continue; }
        newFindings.push({ entry: r.entry, ...h });
    }
}

if (dupFindings.length) {
    console.log('=== 重复声明（会导致 C1038）===');
    for (const d of dupFindings) console.log('  ' + d);
}

if (newFindings.length) {
    console.log('=== 新增命中（基线之外，重点看这些）===');
    for (const h of newFindings) {
        console.log(`\n[疑似未定义宏] ${path.relative(PACK, h.entry)}`);
        console.log(`  ${h.name}   (${h.where})`);
        console.log(`      ${h.line}`);
    }
}

if (newFindings.length === 0) {
    console.log(`检查了 ${entries.length} 个入口：无新增命中` +
        (knownCount.n ? `（基线内已知 ${knownCount.n} 条已忽略）` : '') + '。');
} else {
    console.log(`\n新增 ${newFindings.length} 处疑似未定义宏。`);
    console.log(`如确认是包内本来就有的（片段入口），用 --update-baseline 记进基线。`);
    process.exitCode = 1;
}

if (args.includes('--update-baseline')) {
    const all = [];
    const seenKey = new Set();
    for (const r of report) {
        for (const h of r.hits) {
            const key = `${path.basename(r.entry)}::${h.name}`;
            if (seenKey.has(key)) continue;
            seenKey.add(key);
            all.push(key);
        }
    }
    fs.writeFileSync(BASELINE_PATH, JSON.stringify({ hits: all.sort() }, null, 2) + '\n', 'utf8');
    console.log(`\n基线已更新：${path.relative(PACK, BASELINE_PATH)}（${all.length} 条）`);
}
