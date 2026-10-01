import { runRuntimeGapCase } from "../case-runner.mjs";

function subtract(left, right) {
	return this.bias + left * 3 - right;
}
function multiply(left, right) {
	return this.bias + left * right;
}

function run(scale) {
	const operations = 2000 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const receiver = { bias: round & 31 };
		const left = round & 15;
		const right = (round & 7) + 1;
		const target = (round & 1) === 0 ? subtract : multiply;
		const called = target.call(receiver, left, right);
		const applied = target.apply(receiver, [left, right]);
		const bound = target.bind(receiver, left);
		const boundResult = bound(right);
		const expected =
			receiver.bias + ((round & 1) === 0 ? left * 3 - right : left * right);
		const source = target.toString();
		const boundSource = bound.toString();
		if (called !== expected || applied !== expected || boundResult !== expected)
			throw new Error("function adapter mismatch");
		if (
			typeof source !== "string" ||
			source.length === 0 ||
			typeof boundSource !== "string" ||
			boundSource.length === 0
		)
			throw new Error("invalid function source text");
		checksum += called + applied + boundResult + 2;
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-function-adapters", run);
