// Modified for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
// Modified by AnotherCream, 2026.





vec3 ScreenToViewPosRaw(vec3 screenPos) {
    vec3 ndcPos = screenPos * 2.0 - 1.0;
    return ProjectDivide(gbufferProjectionInverse, ndcPos);  // 注意参数顺序
}

vec3 ScreenToViewPos(vec3 screenPos) {
    vec3 ndcPos = screenPos * 2.0 - 1.0;
    #ifdef TAA_ENABLED
        ndcPos.xy -= taaJitterScaled;
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
        ndcPos -= taaJitterScaled;
    #endif
    return vec3(diagonal2(gbufferProjectionInverse) * ndcPos * -viewDepth, viewDepth);
}

vec3 ScreenToViewPos(vec2 screenPos) {
    vec3 ndcPos = vec3(screenPos, loadDepth0(uvToTexel(screenPos))) * 2.0 - 1.0;
    #ifdef TAA_ENABLED
        ndcPos.xy -= taaJitterScaled;
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
        ndcPos.xy += taaJitterScaled;
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
        ndcPos -= taaJitterScaled;
    #endif
    return normalize(vec3(diagonal2(gbufferProjectionInverse) * ndcPos, gbufferProjectionInverse[3].z));
}

// 手部像素判定：Iris 的手部投影在 clip 空间把 z 压缩 MC_HAND_DEPTH 倍，把手放到世界深度之前。
//   Iris <= 1.11（mc 1.21.11）: clip'.z = 0.125 * clip.z             → depth ∈ [0.4375, 0.5625]
//   Iris 1.12（mc 26.3）      : clip'.z = 0.125 * clip.z + 0.4375 * w → depth ∈ [0.65625, 0.78125]
// 第二段的 0.4375*w 来自 Iris 1.12 的 HandRenderer（.m22(0.125f).m32(0.4375f)），
// MC_HAND_DEPTH 只暴露 0.125，所以只能按区间认。
bool IsHandScreenDepth(float depth) {
    return depth < 0.5625 || (depth > 0.656 && depth < 0.782);
}

// 把压缩 depth 还原成真实 screen depth（两代 affine，旧区间与改动前逐位一致）。
float UncompressHandDepth(float depth) {
    float invHandDepth = 1.0 / MC_HAND_DEPTH;                       // 8.0
    float offset = 0.5 - 0.5 * invHandDepth;                        // -3.5（旧版截距）
    if (depth > 0.5625) offset -= 0.21875 * invHandDepth;           // -5.25（26.3）
    return depth * invHandDepth + offset;
}

vec3 ReprojectScreenPos(vec3 screenPos) {
    vec3 position = ScreenToViewPosRaw(screenPos);
    position = transMAD(gbufferModelViewInverse, position);
    position += cameraMovement * step(0.56, screenPos.z);
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
            ndcPos.xy -= taaJitterScaled;
        #endif
        return ProjectDivide(lodProjectionInv, ndcPos);
    }

    vec3 ScreenToViewPosLod(vec2 screenPos) {
        vec3 ndcPos = vec3(screenPos, loadDepth0Lod(uvToTexel(screenPos))) * 2.0 - 1.0;
        #ifdef TAA_ENABLED
            ndcPos.xy -= taaJitterScaled;
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
            ndcPos.xy += taaJitterScaled;
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

