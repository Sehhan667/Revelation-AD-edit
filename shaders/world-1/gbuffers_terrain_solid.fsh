#version 460 compatibility

// [2026-11-28 early-Z] 实心方块专用入口：定义 TERRAIN_SOLID 后，Terrain.frag 里一处 discard
// 都没有 ⇒ 驱动可以在着色前做 early-Z，把被遮挡的片元直接丢掉。
// Iris 的 ProgramId 里 TerrainSolid（gbuffers_terrain_solid）在 1.10.8 与 1.12 都存在；
// 缺文件时自动回落到 gbuffers_terrain ⇒ 纯增量、删掉即回退。
#define TERRAIN_SOLID

#include "/program/gbuffers/Terrain.frag"
