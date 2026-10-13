// The NIC·XDP gate: a scanline force field.
shader_type spatial;
render_mode unshaded, blend_add, depth_draw_never, cull_disabled;

void fragment() {
	float scan = 0.5 + 0.5 * sin(UV.y * 120.0 + TIME * 6.0);
	float bars = smoothstep(0.92, 1.0, abs(sin(UV.x * 60.0)));
	float edge = smoothstep(1.0, 0.75, UV.y) * (1.0 - smoothstep(0.3, 0.0, UV.y));
	ALBEDO = vec3(1.0, 0.2, 0.33) * 1.6 * (0.05 + 0.08 * scan + 0.12 * bars) * edge;
}
