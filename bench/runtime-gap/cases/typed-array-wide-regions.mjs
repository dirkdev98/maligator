import { runRuntimeGapCase } from "../case-runner.mjs";
function wide(a, b, c, d, e, f, g, output, count) {
	for (let index = 0; index < count; index++)
		output[index] =
			a[index] + b[index] + c[index] + d[index] + e[index] + f[index] + g[index];
}
function lanes(a, b, c, output, count) {
	for (let index = 0; index < count; index += 8) {
		output[index] = a[index] + b[index] + c[index];
		output[index + 1] = a[index + 1] + b[index + 1] + c[index + 1];
		output[index + 2] = a[index + 2] + b[index + 2] + c[index + 2];
		output[index + 3] = a[index + 3] + b[index + 3] + c[index + 3];
		output[index + 4] = a[index + 4] + b[index + 4] + c[index + 4];
		output[index + 5] = a[index + 5] + b[index + 5] + c[index + 5];
		output[index + 6] = a[index + 6] + b[index + 6] + c[index + 6];
		output[index + 7] = a[index + 7] + b[index + 7] + c[index + 7];
	}
}
function run(scale) {
	const a = new Float64Array(256),
		b = new Float64Array(256),
		c = new Float64Array(256),
		output = new Float64Array(256);
	for (let index = 0; index < 256; index++) {
		a[index] = (index & 31) - 7.5;
		b[index] = (index & 7) + 0.5;
		c[index] = index & 15;
	}
	let checksum = 0;
	const rounds = 5000 * scale;
	for (let index = 0; index < rounds; index++) {
		wide(a, b, c, a, b, c, a, output, 256);
		checksum = (checksum + output[index & 255] * 2) | 0;
		lanes(a, b, c, output, 256);
		checksum = (checksum + output[(index + 17) & 255] * 2) | 0;
	}
	return { checksum: checksum >>> 0, operations: rounds * 512 };
}
runRuntimeGapCase("typed-array-wide-regions", run);
