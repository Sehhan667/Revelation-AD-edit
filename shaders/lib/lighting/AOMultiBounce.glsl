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
--------------------------------------------------------------------------------
    Multi-bounce AO approximation (Jimenez et al. 2016)

    Volume-scattering cubic fit: f(ao) = max(ao, c*ao^3 - b*ao^2 + a*ao),
    with a/b/c mapped from the material albedo. Compensates single-scatter AO
    values with an approximate energy-bounce term.

    [2026-09-02] Hosted as a standalone shared file so it stays available no
    matter which AO implementation (SSAO or GTAO) is compiled in DeferredLight.
--------------------------------------------------------------------------------
*/

vec3 ApproxMultiBounce(in float ao, in vec3 albedo) {
	vec3 a = 2.0404 * albedo - 0.3324;
	vec3 b = 4.7951 * albedo - 0.6417;
	vec3 c = 2.7552 * albedo + 0.6903;

	return max(vec3(ao), ((ao * a - b) * ao + c) * ao);
}