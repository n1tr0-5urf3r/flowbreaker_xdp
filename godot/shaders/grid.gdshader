// Neon floor grid, faded with distance from the middle of the board.
shader_type spatial;
render_mode unshaded;

uniform vec3 line_color : source_color = vec3(0.16, 0.36, 1.0);
uniform vec2 center = vec2(0.0, -40.0);
uniform float fade_k = 0.018;
varying vec3 wpos;

void vertex() {
	wpos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

float grid(vec2 p, float w) {
	vec2 d = abs(fract(p - 0.5) - 0.5) / fwidth(p);
	return 1.0 - min(min(d.x, d.y) / w, 1.0);
}

void fragment() {
	float fine = grid(wpos.xz / 2.1, 1.0);
	float coarse = grid(wpos.xz / 10.5, 1.4);
	float fade = exp(-length(wpos.xz - center) * fade_k);
	float pulse = 0.5 + 0.5 * sin(wpos.z * 0.15 + TIME * 2.0);
	ALBEDO = vec3(0.006, 0.007, 0.02) + line_color * (fine * 0.25 + coarse * (0.6 + 0.35 * pulse)) * fade * 1.6;
}
