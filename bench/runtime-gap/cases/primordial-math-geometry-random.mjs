import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 3000 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const angle = ((round & 31) - 16) / 16;
		const length = (round & 15) + 1;
		const sine = Math.sin(angle);
		const cosine = Math.cos(angle);
		const recovered = Math.atan2(sine, cosine);
		const distance = Math.hypot(length * 3, length * 4);
		const random = Math.random();
		if (
			!Number.isFinite(sine) ||
			!Number.isFinite(cosine) ||
			!Number.isFinite(recovered) ||
			!Number.isFinite(distance) ||
			Math.abs(sine * sine + cosine * cosine - 1) > 1e-12 ||
			Math.abs(recovered - angle) > 1e-12 ||
			Math.abs(distance - length * 5) > 1e-12
		)
			throw new Error("geometry mismatch");
		if (!Number.isFinite(random) || random < 0 || random >= 1)
			throw new Error("random range mismatch");
		checksum += Math.round((sine + cosine + recovered + distance) * 10000) + 1;
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-math-geometry-random", run);
