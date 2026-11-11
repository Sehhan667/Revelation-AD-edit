const ivec2 offset2x2[4] = ivec2[4](
	ivec2(0, 0), ivec2(1, 0),
	ivec2(0, 1), ivec2(1, 1)
);

const ivec2 offset3x3[9] = ivec2[9](
    ivec2(-1, -1), ivec2(0, -1), ivec2(1, -1),
    ivec2(-1,  0), ivec2(0,  0), ivec2(1,  0),
    ivec2(-1,  1), ivec2(0,  1), ivec2(1,  1)
);

const ivec2 offset3x3N[8] = ivec2[8](
    ivec2(-1, -1), ivec2(0, -1), ivec2(1, -1),
    ivec2(-1,  0), 				 ivec2(1,  0),
    ivec2(-1,  1), ivec2(0,  1), ivec2(1,  1)
);

const ivec2 offset4x4[16] = ivec2[16](
	ivec2(-2, -2), ivec2(-1, -2), ivec2(1, -2), ivec2(2, -2),
	ivec2(-2, -1), ivec2(-1, -1), ivec2(1, -1), ivec2(2, -1),
	ivec2(-2,  1), ivec2(-1,  1), ivec2(1,  1), ivec2(2,  1),
	ivec2(-2,  2), ivec2(-1,  2), ivec2(1,  2), ivec2(2,  2)
);

const ivec2 offset5x5[25] = ivec2[25](
	ivec2(-2, -2), ivec2(-1, -2), ivec2(0, -2), ivec2(1, -2), ivec2(2, -2),
	ivec2(-2, -1), ivec2(-1, -1), ivec2(0, -1), ivec2(1, -1), ivec2(2, -1),
	ivec2(-2,  0), ivec2(-1,  0), ivec2(0,  0), ivec2(1,  0), ivec2(2,  0),
	ivec2(-2,  1), ivec2(-1,  1), ivec2(0,  1), ivec2(1,  1), ivec2(2,  1),
	ivec2(-2,  2), ivec2(-1,  2), ivec2(0,  2), ivec2(1,  2), ivec2(2,  2)
);

const ivec2 offset5x5N[24] = ivec2[24](
	ivec2(-2, -2), ivec2(-1, -2), ivec2(0, -2), ivec2(1, -2), ivec2(2, -2),
	ivec2(-2, -1), ivec2(-1, -1), ivec2(0, -1), ivec2(1, -1), ivec2(2, -1),
	ivec2(-2,  0), ivec2(-1,  0), 				ivec2(1,  0), ivec2(2,  0),
	ivec2(-2,  1), ivec2(-1,  1), ivec2(0,  1), ivec2(1,  1), ivec2(2,  1),
	ivec2(-2,  2), ivec2(-1,  2), ivec2(0,  2), ivec2(1,  2), ivec2(2,  2)
);

const ivec2 offset7x7[49] = ivec2[49](
	ivec2(-3, -3), ivec2(-2, -3), ivec2(-1, -3), ivec2(0, -3), ivec2(1, -3), ivec2(2, -3), ivec2(3, -3),
	ivec2(-3, -2), ivec2(-2, -2), ivec2(-1, -2), ivec2(0, -2), ivec2(1, -2), ivec2(2, -2), ivec2(3, -2),
	ivec2(-3, -1), ivec2(-2, -1), ivec2(-1, -1), ivec2(0, -1), ivec2(1, -1), ivec2(2, -1), ivec2(3, -1),
	ivec2(-3,  0), ivec2(-2,  0), ivec2(-1,  0), ivec2(0,  0), ivec2(1,  0), ivec2(2,  0), ivec2(3,  0),
	ivec2(-3,  1), ivec2(-2,  1), ivec2(-1,  1), ivec2(0,  1), ivec2(1,  1), ivec2(2,  1), ivec2(3,  1),
	ivec2(-3,  2), ivec2(-2,  2), ivec2(-1,  2), ivec2(0,  2), ivec2(1,  2), ivec2(2,  2), ivec2(3,  2),
	ivec2(-3,  3), ivec2(-2,  3), ivec2(-1,  3), ivec2(0,  3), ivec2(1,  3), ivec2(2,  3), ivec2(3,  3)
);

const ivec2 checkerboardOffset2x2[4] = ivec2[4](
	ivec2(0, 0), ivec2(1, 1),
	ivec2(1, 0), ivec2(0, 1)
);

// 半分辨率 GI 画布在 2x2 屏幕块内的采样相位。
// 官方 README（quarter-resolution denoising）明确建议用固定的 pixelPos/2，
// 不要逐帧在 2x2 里轮转：rotated grid 会显著提高 non-noisy 输入的熵、增加
// disocclusion（实测表现为轮廓/台阶/草叶处历史判据周期性失配、边缘 GI 四帧一循环地闪）。
#define GI_CANVAS_PHASE ivec2(0)

const ivec2 checkerboardOffset3x3[9] = ivec2[9](
	ivec2(0, 0), ivec2(2, 0), ivec2(0, 2),
	ivec2(2, 2), ivec2(1, 1), ivec2(1, 0),
	ivec2(1, 2), ivec2(0, 1), ivec2(2, 1)
);

const ivec2 checkerboardOffset4x4[16] = ivec2[16](
	ivec2(0, 0), ivec2(2, 0), ivec2(0, 2), ivec2(2, 2),
	ivec2(1, 1), ivec2(3, 1), ivec2(1, 3), ivec2(3, 3),
	ivec2(1, 0), ivec2(3, 0), ivec2(1, 2), ivec2(3, 2),
	ivec2(0, 1), ivec2(2, 1), ivec2(0, 3), ivec2(2, 3)
);