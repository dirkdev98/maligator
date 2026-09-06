function assert(condition, name) {
	if (!condition) throw new Error(name);
}

function activation(depth) {
	let captured = { value: depth };
	const read = () => captured;
	const write = (next) => {
		captured = next;
	};
	for (let i = 0; i < 100; i++) {
		const previous = read();
		captured = { value: i, previous };
		assert(read() === captured, "outer writes reach closure");
		write({ value: i + 1 });
		assert(captured.value === i + 1, "closure writes reach outer");
	}
	if (depth > 0) {
		const own = captured;
		activation(depth - 1);
		assert(captured === own, "recursive activation isolation");
	}
	return read;
}
assert(activation(3)().value === 100, "escaping capture");

const iterations = [];
for (let i = 0; i < 4; i++) iterations.push(() => i);
assert(iterations.map((read) => read()).join(",") === "0,1,2,3", "per-iteration env");
function* suspended() {
	let value = 1;
	const read = () => value;
	yield read;
	value = 9;
	yield read;
}
const iterator = suspended();
const read = iterator.next().value;
assert(read() === 1, "capture before resume");
assert(iterator.next().value === read && read() === 9, "capture after resume");

let effects = 0;
function rhs() {
	effects++;
	return 2;
}
for (const object of [null, undefined]) {
	for (const key of ["01", "ordinary", "0"]) {
		let error;
		try {
			object[key] += rhs();
		} catch (caught) {
			error = caught;
		}
		assert(error instanceof TypeError && effects === 0, "nullish key timing");
	}
}
const order = [];
const objectKey = {
	[Symbol.toPrimitive]() {
		order.push("key");
		return "value";
	},
};
const object = { value: 1 };
object[objectKey] += (order.push("rhs"), 2);
assert(object.value === 3 && order.join(",") === "key,rhs", "coercive key timing");

let finalized = 0;
const sentinel = {};
function argument(value = 7) {
	try {
		return arguments[2];
	} catch (error) {
		return error;
	} finally {
		finalized++;
	}
}
Object.defineProperty(Object.prototype, "2", {
	configurable: true,
	get() {
		throw sentinel;
	},
});
const present = argument(1, 2, 42);
const missing = argument();
delete Object.prototype[2];
assert(
	present === 42 && missing === sentinel && finalized === 2,
	"argument fallback completion",
);

let extra = 0;
const number = new Number(-0);
const boolean = new Boolean(false);
assert(Object.is(number.valueOf(extra++), -0), "Number wrapper valueOf");
assert(
	boolean.valueOf(extra++) === false && extra === 2,
	"Boolean wrapper valueOf effects",
);

function fixedArityCollections() {
	const map = new Map();
	const set = new Set();
	let effects = 0;
	map.set();
	set.add();
	assert(map.has() && set.has() && map.get() === undefined, "missing collection args");
	const key = {};
	map.set(key, { value: 7 }, effects++);
	set.add(key, effects++);
	assert(
		map.get(key, effects++).value === 7 && set.has(key, effects++),
		"object collection keys",
	);
	assert(effects === 4, "extra collection arguments execute");
	for (const key of [NaN, -0, 0]) {
		map.set(key, 1);
		set.add(key);
		assert(
			map.get(key) === 1 && map.has(key) && set.has(key),
			"canonical collection keys",
		);
		assert(map.delete(key) && set.delete(key), "collection delete");
		assert(map.get(key) === undefined && !map.has(key), "delete invalidates cache");
		map.set(key, 2);
		assert(map.get(key) === 2, "collection reinsert");
	}
}
fixedArityCollections();
console.log("activation-input-facts PASS");
