import { runRuntimeGapCase } from "../case-runner.mjs";

function Point(x, y) {
	this.x = x;
	this.y = y;
}

function score(weight) {
	return this.x * weight + this.y;
}

function run(scale) {
	const operations = 1800 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const x = round & 255;
		const y = (round * 3) & 127;
		const weight = (round & 7) + 1;
		const point = Reflect.construct(Point, [x, y]);
		const value = Reflect.apply(score, point, [weight]);
		if (value !== x * weight + y || point.x !== x)
			throw new Error("reflective call failed");
		checksum += value;
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-reflect-call-construction", run);
