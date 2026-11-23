function makeState(seed) {
	return { count: 0, next: 0, limit: seed, values: [seed], failures: [] };
}

function initialize(seed) {
	globalThis.observe = observe;
	globalThis.initialized = makeState(seed);
}

function step(state, index) {
	if (index % 3 === 2) throw new RangeError(String(index));
	state.count++;
	state.values.push(state.values[0] + index);
}

function observe(state) {
	return state.values.join(",");
}

initialize(Number(process.argv[2]));
while (globalThis.initialized.next < globalThis.initialized.limit) {
	const state = globalThis.initialized;
	const index = state.next++;
	try {
		step(state, index);
	} catch (error) {
		state.failures.push(error.message);
	}
}
const state = globalThis.initialized;
console.log(state.count, observe(state), state.failures.join(","));
