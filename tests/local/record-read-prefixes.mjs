function check(actual, expected, label) {
	if (!Object.is(actual, expected)) throw new Error(label);
}
function observe() {
	globalThis.gc?.();
}
const make = function make(value, hook) {
	for (let i = 0; i < 3; i++) hook();
	return { n: value & 255, label: "xx", payload: value };
};
function beforeEscape(value, flag, hook) {
	const record = flag ? make(value, observe) : make(value + 1, observe);
	const n = record.n;
	hook(record);
	return n % 10;
}
function beforeWrite(value, flag) {
	const left = make(value, observe);
	const right = make(value + 1, observe);
	const record = flag ? left : right;
	const n = record.n;
	record.n = "changed";
	return n % 10;
}
function branchEscape(value, flag, hook) {
	const record = flag ? make(value, observe) : make(value + 1, observe);
	if (value) {
		hook(record);
		return 0;
	}
	return record.n % 10;
}
function freshLoop(value, flag, hook) {
	let total = 0;
	for (let i = 0; i < 3; i++) {
		const record = flag ? make(value, observe) : make(value + 1, observe);
		const n = record.n;
		hook(record);
		total += n % 10;
	}
	return total;
}
function afterEscape(value, flag, hook) {
	const record = flag ? make(value, observe) : make(value + 1, observe);
	hook(record);
	return record.n;
}
function differentLifetime(value, flag, hook) {
	const left = make(value, observe);
	hook(left);
	const right = make(value + 1, observe);
	const record = flag ? left : right;
	return record.n;
}
function reusedLoop(value, flag, hook) {
	const record = flag ? make(value, observe) : make(value + 1, observe);
	let saved;
	for (let i = 0; i < 3; i++) {
		saved = record.n;
		hook(record);
	}
	return saved;
}
function beforeHeapEscape(value, flag, hook) {
	const record = flag ? make(value, observe) : make(value, observe);
	const saved = record.payload;
	hook(record);
	return saved;
}
function beforeStringEscape(value, flag, hook) {
	const record = flag ? make(value, observe) : make(value + 1, observe);
	const saved = record.label;
	hook(record);
	return saved + ":";
}
function* suspendedHeap(value, flag, hook) {
	const record = flag ? make(value, observe) : make(value, observe);
	const saved = record.payload;
	yield "pause";
	hook(record);
	return saved;
}
async function awaitedHeap(value, flag, hook) {
	const record = flag ? make(value, observe) : make(value, observe);
	const saved = record.payload;
	await 0;
	hook(record);
	return saved;
}
Object.assign(globalThis, {
	make,
	beforeEscape,
	beforeWrite,
	branchEscape,
	freshLoop,
	afterEscape,
	differentLifetime,
	reusedLoop,
	beforeHeapEscape,
	beforeStringEscape,
	suspendedHeap,
	awaitedHeap,
});
const pending = [];
for (const flag of [false, true]) {
	const mutate = (record) => {
		record.n = "changed";
		record.label = false;
		record.payload = null;
		observe();
	};
	for (const value of [-0, 0, 1, 255, 256, -1, 2147483648]) {
		const expected = ((flag ? value : value + 1) & 255) % 10;
		check(beforeEscape(value, flag, mutate), expected, "saved Number before escape");
		check(beforeWrite(value, flag), expected, "saved Number before own write");
		check(freshLoop(value, flag, mutate), expected * 3, "fresh lifetime on backedge");
		check(beforeStringEscape(value, flag, mutate), "xx:", "saved String before escape");
	}
	check(branchEscape(0, flag, mutate), flag ? 0 : 1, "unreached escape branch");
	check(branchEscape(1, flag, mutate), 0, "reached escape branch");
	check(afterEscape(3, flag, mutate), "changed", "prior escape invalidates field");
	check(
		differentLifetime(3, flag, mutate),
		flag ? "changed" : 4,
		"another allocation cannot reset an older lifetime",
	);
	check(reusedLoop(3, flag, mutate), "changed", "reused lifetime on backedge");
	for (const value of [{ marker: "heap".repeat(100) }, "payload".repeat(100)]) {
		check(beforeHeapEscape(value, flag, mutate), value, "saved heap value stays rooted");
		const iterator = suspendedHeap(value, flag, mutate);
		check(iterator.next().value, "pause", "suspended heap checkpoint");
		observe();
		check(iterator.next().value, value, "saved heap value survives suspension");
		pending.push(
			awaitedHeap(value, flag, mutate).then((saved) => {
				check(saved, value, "saved heap value survives await");
			}),
		);
	}
	let getters = 0;
	check(
		afterEscape(3, flag, (record) => {
			Object.defineProperty(record, "n", {
				get() {
					getters++;
					observe();
					return "getter";
				},
			});
		}),
		"getter",
		"descriptor replacement retains accessor effects",
	);
	check(getters, 1, "getter executes once");
	const failure = { marker: "failure".repeat(100) };
	try {
		beforeEscape(3, flag, (record) => {
			mutate(record);
			throw failure;
		});
		throw new Error("missing observer exception");
	} catch (error) {
		check(error, failure, "observer exception identity");
	}
}
Promise.all(pending).then(() => console.log("record-read-prefixes PASS"));
