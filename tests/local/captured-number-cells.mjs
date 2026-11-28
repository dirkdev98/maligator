// Captured lets that only ever hold Numbers, next to cells that break that shape.
const results = [];
const show = (value) =>
	Array.isArray(value)
		? value.map(show)
		: typeof value === "bigint"
			? `${value}n`
			: Object.is(value, -0)
				? "-0"
				: typeof value === "number" && !Number.isFinite(value)
					? String(value)
					: value;
const record = (label, value) => results.push([label, show(value)]);

function dispatch(request, stack) {
	let index = 0;
	let depth = 0;
	request.next = next;
	next();
	function next() {
		if (index >= stack.length) return;
		if (++depth > 100) return;
		while (index < stack.length) {
			const layer = stack[index++];
			layer(request);
		}
		depth = 0;
	}
	return () => [index, depth];
}
const requests = [];
let state;
for (let round = 0; round < 3; round++) {
	const request = { seen: 0 };
	state = dispatch(request, [
		(r) => {
			r.seen++;
			requests.push(r);
		},
		(r) => {
			r.seen += 10;
		},
	]);
}
for (const request of requests) request.next();
record("dispatch", [requests.map((r) => r.seen), state()]);

function poisoned() {
	let count = 0;
	const bump = () => count++;
	const poison = () => {
		count = "text";
	};
	bump();
	bump();
	const before = count;
	poison();
	return [before, bump(), count];
}
record("poisoned", poisoned());

function overflow() {
	let high = 2147483645;
	let low = -2147483647;
	const up = () => ++high;
	const down = () => --low;
	const seen = [];
	for (let i = 0; i < 4; i++) seen.push(up(), down());
	return seen;
}
record("overflow", overflow());

function temporalDeadZone() {
	const read = () => value + 1;
	const bump = () => ++value;
	const caught = [];
	for (const action of [read, bump])
		try {
			action();
		} catch (error) {
			caught.push(error.constructor.name);
		}
	let value = 1;
	return [caught, read(), bump(), value];
}
record("tdz", temporalDeadZone());

function createdAfterWrite() {
	let total = 5;
	total++;
	total *= 3;
	const add = (amount) => (total += amount);
	const twice = () => ++total * 2;
	add(4);
	return [twice(), total];
}
record("after-write", createdAfterWrite());

function lengths(items) {
	let cursor = 0;
	let saved = 0;
	const step = () => {
		while (cursor < items.length) cursor++;
		return cursor;
	};
	const save = (source) => {
		saved = source.length;
		return saved + 1;
	};
	return [step(), save(items), save({ length: "abc" }), saved];
}
record("lengths", lengths([1, 2, 3, 4]));

function bigint() {
	let value = 0;
	const widen = () => {
		value = 10n;
	};
	const bump = () => ++value;
	bump();
	widen();
	return [bump(), value];
}
record("bigint", bigint());

function negativeZero() {
	let zero = 0;
	const flip = () => (zero = -zero);
	flip();
	return [zero, 1 / zero, flip(), 1 / zero];
}
record("negative-zero", negativeZero());

// Escaping closures keep their cells, so each update reads and stores a boxed Number.
function makeUpdates() {
	let zero = -0;
	let below = -1;
	let one = 1;
	let fraction = -1.5;
	let missing = 0 / 0;
	let huge = 1 / 0;
	let high = 2147483646;
	let low = -2147483647;
	return {
		post: () => ({ zero: zero++, missing: missing--, high: high++, low: low-- }),
		pre: () => ({ below: ++below, one: --one, fraction: ++fraction, huge: --huge }),
		read: () => [zero, below, one, fraction, missing, huge, high, low],
	};
}
const updates = makeUpdates();
const updateResults = [];
for (let round = 0; round < 3; round++)
	updateResults.push(Object.values(updates.post()), Object.values(updates.pre()));
record("update-inputs", [updateResults, updates.read()]);

function loopCells() {
	const counters = [];
	for (let i = 0; i < 3; i++) counters.push(() => i++);
	return counters.map((counter) => [counter(), counter()]);
}
record("loop-cells", loopCells());

function allocating() {
	let hits = 0;
	let sum = 0;
	const keep = [];
	const visit = (item) => {
		hits++;
		sum += item.weight;
		keep.push({ hits, label: `item-${hits}` });
		if (keep.length > 64) keep.length = 0;
	};
	for (let round = 0; round < 2000; round++) visit({ weight: round % 7 });
	return [hits, sum, keep.length, keep[keep.length - 1]?.label];
}
record("allocating", allocating());

console.log(JSON.stringify(results));
