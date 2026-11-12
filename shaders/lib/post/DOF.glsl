/*
--------------------------------------------------------------------------------

	Revelation Shaders

	Copyright (C) 2026 HaringPro
	Apache License 2.0

	Added for Revelation-AD-edit - a derivative of Revelation, Apache-2.0.
	Copyright 2026 AnotherCream.






	Ported from vanilla Revelation (Revelation-dev) 2026-09-11.
	适配说明：本包没有 RENDER_SCALE 渲染缩放体系（见 MEMO SVGF 分辨率缩放一节），
	原版 scaledViewSize 在此替换为全分辨率 viewSize；其余逻辑与原版一致。
	场景色 colortex0 在 TAA 开启时为 YCoCg 编码——模糊是线性加权平均，
	blur(YCoCg) == YCoCg(blur)，因此无需转换颜色空间，TAA 读到的仍是 YCoCg。

--------------------------------------------------------------------------------
*/

const float DOF_SENSOR_WIDTH = 0.036;
const float dofFocalLength = DOF_FOCAL_LENGTH * 0.001;
const float dofApertureRadius = 0.5 * dofFocalLength / DOF_F_STOP;
const vec2 dofPairRotation = vec2(-0.3623748901, 0.9320324238);
const float dofPairPhase = 0.3090169944;

const float dofHexCircumradius = 1.099636111;
const vec2 dofHexVertices[7] = vec2[7](
    vec2(1.0, 0.0),
    vec2(0.5, 0.8660254),
    vec2(-0.5, 0.8660254),
    vec2(-1.0, 0.0),
    vec2(-0.5, -0.8660254),
    vec2(0.5, -0.8660254),
    vec2(1.0, 0.0)
);

float DofCoCScale(float focusDepth) {
	float focusRange = maxEps(focusDepth - dofFocalLength);
	return dofApertureRadius * dofFocalLength * viewSize.x * rcp(DOF_SENSOR_WIDTH * focusRange);
}

float DofCoCRadius(float viewDepth, float focusDepth, float cocScale, float maxBlurRadius) {
	float texelRadius = cocScale * (viewDepth - focusDepth) / maxEps(viewDepth);
	return clamp(texelRadius, -maxBlurRadius, maxBlurRadius);
}

vec2 DofRotatePair(vec2 direction) {
	return vec2(
		direction.x * dofPairRotation.x - direction.y * dofPairRotation.y,
		direction.x * dofPairRotation.y + direction.y * dofPairRotation.x
	);
}

vec2 DofApertureOffset(vec2 direction, float aperturePhase, float radius) {
	#if DOF_APERTURE_SHAPE == 1
		float edgePos = fract(aperturePhase) * 6.0;
		int edgeIndex = min(int(edgePos), 5);
		vec2 boundary = mix(dofHexVertices[edgeIndex], dofHexVertices[edgeIndex + 1], fract(edgePos));
		return boundary * (radius * dofHexCircumradius);
	#else
		return direction * radius;
	#endif
}

#ifdef DOF_APERTURE_VIGNETTING
	// 口径蚀（cat's eye）：离画面中心越远，出瞳在径向被遮挡越多，切向不受影响。
	// 只能让采样核围绕像素自身沿径向收缩，不能整体平移：旧实现里的
	// (radialOffset + kernelRadius) 会给每个采样点叠加 kernelRadius 倍的平移，
	// 离轴像素采到的是朝画面中心偏移的邻域，导致除屏幕正中外整屏发糊并抖出噪点。
	vec3 DofApertureVignettingPrepare(vec2 centerUv) {
		vec2 centerPos = centerUv - 0.5;
		float centerRadiusSq = sdot(centerPos);
		float centerRadiusInv = inversesqrt(maxEps(centerRadiusSq));
		// 1.2 * tan(fovY/2)：同样屏幕半径下视场越大离轴角越大，遮挡越强；上限 0.6 保证径向跨度不低于 40%
		float compression = min(centerRadiusSq * centerRadiusInv * 1.2 * gbufferProjectionInverse[1].y, 0.6);
		return vec3(centerPos * centerRadiusInv, compression);
	}

	void DofApertureVignettingApply(inout vec2 sampleOffset, vec3 vignettingData) {
		float radialOffset = dot(sampleOffset, vignettingData.xy);
		sampleOffset -= vignettingData.xy * (radialOffset * vignettingData.z);
	}
#endif

float DofApertureCoverage(float cocRadius, float sampleDistance, float maxBlurRadius) {
	return saturate((cocRadius - sampleDistance) * maxBlurRadius + 0.5);
}

vec2 DofMirrorUv(vec2 uv) {
	uv = max(uv, -uv);
	uv = min(uv, 2.0 - uv);
	return saturate(uv);
}

float DofVogelRadius(uint sampleIndex, float radialPhase, float inverseSampleCount) {
	float radiusSq = float(sampleIndex) * inverseSampleCount + radialPhase;
	return radiusSq * inversesqrt(maxEps(radiusSq));
}
