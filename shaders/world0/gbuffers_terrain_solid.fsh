#version 460 compatibility

// [2026-11-28 early-Z] 实心方块专用入口：定义 TERRAIN_SOLID 后，Terrain.frag 里一处 discard
// 都没有 ⇒ 驱动可以在着色前做 early-Z，把被遮挡的片元直接丢掉。
// 抓帧实测地形 pass 81% 的片元是「被深度拒绝却仍跑完着色器」，这一项正是为它们省掉的。
// Iris 的 ProgramId 里 TerrainSolid（gbuffers_terrain_solid）在 1.10.8 与 1.12 都存在；
// 缺文件时自动回落到 gbuffers_terrain ⇒ 纯增量、删掉即回退。
// 树叶/草/藤蔓等切边方块走 cutout 层，仍回落 gbuffers_terrain（保留 alpha test）。
#define TERRAIN_SOLID

#include "/program/gbuffers/Terrain.frag"
