// Scrolling chevrons pointing at the host, tinted per lane.
shader_type spatial;
render_mode unshaded, blend_add, depth_draw_never, cull_disabled;

uniform vec3 tint : source_color = vec3(1.0);
uniform float strength = 0.35;

void fragment() {
	vec2 uv = vec2(UV.x, UV.y * 17.0 - TIME * 0.6);
	float y = fract(uv.y);
	float x = abs(uv.x - 0.5) * 2.0;
	float chevron = smoothstep(0.08, 0.0, abs(y - 0.45 - x * 0.25));
	ALBEDO = tint * chevron * strength;
}
