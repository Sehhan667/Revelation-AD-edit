// Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
// Modified by AnotherCream, 2026.





vec3 ScreenToViewPosRaw(vec3 screenPos) {
    vec3 ndcPos = screenPos * 2.0 - 1.0;
    return ProjectDivide(gbufferProjectionInverse, ndcPos);  // 注意参数顺序
}

vec3 ScreenToViewPos(vec3 screenPos) {
    vec3 ndcPos = screenPos * 2.0 - 1.0;
    #ifdef TAA_ENABLED
        ndcPos.xy -= taaJitter;
    #endif
    return ProjectDivide(gbufferProjectionInverse, ndcPos);
}

vec3 ScreenToViewPosRaw(vec2 screenPos, float viewDepth) {
    vec2 ndcPos = screenPos * 2.0 - 1.0;
    return vec3(diagonal2(gbufferProjectionInverse) * ndcPos * -viewDepth, viewDepth);
}

vec3 ScreenToViewPos(vec2 screenPos, float viewDepth) {
    vec2 ndcPos = screenPos * 2.0 - 1.0;
    #ifdef TAA_ENABLED
        ndcPos -= taaJitter;
    #endif
    return vec3(diagonal2(gbufferProjectionInverse) * ndcPos * -viewDepth, viewDepth);
}

vec3 ScreenToViewPos(vec2 screenPos) {
    vec3 ndcPos = vec3(screenPos, loadDepth0(uvToTexel(screenPos))) * 2.0 - 1.0;
    #ifdef TAA_ENABLED
        ndcPos.xy -= taaJitter;
    #endif
    return ProjectDivide(gbufferProjectionInverse, ndcPos);
}

vec3 ViewToScreenPosRaw(vec3 viewPos) {
    vec3 ndcPos = projMAD(gbufferProjection, viewPos) * rcp(-viewPos.z);
    return ndcPos * 0.5 + 0.5;
}

vec3 ViewToScreenPos(vec3 viewPos) {
    vec3 ndcPos = projMAD(gbufferProjection, viewPos) * rcp(-viewPos.z);
    #ifdef TAA_ENABLED
        ndcPos.xy += taaJitter;
    #endif
    return ndcPos * 0.5 + 0.5;
}

vec3 ScreenToViewDirRaw(vec2 screenPos) {
    vec2 ndcPos = screenPos * 2.0 - 1.0;
    return normalize(vec3(diagonal2(gbufferProjectionInverse) * ndcPos, gbufferProjectionInverse[3].z));
}

vec3 ScreenToViewDir(vec2 screenPos) {
    vec2 ndcPos = screenPos * 2.0 - 1.0;
    #ifdef TAA_ENABLED
        ndcPos -= taaJitter;
    #endif
    return normalize(vec3(diagonal2(gbufferProjectionInverse) * ndcPos, gbufferProjectionInverse[3].z));
}

// 手部像素判定（只看 raw depth）。
// Iris 的手部投影在 clip 空间把 z 压缩 MC_HAND_DEPTH 倍，让手躺在世界深度之前：
//   Iris <= 1.11（mc 1.21.11）: clip'.z = 0.125 * clip.z            → depth ∈ [0.4375, 0.5625]
//   Iris 1.12（mc 26.3）      : clip'.z = 0.125 * clip.z + 0.4375 * w → depth ∈ [0.65625, 0.78125]
// 第二段多出来的 0.4375*w 来自 26.3 的 HandRenderer（.m22(0.125f).m32(0.4375f)），
// Iris 只把 0.125 暴露成 MC_HAND_DEPTH，偏移量没有宏 ⇒ 只能按区间认，不能只比 0.56。
// 两段不重叠；"<0.5625" 与历史行为一致，"0.656..0.781" 是 26.3 的新区间。
bool IsHandScreenDepth(float depth) {
    return depth < 0.5625 || (depth > 0.656 && depth < 0.782);
}

// 把手的压缩 depth 还原成真实 screen depth。
// 两代 Iris 的手部投影都是 affine，只是截距不同（见上）：
//   旧（mc1.21.11 / Iris <=1.11）: s = d/MC_HAND_DEPTH + (0.5 - 0.5/MC_HAND_DEPTH)      = 8d - 3.5
//   新（mc26.3    / Iris 1.12）  : 上面再多减 0.5 * 0.4375 / MC_HAND_DEPTH（clip 里的平移） = 8d - 5.25
// 两段深度区间不重叠，所以按区间选截距即可：1.21.11 走旧式（与改动前逐位一致），26.3 走新式。
// 不要再写成固定采样平面 —— 手自身的深度变化（手指前后、挥动）在原版是真实参与光照的。
float UncompressHandDepth(float depth) {
    float invHandDepth = 1.0 / MC_HAND_DEPTH;                       // 8.0
    float offset = 0.5 - 0.5 * invHandDepth;                        // -3.5（旧版的截距）
    if (depth > 0.5625) offset -= 0.21875 * invHandDepth;           // -3.5 - 1.75 = -5.25（26.3）
    return depth * invHandDepth + offset;
}

// 把手部像素的 raw screen depth 换成真实值；非手部原样返回。
// 反投影/重投影/时域判据都必须用这个，不能直接把 raw depth 丢进 gbufferProjectionInverse：
// 手的 depth 是压缩编码，直接反投影会落到相机后方（26.3 更明显），
// 于是 TAA / GI 的历史坐标全错 —— 表现就是「静止正常、一播动画就闪」。
float RealScreenDepth(float depth) {
    return IsHandScreenDepth(depth) ? clamp(UncompressHandDepth(depth), 0.0, 1.0) : depth;
}

// 手/手持模型的光照采样距离（米，相机前方）。
// 第一人称手**不是**世界几何：Iris 给它独立投影（hudFov + 压缩深度），26.3 起还有独立的 walk bob
// （"the bob a pack reads is the one that placed the geometry and the hand's is not the frame's"）。
// 按它真实的世界坐标打光 ⇒ 采样点会让它在世界里随动画/走路扫过，跨阴影边界时手就忽明忽暗；
// mod 的第一人称枪械（Punchy/TaCZ 移植）动画幅度几十厘米，比原版手明显得多。
// 所以手的光照位置固定在相机前方：只随玩家位置/朝向变化，不随手的动画变化。
// 深度（screenPos.z）仍然用解压后的真实值 —— 那是给 TAA/DOF 用的，两者不要混。
#define HAND_LIGHT_DIST 0.5

vec3 ReprojectScreenPos(vec3 screenPos) {
    bool isHand = IsHandScreenDepth(screenPos.z);
    // 手部：先解压再反投影；非手部：原样。
    vec3 position = ScreenToViewPosRaw(vec3(screenPos.xy, RealScreenDepth(screenPos.z)));
    position = transMAD(gbufferModelViewInverse, position);
    // 手跟着相机走，重投影时不能叠加 cameraMovement（否则历史错位 → 手部 TAA 拖影/闪）。
    // 原来的 step(0.56, z) 在 26.3 上恒为 1（手 depth ≈0.77）⇒ 手一直被当成世界几何。
    position += cameraMovement * (isHand ? 0.0 : 1.0);
    position = transMAD(gbufferPreviousModelView, position);
    position = projMAD(gbufferPreviousProjection, position) * rcp(-position.z);
    return position * 0.5 + 0.5;
}

float ScreenToViewDepth(float depth) {
    return -gbufferProjection[3].z / (gbufferProjection[2].z + (depth * 2.0 - 1.0));
}

float ViewToScreenDepth(float depth) {
    return 0.5 - (gbufferProjection[3].z / depth + gbufferProjection[2].z) * 0.5;
}

// LOD_MOD 部分也做相应修改
#if defined LOD_MOD
    vec3 ScreenToViewPosRawLod(vec3 screenPos) {
        vec3 ndcPos = screenPos * 2.0 - 1.0;
        return ProjectDivide(lodProjectionInv, ndcPos);
    }

    vec3 ScreenToViewPosLod(vec3 screenPos) {
        vec3 ndcPos = screenPos * 2.0 - 1.0;
        #ifdef TAA_ENABLED
            ndcPos.xy -= taaJitter;
        #endif
        return ProjectDivide(lodProjectionInv, ndcPos);
    }

    vec3 ScreenToViewPosLod(vec2 screenPos) {
        vec3 ndcPos = vec3(screenPos, loadDepth0Lod(uvToTexel(screenPos))) * 2.0 - 1.0;
        #ifdef TAA_ENABLED
            ndcPos.xy -= taaJitter;
        #endif
        return ProjectDivide(lodProjectionInv, ndcPos);
    }

    vec3 ViewToScreenPosRawLod(vec3 viewPos) {
        vec3 ndcPos = projMAD(lodProjection, viewPos) * rcp(-viewPos.z);
        return ndcPos * 0.5 + 0.5;
    }

    vec3 ViewToScreenPosLod(vec3 viewPos) {
        vec3 ndcPos = projMAD(lodProjection, viewPos) * rcp(-viewPos.z);
        #ifdef TAA_ENABLED
            ndcPos.xy += taaJitter;
        #endif
        return ndcPos * 0.5 + 0.5;
    }

    vec3 ReprojectScreenPosLod(vec3 screenPos) {
        vec3 position = ScreenToViewPosRawLod(screenPos);
        position = transMAD(gbufferModelViewInverse, position);
        position += cameraMovement;
        position = transMAD(gbufferPreviousModelView, position);
        position = projMAD(lodPrevProjection, position) * rcp(-position.z);
        return position * 0.5 + 0.5;
    }

    float ScreenToViewDepthLod(float depth) {
        return -lodProjection[3].z / (lodProjection[2].z + (depth * 2.0 - 1.0));
    }

    float ViewToScreenDepthLod(float depth) {
        return 0.5 - (lodProjection[3].z / depth + lodProjection[2].z) * 0.5;
    }
#endif

