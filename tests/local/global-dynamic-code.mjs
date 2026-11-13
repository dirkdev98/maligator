// Code compiled at run time reaches the program only through the global object and
// the values it is handed. Each section runs a pattern a closed program optimizes,
// lets such code interfere with it, and runs the pattern again.

function show(value) {
	if (typeof value === "bigint") return `${value}n`;
	if (typeof value === "function") return `function ${value.name}`;
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(show).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.keys(value)
			.map((key) => `${key}:${show(value[key])}`)
			.join(",")}}`;
	return String(value);
}

function adjust(value, offset = 3) {
	return (value * 3 + offset) & 65_535;
}

function collect(base, ...values) {
	let result = base;
	for (const value of values) result += value;
	return result;
}

function unexpectedArguments() {
	let checksum = 0;
	for (let index = 0; index < 400; index++)
		checksum += adjust(index & 1_023) + collect(3, index & 7, 13);
	const foreign = new Function(
		"adjust",
		"collect",
		"return [adjust('7'), adjust({ valueOf() { return 2; } }, 'x'), collect('a', 1, 2), collect(1n, 2n), collect([1], {}), collect()];",
	);
	const results = foreign(adjust, collect);
	for (let index = 0; index < 400; index++)
		checksum += adjust(index & 1_023) + collect(3, index & 7, 13);
	return [checksum, ...results];
}

function scoreOf(entry) {
	return entry.points * 2 + entry.bonus;
}
globalThis.scoreOf = scoreOf;

function globalFunctions() {
	const entries = Array.from({ length: 32 }, (_, index) => ({
		points: index,
		bonus: index & 3,
	}));
	let total = 0;
	for (let round = 0; round < 20; round++)
		for (const entry of entries) total += scoreOf(entry);
	const viaGlobal = Function(
		"return [scoreOf({ points: '4', bonus: 1 }), scoreOf({ points: 1 }), scoreOf(Object.create({ points: 5, bonus: 5 }))];",
	)();
	return [total, ...viaGlobal];
}

globalThis.threshold = 10;
globalThis.transform = (value) => value * 2;

function countAbove(values) {
	let count = 0;
	for (const value of values) if (value > threshold) count++;
	return count;
}

function transformAll(values) {
	let sum = 0;
	for (const value of values) sum += transform(value);
	return sum;
}

function lateGlobal() {
	return typeof lateValue === "undefined" ? "absent" : lateValue * 2;
}

function reassignedGlobals() {
	const values = Array.from({ length: 100 }, (_, index) => index);
	const results = [countAbove(values), transformAll(values), lateGlobal()];
	for (let round = 0; round < 20; round++) {
		countAbove(values);
		transformAll(values);
		lateGlobal();
	}
	Function(
		"threshold = 90; globalThis.transform = function (value) { return value + 'x'; }; globalThis.lateValue = 21;",
	)();
	results.push(countAbove(values), transformAll(values.slice(0, 4)), lateGlobal());
	Function("delete globalThis.threshold;")();
	try {
		countAbove(values);
	} catch (error) {
		results.push(error.constructor.name);
	}
	(0, eval)("var fromEval = 5; function evalHelper(value) { return value + fromEval; }");
	results.push(globalThis.evalHelper(1), typeof fromEval);
	return results;
}

class Point {
	constructor(x, y) {
		this.x = x;
		this.y = y;
	}
	norm() {
		return this.x + this.y;
	}
}

function sumNorms(points) {
	let total = 0;
	for (const point of points) total += point.norm();
	return total;
}

function advance(records) {
	const values = [];
	for (const record of records) {
		const { id, position } = record;
		try {
			position.x += record.velocity;
			values.push(position.x + (record.profile?.score ?? 7) + id);
		} catch (error) {
			values.push(error.constructor.name);
		}
	}
	return values;
}

function mutatedObjects() {
	const points = Array.from({ length: 16 }, (_, index) => new Point(index, index * 2));
	const records = Array.from({ length: 16 }, (_, id) => ({
		id,
		position: { x: id, y: 1 },
		velocity: (id & 3) - 1,
		profile: (id & 1) === 0 ? undefined : { score: id },
	}));
	let warm = 0;
	for (let round = 0; round < 20; round++) {
		warm += sumNorms(points);
		warm += advance(records)[3];
	}
	const prototypeReach = Function(
		"points",
		"records",
		`
		delete points[1].x;
		points[2].y = "y";
		Object.setPrototypeOf(points[3], { norm() { return -100; } });
		points[4].norm = () => 1000;
		Object.defineProperty(points[5], "x", { get() { return 50; } });
		records[0].position = { x: "p" };
		delete records[1].velocity;
		Object.defineProperty(records[2], "velocity", { get() { return 10; } });
		records[3].profile = { get score() { return -1; } };
		Object.setPrototypeOf(records[4], { velocity: 100 });
		delete records[4].velocity;
		Object.freeze(records[5].position);
		records.push({ id: 99, position: { x: 0 }, velocity: 1 });
		const C = points[0].constructor;
		const made = new C("a", "b");
		return [made.norm(), C.prototype.norm.call({ x: 2n, y: 3n }), C.name];
		`,
	)(points, records);
	return [
		warm,
		points.map((point) => point.norm()),
		advance(records),
		Object.keys(records[1]),
		prototypeReach,
		sumNorms(points.slice(6)),
	];
}

function dynamicFunctions() {
	const scaled = new Function("k", "return function scaled(x) { return x * k + 1; };")(3);
	let accumulated = 0;
	for (let index = 0; index < 2_000; index++)
		accumulated = (accumulated + scaled(index & 1_023)) % 1_000_003;
	const squares = new Function(
		"return function* squares(n) { for (let i = 0; i < n; i++) yield i * i; };",
	)();
	let squared = 0;
	for (let round = 0; round < 20; round++)
		for (const value of squares(16)) squared += value;
	const wrapped = new Function(
		"callback",
		"return (x) => callback(x) + callback(x + 1);",
	)(adjust);
	let wrappedSum = 0;
	for (let index = 0; index < 500; index++) wrappedSum += wrapped(index & 255);
	const callbacks = Array.from(
		{ length: 8 },
		(_, bias) => new Function("value", `return value + ${bias};`),
	);
	let mixed = 0;
	for (let index = 0; index < 400; index++) mixed += callbacks[index & 7](index & 15);
	const Counter = new Function(
		"value",
		"this.value = value; this.double = () => this.value * 2;",
	);
	let constructed = 0;
	for (const counter of Array.from({ length: 10 }, (_, index) => new Counter(index)))
		constructed += counter.double();
	return [accumulated, squared, wrappedSum, mixed, constructed];
}

function* sequence(seed) {
	for (let index = 0; index < 12; index++) yield (seed + index * 7) & 255;
}

function* published(limit) {
	for (let index = 0; index < limit; index++) yield index;
	return "done";
}

function generators() {
	let checksum = 0;
	for (let index = 0; index < 200; index++) {
		for (const value of sequence(index)) checksum += value;
		const early = sequence(index);
		for (const value of early) {
			checksum += value;
			if (value & 1) break;
		}
	}
	const driven = new Function(
		"make",
		"const it = make(3); const out = [it.next().value, it.return(7).value, it.next().done]; out.push([...make(2)].length, String(make('2').next().value)); return out;",
	)(published);
	let after = 0;
	for (const value of published(5)) after += value;
	return [checksum, driven, after];
}

function privateRest(base, ...values) {
	let result = base;
	for (const value of values) result += value;
	return result;
}

function publishedRest(base, ...values) {
	let result = base;
	for (const value of values) result += value;
	return result;
}
globalThis.publishedRest = publishedRest;

function restArguments() {
	let checksum = 0;
	for (let index = 0; index < 400; index++)
		checksum +=
			privateRest(index & 3, index & 7, 13, index & 1) + publishedRest(1, index & 3);
	const foreign = Function(
		"return [publishedRest('a', 'b', 'c'), publishedRest(1, ...[2, 3, 4]), publishedRest.apply(null, [5, 6]), publishedRest.length];",
	)();
	return [checksum, ...foreign, publishedRest(2, 2)];
}

function makeRetainedRecord(id, value) {
	return {
		id,
		data: { value, previous: value - 1 },
		read: () => value + id,
	};
}

function counterWithEarlyReturn(limit, values) {
	let seen = 0;
	const note = (value) => {
		seen += value;
		return seen;
	};
	if (limit < 0) return -1;
	for (const value of values) if (note(value) > limit) break;
	return seen;
}

function makeCounter() {
	let count = 0;
	return {
		increment(step) {
			count += step;
			return count;
		},
		read: () => count,
	};
}

function capturedState() {
	const retained = new Array(32).fill(null);
	let checksum = 0;
	for (let index = 0; index < 400; index++) {
		const values = [index & 255, (index * 3) & 255, (index * 7) & 255];
		const temporary = { left: { value: values[0] }, right: { value: values[1] } };
		const result = makeRetainedRecord(index & 1_023, temporary.left.value + values[2]);
		checksum += result.read() + temporary.right.value;
		if ((index & 15) === 0) {
			const slot = (index >>> 4) & 31;
			const previous = retained[slot];
			if (previous !== null) checksum += previous.read() + previous.data.previous;
			retained[slot] = result;
		}
	}
	const inspected = new Function(
		"records",
		"return records.slice(0, 4).map((record) => record.read() + ':' + record.data.previous);",
	)(retained);
	for (let index = 0; index < 300; index++)
		checksum += counterWithEarlyReturn(index & 15 ? 40 : -1, [index & 7, 9, 11, 13]);
	const counter = makeCounter();
	for (let index = 0; index < 100; index++) counter.increment(1);
	Function("counter", "counter.increment('x'); counter.increment(2.5);")(counter);
	const hidden = "module";
	return [
		checksum,
		inspected,
		counter.read(),
		hidden,
		(0, eval)("typeof hidden"),
		Function("return typeof makeCounter")(),
	];
}

const sections = {
	unexpectedArguments,
	globalFunctions,
	reassignedGlobals,
	mutatedObjects,
	dynamicFunctions,
	generators,
	restArguments,
	capturedState,
};
for (const [name, run] of Object.entries(sections))
	console.log(`${name}: ${show(run())}`);

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const doubled = new AsyncFunction("value", "return (await value) * 2;");
console.log(`async: ${show(await doubled(Promise.resolve(21)))}`);
