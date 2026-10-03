function unary(value) {
	return Math.abs(value);
}

function binary(left, right) {
	return Math.min(left, right);
}

export function exercise(context, variant, gate, values) {
	const ready = new Int32Array(gate);
	const originalAbs = Math.abs;
	const floor = Math.floor;
	const originalMin = Math.min;
	const max = Math.max;
	if (Atomics.add(ready, 0, 1) === 1) Atomics.notify(ready, 0, 1);
	const deadline = Date.now() + 10_000;
	while (Atomics.load(ready, 0) !== 2 && Date.now() < deadline)
		Atomics.wait(ready, 0, 1, 100);
	if (Atomics.load(ready, 0) !== 2) throw new Error("math workers did not overlap");

	let total = 0;
	for (let index = 0; index < 1024; index++) {
		context.throwIfCancelled();
		const alternate = (index + variant) % 2 === 1;
		const expectedAbs = alternate ? -3 : 2.75;
		const expectedMin = alternate ? 2.5 : -1.5;
		Math.abs = alternate ? floor : originalAbs;
		Math.min = alternate ? max : originalMin;
		if (Math.abs !== (alternate ? floor : originalAbs))
			throw new Error("worker Math.abs identity changed across isolates");
		if (Math.min !== (alternate ? max : originalMin))
			throw new Error("worker Math.min identity changed across isolates");
		const observedAbs = unary(values[0]);
		const observedMin = binary(values[1], values[2]);
		if (observedAbs !== expectedAbs || observedMin !== expectedMin)
			throw new Error("indirect Math call crossed isolate method identity");
		total += observedAbs + observedMin;
	}

	Math.abs = (value) => value * 10;
	Math.min = (left, right) => left + right;
	if (unary(values[0]) !== -27.5 || binary(values[1], values[2]) !== 1)
		throw new Error("patched Math method did not take the fallback");
	Math.abs = originalAbs;
	Math.min = originalMin;
	return total;
}
