//================================================================================================//
// Voxel GI — 每像素漫反射追踪（阶段④）
//
// 与 IRC（辐照度缓存）互补：
// - IRC = 低频平滑间接光（时域累积，无方向性）
// - 本文件 = 每像素每帧投 1 条随机光线，DDA 穿过 64³ 网格，
//   命中体素后取"发射光 / 方块光 / 真阳光直射 / IRC 前帧值"，出界取天空，
//   提供锐利的一次弹射 GI（阳光的方向性反弹、近距离遮挡、彩色反弹）。
// 噪声靠 TAA 时域收敛（settings.glsl TAA_ENABLED 默认开）。
//
// 阶段④ 化（漫反射追踪实现）：
// - 共享 VoxelData.glsl：穿透式 DDA（发射光体素不挡光，球形光源平滑贡献后继续；
//   普通固体命中停止）+ 命中 albedo 用整块图集中心色（体素数据 xy=midCoord）
//   ——注意：不用 GetAtlasCoord 精确纹素（64³ 网格会把高对比纹理图案反弹到
//   相邻面 → "光源印子"，2026-08-04 实测；函数保留待形状求交阶段）
// - HemisphereUnitVector 均匀半球采样 + vertexNormal 回落：
//   采样方向若落到几何法线背面（法线贴图朝向过陡）→ 沿几何法线重采样
// - 起点沿几何法线偏移防自交（voxelPos += vertexNormal * (-viewPos.z * 0.0003)）
// - ×pdf 加权（hitSurface=pdf 约定：均匀采样 × 2cosθ = 漫反射辐照度核，
//   无 1/cos 发散、无 firefly；与 IRC 的 rcpPdf 教科书估计器不同——这是原始约定）
// - 出界天空 = skyMapTex 方向辐射 × 上半球权重 × 天空光泄漏衰减（SUNLIGHT_LEAK_FIX）
// - 发射光走 HitLightShpere 球形光源（平滑距离衰减 + 穿透）→ 修"贴光源表面
//   移动闪烁"（旧：DDA 命中发射体素 = 0/1 全强度开关）
//
// 坐标系约定（与体素化/IRC 一致）：
// - origin = 相机相对世界坐标（= DeferredLight 的 worldPos - cameraPosition）
// - 命中体素 → IRC 读取用 vc + cDi 重投影（网格跟随相机，见命中段注释）
//
// 已实现：透明单层吸收（isTranslucent：水3/玻璃4/叶13，光穿过被着色衰减一次）、
// 方块形状求交（完整版：楼梯/门/玻璃板/板条/活塞/墙/栅栏/栅栏门/
// 压力板/漏斗/活板门/堆肥桶/炼药锅/脚手架/铁砧等，形状 ID 155-294，见 VoxelShape.glsl）
// 未实现（留后续）：折射、半分辨率降采样、
// 追踪专用时域累积（现靠 TAA）。
//================================================================================================//

#include "/lib/lighting/VoxelData.glsl"
// GI 方向天空光（原创）
#include "/lib/lighting/VoxelSkyLight.glsl"
// 阳光阴影判定（SimpleShadow 实时阴影贴图 + SimpleShadowTracing 体素 DDA 短程遮挡）
#include "/lib/lighting/VoxelSunShadow.glsl"

// coarse occupancy（空洞跳跃）：VOXEL_COARSE_ACCEL 或 VOXEL_FINE_ACCEL 开启时读，R32UI bitmap
// [2026-09-06] FINE 单独开启也产生并读取 coarse：全空 4³ 粗块跳过的收益最大，细格逐格只补非空块内部。
#if defined VOXEL_COARSE_ACCEL || defined VOXEL_FINE_ACCEL
uniform usampler3D voxelCoarseSampler;
#endif
// 细格 occupancy（逐格空气跳过）：VOXEL_FINE_ACCEL 开启时读
#ifdef VOXEL_FINE_ACCEL
uniform usampler3D voxelMaskSampler;
// 细格 occupancy 位图判空（方案A）：vc 所在粗块内该格 bit。0/1 由体素化端（Shadow.frag）置位，语义同 coarse（被体素化=有内容）。
bool VoxelMaskSolid(ivec3 vc) {
    ivec3 _cc = vc >> VOXEL_COARSE_SHIFT;
    ivec3 _li = vc & (VOXEL_COARSE_GS - 1);
    uint _b  = uint(_li.x) | (uint(_li.y) << 2u) | (uint(_li.z) << 4u);
    uint _bk = _b >> 5u;
    uint _mk = 1u << (_b & 31u);
    return (texelFetch(voxelMaskSampler, ivec3(_cc.x, _cc.y, _cc.z * 2 + int(_bk)), 0).r & _mk) != 0u;
}
#endif

// 每像素漫反射追踪：
// origin = 相机相对起点；normal = 世界法线（可能含法线贴图）；vertexNormal = 几何法线；
// viewDist = 视距（-viewPos.z，供起点偏移）；skyLightmap = 像素天空 lightmap（泄漏衰减）；
// blockLightmap = 像素方块光 lightmap（出界 BlockLighting 底光）；
// 返回 0-1 尺度的"入射光"（已含命中体素 albedo 反射，未乘当前像素 albedo/强度）。
vec3 VoxelTracePixel(vec3 origin, vec3 normal, vec3 vertexNormal, float viewDist, float skyLightmap, float blockLightmap, ivec2 pixel, int sampleIndex, inout uint seed) {
    // 世界对齐网格对齐：origin 为相机相对坐标，+cameraPositionFract 抵消小数 +VOXEL_RADIUS
    // 转网格坐标（[0,VOXEL_AREA)）——与 Terrain.vert 体素化 / VoxelGI.frag 注入端
    // （起点 vec3(c)+0.5）同一坐标系。漏加 VOXEL_RADIUS 会让起点落在 -32..32 的负半区，
    // VoxelTraceDDA 判出界 [0,64) 立即退出 → 命中永远不触发、全走天空路径（"只有噪点没有光"根因）
    origin += cameraPositionFract;
    origin += float(VOXEL_RADIUS);
    // 起点沿几何法线偏移防自交（随视距增大，自交风险更高）
    origin += vertexNormal * (viewDist * 0.0003);

    // [2026-08-09] 体素网格外（像素世界位置超出 64³ 网格）没有光追数据：
    // 直接返回 0，交由 DeferredLight 的非光追路径（lightmap / SH 环境光）接管，
    // 避免"起点出界 → 立即拿天空光"导致大型洞穴里网格外的区域反而发亮。
    if (any(lessThan(origin, vec3(0.0))) || any(greaterThanEqual(origin, vec3(float(VOXEL_AREA))))) {
        return vec3(0.0);
    }

    // 方向采样：按 (像素, 帧+SPP序号) 查时空蓝噪声，
    // 相邻像素空间上蓝噪声去相关 → 1SPP 光点均匀密集（不聚簇狂闪）；跨帧变化配合时域累积。
    vec3 dir;
    float weight;
    // per-pixel 固定平移（Cranley–Patterson）：破坏 STBN 空间 tile 在特定纹理/距离下显现的整齐密集斑纹。
    // 时序变化仍由 frame 驱动；平移每像素恒定。
    vec2 _pu = vec2(pixel) * 0.1591549;
    vec2 _pur = vec2(fract(sin(_pu.x) * 43758.5453), fract(sin(_pu.y) * 43758.5453));
    vec2 _bn;
    #ifdef VOXEL_INTERLEAVED
    // [2026-09-06 Interleaved Sampling（Keller & Heidrich 2001）] 单位域 4×4=16 层：
    // 每像素固定相位（hash(pixel) 定起始层），每次重投按 van der Corput（4bit 位反转）轮转层号，
    // 层内保留蓝噪声抖动 → 任意时刻邻域像素覆盖互补层（空间交错 + 重建互相借用），
    // 单像素时域转满 16 次恰好覆盖全层（分层积分：短时域/运动期方差更低）。
    // 注意：棋盘下同一全分辨率像素每 4 帧才重投一次 → 时间步取 (frameCounter>>2)。
    // 已知边界（先想到的失败模式）：低样本 + EAWF/双线性边缘重建可能露"图案条带"；
    // 若出现 → 关掉本开关回蓝噪声（默认关，A/B 验证用）。
    {
        int _tb = (frameCounter >> 2) + int(sampleIndex);   // 本像素第几次重投（近似）
        uint _ph = uint(fract(sin(dot(vec2(pixel), vec2(12.9898, 78.233))) * 43758.5453) * 65536.0);
        uint _t = uint(_tb) + _ph;
        uint _br = ((_t & 1u) << 3u) | ((_t & 2u) << 1u) | ((_t & 4u) >> 1u) | ((_t & 8u) >> 3u);
        uint _cell = (_br + (_ph >> 4u)) & 15u;             // 16 层格之一（相位平移避免像素同步）
        vec2 _cellXY = vec2(float(_cell & 3u), float(_cell >> 2u));
        vec2 _jit = fract(SampleStbnVec2(pixel, frameCounter + sampleIndex) + _pur);
        _bn = (_cellXY + _jit) * 0.25;                      // [0,1)² 16 层之一
    }
    #else
        _bn = fract(SampleStbnVec2(pixel, frameCounter + sampleIndex) + _pur);
    #endif
    #ifdef VOXEL_COS_SAMPLING
        dir = VoxelHemisphereCosineUnitVector(normal, _bn);
        if (dot(dir, vertexNormal) <= 0.0)
            dir = VoxelHemisphereCosineUnitVector(vertexNormal, _bn);
        // 余弦密度采样 pdf=cosθ/π，权重=1（期望与 均匀×2cos 一致）
        weight = 1.0;
    #else
        vec3 _rv = VoxelSphereUnitVectorFromU(_bn);
        dir = _rv * (dot(_rv, normal) >= 0.0 ? 1.0 : -1.0);
        if (dot(dir, vertexNormal) <= 0.0) {
            vec2 _bn2 = fract(SampleStbnVec2(pixel, frameCounter + sampleIndex + 64) + _pur);
            vec3 _rv2 = VoxelSphereUnitVectorFromU(_bn2);
            dir = _rv2 * (dot(_rv2, vertexNormal) >= 0.0 ? 1.0 : -1.0);
        }
        // 余弦 pdf：均匀采样 × 2cosθ = 漫反射辐照度核（无 1/cos 发散）
        weight = saturate(dot(dir, normal)) * 2.0;
    #endif

    // ---- 穿透式 DDA 步进 ----
    // - 空气（z<=0.5，含负 ID 透明体素）→ 穿透
    // - 发射光体素（lD.x>阈值）→ 球形光源平滑贡献 + 穿透不挡光（
    //   HitLightShpere * hitSurface；修"贴光源表面 0/1 命中闪烁"——光线对准球心
    //   才强、擦边平滑衰减，不再有命中/未命中的硬跳变）
    // - 普通固体 → 命中停止（albedo/方块光/阳光/IRC 前帧）
    vec3 voxelCoord = floor(origin);
    vec3 sdir = sign(dir);
    // [FIX 2026-08-19 rdir 符号根因] rdir 必须为有符号（1/dir），IsHitBox 的 slab
    // 算法用 ray.rdir * boxMin/boxMax 计算每轴进出时间——有符号
    // 才能对负方向轴得到正确符号的 t；无符号（1/|dir|）会把负方向射线的 t 整体取反
    // → 负方向轴 tExit<0 → 命中被误判为"未命中"→ 漏光（向下/向左/向后射线穿透
    // 形状块的子盒空隙，活板门/楼梯/栅栏等半块完全不挡光）。
    // DDA 步进用 abs(rdir) 保持正步距；零分量用 1e-30 替代避免
    // inf/NaN（0*inf=NaN 会腐蚀 totalStep → DDA 死循环）。
    // [FIX 2026-08-19 零分量值根因] 原 1e-8 → rdir=1e8 → totalStep 零分量轴≈5e7
    // → VoxelMin3(totalStep) 返回零分量轴的极小值而非非零轴的真实退出距离 →
    // IsHitBox 的 rayLength（本格退出距离）≈0 → 子盒求交在极小距离内判定 →
    // 轴向射线（如正上方 GI 射线从地面起射穿水平活板门）漏判命中/未命中 →
    // 水平活板门不挡光。改用 1e-30 → rdir=1e30 → totalStep 零分量轴≈5e29
    // → VoxelMin3 正确返回非零轴退出距离（~1.0）→ 子盒求交范围正确 → 命中。
    // 0*1e30=0（非 NaN），无 DDA 死循环风险。
    vec3 rdir = 1.0 / mix(dir, vec3(1e-30), lessThanEqual(abs(dir), vec3(1e-8)));
    vec3 totalStep = (sdir * (voxelCoord - origin + 0.5) + 0.5) * abs(rdir);
    float rayLength = 0.0;
    vec3 contrib = vec3(0.0);
    // 透明吸收累积（hitSurface）：首次命中水/玻璃/树叶时着色衰减，其后贡献全乘此系数
    vec3 absorption = vec3(1.0);
    bool traceTranslucent = true;

    // [FIX 2026-08-19 起始体素检查] check-then-step：第一轮（i==0）不步进，
    // 直接检查起始体素；后续轮先步进再检查。原 step-then-check 跳过起始体素 →
    // 法线偏移把起点推入活板门/薄片方块所在体素（如活板门下方地面的上射 GI 射线）→
    // DDA 跳过该体素 → 活板门/薄片完全不挡光（水平活板门漏光根因）。
    // 改为 check-then-step 后，起始体素被检查：形状块（活板门/楼梯）子盒求交命中 →
    // 射线被挡；全块（voxelID<=154）跳过防自交（前帧传播路径：起点可能
    // 在自身方块内，检查会立即命中自身表面 → GI 射线不出门）。
    // 起点格自发光（原循环前预检）合并进循环 i==0 的发射光分支，不再单独预检。
    vec3 tracingNext = step(totalStep, vec3(VoxelMin3(totalStep)));

    for (int i = 0; i < VOXEL_TRACE_DISTANCE; ++i) {
        if (i > 0) {
            rayLength = VoxelMin3(totalStep);
            tracingNext = step(totalStep, vec3(rayLength));
            voxelCoord += tracingNext * sdir;
            totalStep += tracingNext * abs(rdir);
        }
        // [FIX 2026-08-18 阴影死黑根因] 射程用尽判定必须"步数走满"与"距离超限"都算：
        // 纯向上射线每步恰好 1 格，第 VOXEL_TRACE_DISTANCE 次迭代 rayLength 恰好等于
        // VOXEL_TRACE_DISTANCE → `>` 为 false → 循环自然结束 → exitGrid=false →
        // 出界天空路径被跳过 → 开阔阴影（正上方就是天空）只有微弱 NOLIGHT → "阴影黑洞洞"、
        // 只有网格边缘（真越界）才拿天光 → DEBUG_VOXEL_SKY"体素范围边缘才发红"（用户实测）。
        // 射程用尽（距离超限）→ 提前退出，走循环后出界路径。
        // 注：不能靠 `>` 判定"步数走满"——纯向上射线第 VOXEL_TRACE_DISTANCE 步
        // rayLength 恰为 24.0（格心起点）或 23.x（格内起点），`>` 均不触发；
        // 步数走满由循环自然结束覆盖，循环后无条件出界（见下方 FIX 注释）。
        // i==0 跳过此检查：起始体素已在循环前 origin 越界判定中验证在界内。
        if (i > 0 && rayLength > float(VOXEL_TRACE_DISTANCE)) {
            break;
        }

        if (i > 0 && (any(lessThan(voxelCoord, vec3(0.0))) || any(greaterThanEqual(voxelCoord, vec3(VOXEL_AREA))))) {
            break;
        }

        ivec3 vc = ivec3(voxelCoord);
        #if defined VOXEL_COARSE_ACCEL || defined VOXEL_FINE_ACCEL
            // ---- coarse 空洞链跳（"空气链跳"，2026-09-06）：所在 4³ 粗块全空时，沿射线方向在
            // 粗块空间连续推进，一次跨过一串全空粗块，直到进入首个非空粗块边界或离开网格——
            // 与逐块跳逐位等价（每块仍一次 coarse texelFetch），但省掉中间若干次细格循环迭代开销。
            // 网格面贴边（t≈0 无法前移）时交回逐格步进，由外层越界检查收尾。
            if (texelFetch(voxelCoarseSampler, vc >> VOXEL_COARSE_SHIFT, 0).r == 0u) {
                const float _gs = float(VOXEL_COARSE_GS);
                const int _maxHop = 32;                 // 安全上限：64³ 全空对角线也不超过 ~28 块
                int _hop = 0;
                while (_hop < _maxHop) {
                    ++_hop;
                    ivec3 _cc = ivec3(voxelCoord) >> VOXEL_COARSE_SHIFT;
                    vec3 _cb = vec3(_cc) * _gs;
                    vec3 _next = _cb + vec3(step(0.0, sdir)) * _gs;
                    vec3 _tE = mix(vec3(1e30), ((_next - voxelCoord) * sdir) * abs(rdir),
                                   greaterThan(abs(sdir), vec3(0.0)));
                    float _tM = VoxelMin3(_tE);
                    if (_tM < 1e-4) break;              // 贴面/无法前移 → 交回逐格步进
                    vec3 _grow = step(_tE, vec3(_tM));
                    voxelCoord += (_next - voxelCoord) * _grow;
                    if (any(lessThan(voxelCoord, vec3(0.0)))
                     || any(greaterThanEqual(voxelCoord, vec3(float(VOXEL_AREA)))))
                        break;                          // 出网格：外层越界检查收尾
                    if (texelFetch(voxelCoarseSampler, ivec3(voxelCoord) >> VOXEL_COARSE_SHIFT, 0).r != 0u)
                        break;                          // 进入非空粗块：交回逐格检查
                }
                totalStep = (sdir * (voxelCoord - origin + 0.5) + 0.5) * abs(rdir);
                continue;
            }
#endif
#ifdef VOXEL_FINE_ACCEL
            // coarse 非空块内逐格：细格 occupancy 位图判空（bit=0 → 空气 → 穿透，跳过重纹理 fetch）。
            // 与 coarse 空气跳过相互独立：
            // 细格位图仅覆盖"阳光可见面"被体素化的格子，未被体素化但有注入光照/发射光的实体格
            // 位图为 0 → 被当成空气跳过 → 该格漏光 → GI 空洞。出现空洞时关闭本开关、
            // 保留 coarse 空气跳过（空块整体跳过，性能大头仍在），逐格回退真实 voxelData 采样。
            if (!VoxelMaskSolid(vc)) continue;
#endif
            vec4 hvd = texelFetch(voxelDataSampler, vc, 0);
        // 判空：voxelID 原值整数（>0 即固体，0=空气；半精度浮点整数精确）
        if (hvd.z <= 0.5) {
            // 透明体素：水/玻璃/树叶单层吸收着色（isTranslucent，只吸收一次；
            // 植物/传送门纯穿透）。hvd.xy = 图集中心 UV，采样取方块颜色与不透明度。
            if (traceTranslucent && VoxelIsTranslucentAbsorb(abs(hvd.z))) {
                vec4 tc = texture(atlas2D, hvd.xy);
                absorption *= VoxelAlbedoToAbsorption(tc.rgb, tc.a);
                traceTranslucent = false;
            }
            continue;
        }

        vec3 lD = unpackUnorm4x8(texelFetch(voxelLightSampler, vc, 0).r).rgb;

        if (lD.z > VOXEL_GI_EMISSIVE_THRESHOLD) {  // 新字节序：B=emissive
            // 发射光体素：球形光源平滑贡献 + 穿透（光源不阻挡光线）。
            // 发射色 = 按材料 ID 查固定光源色表（VoxelLightColor）：火把纹理中心是
            // 暗色木杆，用纹理 albedo 当发射色会又暗又灰（"光源周围黑印"主因之一），
            // 固定暖色让火把/灯笼发出正确亮光；64³ 下精确纹素采样也会把高对比纹理
            // 图案"印"到旁边面 → 固定色 = 均匀光斑。
            vec3 albE = VoxelLightColor(abs(hvd.z));
            // 追踪端发射光：× VOXEL_GI_TRACE_LIGHT_STRENGTH 压低脉冲（1 SPP 高方差采样，
            // 语义：发射光主体由 IRC 时域累积承载，追踪只补锐利弱光；强脉冲会导致
            // 贴光源面"命中/未命中"跳变闪烁，见 VoxelLighting.glsl 宏注释）
            contrib += VoxelHitLightSphere(origin, dir, vec3(vc), albE) * absorption * VOXEL_GI_TRACE_LIGHT_STRENGTH;
            continue;
        }

        // ---- 普通固体命中：形状求交（IsHitBlock 桥接）----
        // 全块（voxelID<=154，含熔岩/发光/反光）：整格命中，法线 = -tracingNext*sdir；
        // 形状块（155-294，楼梯/门/栅栏/墙…）：HitShape 子盒判定，光线穿过子盒
        // 空隙（未命中）→ 继续步进（穿透式 DDA 语义）。hitNormal 由 IsHitBlock 输出。
        // [FIX 2026-08-19 起始体素自交防护] 起始体素（i==0）内的全块跳过——
        // 全块自交防护：法线偏移虽把起点推离
        // 表面，但起点可能仍在自身方块内（如贴面像素）→ 全块立即命中自身 → GI 射线
        // 不出门。形状块（>154）不跳过：活板门/楼梯等形状可能正对起点（如活板门下方
        // 地面的上射 GI 射线应被活板门挡住），需检查子盒求交。
        if (i == 0 && abs(hvd.z) <= 154.0) continue;

        VoxelRay vray;
        vray.ori = origin;
        vray.dir = dir;
        vray.rdir = rdir;
        vray.sdir = sdir;
        vec3 hitNormal;
        if (!IsHitBlock(vray, totalStep, tracingNext, voxelCoord, abs(hvd.z), rayLength, hitNormal))
            continue;
        // 起始体素形状命中：rayLength 可能为负（起点在子盒内部，tEnter<0）→
        // 钳到 0，避免 hitVoxelPos 落到起点后方（阴影判定/IRC 重投影位置错误）
        if (i == 0) rayLength = max(rayLength, 0.0);

        // 反弹 albedo：固体格 r/g=染过色中心色 RG、w 高 8 位=染过色 B（Shadow.frag 草方块
        // tint 修复）；不再采样 atlas2D（64³ 无法表达 16px 细节，中心色=体素平均反照率）。
        vec3 alb = vec3(hvd.r, hvd.g, VoxelUnpack2xU8X(hvd.w));

        // 方块光兜底（普通固体格带原版方块光）
        // [FIX 2026-08-06] 薄片/流体光源（发光地衣/岩浆）voxelData 中心色可能为 0 →
        // albedo 乘进 blocklight 后趋 0 不发光；用 min albedo 底，不依赖采样色。
        if (lD.y > 0.01)  // 新字节序：G=blocklight
            contrib += max(alb, vec3(VOXEL_GI_BLOCK_MIN_ALBEDO)) * blocklightColor * lD.y * VOXEL_GI_BLOCK_STRENGTH * absorption;
        // 真阳光弹射：命中面法线方向项 + 天空 lightmap 平滑衰减（SUNLIGHT_LEAK_FIX）
        // 阳光色 = 物理直射辐照度 × rcp(VOXEL_SUN_REFERENCE)（0-1 尺度，自带昼夜明暗 + 暖色温）。
        // 不能用 skyColor——它是天空蓝（环境色），与出界天空路径同色 → 反弹混进环境光里
        // 看不出"阳光反弹"（2026-08-05 用户反馈）。
        // [FIX 2026-08-05] 阳光门限改用 voxelData.w 的写胜 skylight（对应漫反射追踪
        // 的 voxelDataW.y 语义，也对应本项目 IRC 的 VoxelUnpack2xU8Y）：lD.x 来自 voxelLightData 的
        // imageAtomicMax（sky 是最低字节，max 比较被 block/emissive 高位压掉 → 门限常为 0
        // → 阳光反弹全无，这是最终根因）。hvd = 命中体素数据（voxelDataSampler）。
        vec3 sunDir = mat3(shadowModelViewInverse) * vec3(0.0, 0.0, 1.0);
        // [2026-08-19 恢复 lightmap 门控] 阳光门限用命中体素 sky（写胜 skylight），半遮挡按比例放行。
        float hitSkylight = VoxelUnpack2xU8Y(hvd.w);
        float sunLighting = saturate(dot(sunDir, hitNormal)) * saturate(max(hitSkylight, skyLightmap) * 444.0);
        // [FIX 2026-08-05] 阳光项改用本地重算的直射辐照度：诊断确认 global.directIlluminance
        // 在计算端（DiffuseIndirect）读到 0（SSBO 跨 pass 屏障/绑定问题）→ 阳光项整体乘 0
        // → 阴影纯黑。本地重算（同 GlobalStorage.comp）；若 SSBO 有值则优先用 SSBO。
        vec3 sunIlluminance = sunIrradiance * AtmosphereTransmittanceToSun(atmosphereViewPos, worldSunDir);
        vec3 moonIlluminance = sunIrradiance * AtmosphereTransmittanceToSun(atmosphereViewPos, -worldSunDir) * moonlightMult;
        vec3 directIlluminance = (sunIlluminance + moonIlluminance) * 128.0;
        directIlluminance *= smoothstep(0.0, 0.01, worldLightDir.y);
        if (max(max(global.directIlluminance.r, global.directIlluminance.g), global.directIlluminance.b) > 1e-4)
            directIlluminance = global.directIlluminance;
        // 白天兜底：SSBO/本地重算都算不出直射辐照度时用常数（排除该变量后如仍无阳光即非此因）
        if (max(max(directIlluminance.r, directIlluminance.g), directIlluminance.b) < 1e-4 && worldLightDir.y > 0.01)
            directIlluminance = vec3(128.0);
        // [FIX 2026-08-06] 阴影判定（sunVis，与注入端同逻辑，均走 VoxelSunShadowMap）：命中体素真被
        // 太阳直射才反弹阳光。此前无 sunVis，洞穴/背阴体素有微弱 sky 残留（×444 门控也放行）
        // → 8.0 倍阳光反弹 → 地下/背阴处到处都是阳光散射。
        // [2026-08-09] 用连续命中点（对应 SimpleShadow/SimpleShadowTracing
        // 的 hitVoxelPos）：整数格坐标会让阴影判定对体素化数据的逐帧更新非常敏感
        // （相机移动时网格内容变化 → sunVis 在 0/1 间跳变 → 阳光散射时有时无）。
        vec3 hitVoxelPos = origin + dir * rayLength;
        vec3 hitWorldPos = hitVoxelPos - cameraPositionFract - float(VOXEL_RADIUS);
        // 阳光可见性 = 实时阴影贴图（带命中面法线偏移防自阴影）
        // × 体素 DDA 短程遮挡（3 格内屋檐/树冠/墙角等网格内遮挡，阴影贴图分辨率外）。
        // 彩色阴影：实心挡=0，直射=1，穿玻璃=玻璃吸收色（反弹光线染色）
        vec3 sunVis = VoxelSunShadowMap(hitWorldPos, hitNormal)
                    * VoxelSunShadowTracing(hitVoxelPos, sunDir);

        // [2026-08-09 恢复] 追踪端阳光反弹已恢复（删除临时 *0.0）；sunVis 判定
        // 保证只有被太阳直射的体素才反弹阳光，洞穴/背阴处不会产生阳光散射。
        // [2026-08-20] 下界（worldId == -1）无太阳：屏蔽阳光反弹
        if (worldId != -1) {
            contrib += alb * (directIlluminance * rcp(VOXEL_SUN_REFERENCE))
                     * sunLighting * sunVis * VOXEL_TRACE_SUN_STRENGTH * absorption;
        }
        // [2026-08-19] 夜晚月光反弹：directIlluminance 里的 moon 项受 moonlightMult(~0.001)
        // 压到近 0 → 体素 GI 夜晚无间接月光。独立补方向化月光弹射：
        // 月亮 ≈ -worldSunDir，仅朝月面弹射，复用 sunVis（夜晚 shadow 贴图即月光投影）做遮挡。
        // [2026-08-20] 月光反弹只“深夜”生效：傍晚(太阳刚入夜 worldSunDir.y≈0~-0.1，天还亮着)
        // 月光弹射=0，避免黄昏背光向「朝月面接触缝喷蓝光」(用户实测，关 VOXEL_MOON_STRENGTH 即消失)。
        // 太阳沉到 -0.1 以下才开始渐起，-0.25 以下(纯黑夜)满强度。白天与薄暮都无月光反弹。
        float moonAmt = smoothstep(-0.10, -0.25, worldSunDir.y);
        if (worldId != -1 && moonAmt > 0.0) {  // 下界无月光
            vec3 moonDir = -worldSunDir;
            float moonLighting = saturate(dot(moonDir, hitNormal));
            contrib += alb * vec3(0.30, 0.42, 0.85)
                     * moonLighting * moonAmt * sunVis * VOXEL_MOON_STRENGTH * absorption;
        }
        // [DEBUG] 复现"特定视角阳光/月光反弹消失"用：解除下行注释后 F3+R。
        // 三通道定位：R = sunVis(shadow map 遮挡判定，0=采样失败)；
        // G = 命中面朝向太阳(saturate(dot(sunDir,hitNormal)))；
        // B = lightmap 门控(saturate(max(hitSkylight,skyLightmap)*444))。
        // 到"反弹消失"的视角看各自变哪个通道变黑。
        // #define DEBUG_SUNBOUNCE_VIS
        #if defined DEBUG_SUNBOUNCE_VIS
        return vec3(max(max(sunVis.r, sunVis.g), sunVis.b),
                    saturate(dot(sunDir, hitNormal)),
                    saturate(max(hitSkylight, skyLightmap) * 444.0));
        #endif
        // 间接光：命中体素处的 IRC 前帧缓存（相机重投影 +cDi，与注入端同款）
        // 三线性平滑读取（消除 1m 体素块状/表面冲突）。DISABLE_IRC 时不做自反弹。
        #ifndef DISABLE_IRC
        ivec3 ircHit = vc + (cameraPositionInt - previousCameraPositionInt);
        if (all(greaterThanEqual(ircHit, ivec3(0))) && all(lessThan(ircHit, ivec3(VOXEL_AREA)))) {
            contrib += alb * FetchVoxelRadianceTrilinear(ircHit) * VOXEL_GI_SELF_BOUNCE * absorption;
        } else {
            // [2026-08-19 恢复] IRC 查询越界（新暴露/网格边缘）时按命中法线补解析下限，避免越界黑死。
            contrib += alb * SimpleSkyLighting(skyColor, sunIrradiance * rcp(max(luminance(sunIrradiance), 1e-4)),
                                               hitNormal.y, hitSkylight) * VOXEL_GI_SELF_BOUNCE * absorption;
        }
        #endif
        return contrib * weight;
    }

    // 出界（网格外且朝上）→ 天光 + 像素自身方块光底（
    // SkyLighting + BlockLighting(lightmap.x) + NOLIGHT）：
    // - 天空 × sat(skyLightmap*4.44)（SUNLIGHT_LEAK_FIX 阈值 0.23，与注入端同口径）
    // - blocklight 底 = 像素自己 lightmap 的方块光（光线出界不丢失光源信息）
    // - NOLIGHT 兜底：出界路径专有（NOLIGHT_BRIGHTNESS * saturate(rayLength*0.2)）
    // 射程用尽：仅返回发射光球形累积 + 底光。主底光仍由 IRC 阳光扩散提供。
    // [FIX 2026-08-18 阴影死黑根因] 循环自然结束（24 步走完仍无命中）= 射程用尽，
    // 视线一路畅通通向天空 → 走出界路径。此前只有"真越界"或"rayLength 严格 > 24"
    // 才置 exitGrid：纯向上射线每步恰好 1 格，第 24 步 rayLength == 24 不触发 `>`，
    // 斜方向射线每步距离可能 <1，累计更到不了 24 → 开阔阴影（正上方就是天空）的
    // 射线走满后 exitGrid 仍 false → 天光路径被跳过，只剩微弱 NOLIGHT → "阴影黑洞洞"；
    // 只有网格边缘（射线几步内真越界）才出界 → DEBUG_VOXEL_SKY"体素范围边缘才发红"。
    // 命中路径提前 return，走到这里必然未命中 → 无条件视为出界。
    {
        // 出界 → 方向天空光 + NOLIGHT 兜底：skyMapTex 方向辐射（内含地平线衰减
        // 与线性漏光门控）。洞穴（skyLightmap≈0）无天光，半遮挡按比例保留。
        // [2026-08-20] 下界（worldId == -1）无天空：屏蔽出界天光
        // [2026-08-21 门控开关] VOXEL_TRACE_SKY_GATE：0=只有出界判定（gate 全开，
        // 不乘 lightmap 漏光门控，只要出界就按方向天光）；1=出界+原版光照（现状，
        // 传 skyLightmap 让 VoxelSkyLeakGate 按 lightmap 衰减洞穴/半遮挡）。
        if (worldId != -1) {
            #if VOXEL_TRACE_SKY_GATE == 0
                contrib += VoxelSkyColor(dir, 1.0) * VOXEL_GI_TRACE_SKY_STRENGTH * absorption;
            #else
                contrib += VoxelSkyColor(dir, skyLightmap) * VOXEL_GI_TRACE_SKY_STRENGTH * absorption;
            #endif
        }
        // [2026-08-09] 出界不再返回原版方块光底光：光追开启时体素网格内的原版方块光
        // （lightmap 光晕）应被屏蔽，由体素 GI 的方块光（命中/IRC 注入，lD.y 驱动）
        // 接管。保留此项会把 DeferredLight 已屏蔽的原版方块光又加回来（火把光晕
        // 双倍/未屏蔽）。"体素外以非光追样式渲染"由 DeferredLight 的 lightmap.x
        // 路径负责，与此处无关。
        // contrib += blocklightColor * blockLightmap * VOXEL_GI_BLOCK_STRENGTH * absorption;
    }
    contrib += vec3(0.97, 0.99, 1.18) * VOXEL_NOLIGHT_BRIGHTNESS * saturate(rayLength * 0.2) * absorption;
    return contrib * weight;
}
