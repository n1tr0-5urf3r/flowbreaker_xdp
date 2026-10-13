// Additive glow for particles: colour comes from the particle (vertex colour).
shader_type spatial;
render_mode unshaded, blend_add, depth_draw_never;

uniform float boost = 4.0;

void fragment() {
	ALBEDO = COLOR.rgb * boost * COLOR.a;
}
