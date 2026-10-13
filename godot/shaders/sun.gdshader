// Striped synthwave sun behind the gate.
shader_type spatial;
render_mode unshaded, blend_mix, depth_draw_never, fog_disabled;

void fragment() {
	vec2 c = UV - 0.5;
	if (length(c) > 0.5) discard;
	float v = 1.0 - UV.y;
	vec3 col = mix(vec3(1.0, 0.1, 0.55), vec3(1.0, 0.75, 0.25), v);
	float stripe = step(0.5, fract(v * 14.0 + TIME * 0.15)) + step(0.55, v);
	ALBEDO = col * 0.55;
	ALPHA = clamp(stripe, 0.0, 1.0) * 0.4;
}
