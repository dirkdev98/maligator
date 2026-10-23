const mode = process.env.RECORD_MATH_MODE ?? "clamp";
const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
function clamp(record, lower, upper) {
	record.x = Math.max(record.x, lower, -64);
	record.y = Math.min(record.y, upper, 64);
	return record.x + record.y;
}
function round(record, scale) {
	record.x = Math.f16round(record.x * scale);
	record.y = Math.round(record.y);
	return record.x - record.y;
}
function vector(record, scale) {
	record.x = Math.abs(record.x);
	record.y = Math.pow(record.y, scale);
	record.norm = Math.hypot(record.x, record.y, record.z);
	return record.norm;
}
function integer(record, scale) {
	record.x = Math.imul(record.x, scale);
	record.y = Math.clz32(record.y);
	return record.x + record.y;
}
function missing(record) {
	record.x = Math.imul(record.x);
	record.y = Math.max(record.y, null, true);
	return record.x + record.y;
}
function interleaved(record, scale) {
	record.y = record.y * scale + record.z;
	record.x = Math.round(record.x + record.y);
	return record.x - record.y;
}
globalThis.recordClamp = clamp;
globalThis.recordRound = round;
globalThis.recordVector = vector;
globalThis.recordInteger = integer;
globalThis.recordMissing = missing;
globalThis.recordInterleaved = interleaved;
const kernels = {
	clamp: globalThis.recordClamp,
	round: globalThis.recordRound,
	vector: globalThis.recordVector,
	integer: globalThis.recordInteger,
	missing: globalThis.recordMissing,
	interleaved: globalThis.recordInterleaved,
};
function scalar(value) {
	if (Object.is(value, -0)) return "-0";
	if (!Number.isFinite(value)) return String(value);
	return mode === "vector" ? value.toPrecision(12) : value;
}
const rows = [];
if (mode === "fallback") {
	const events = [];
	const target = { x: -3, y: 10 };
	const proxy = new Proxy(target, {
		get(object, key) {
			events.push(`get:${String(key)}`);
			collectGarbage();
			return object[key];
		},
		set(object, key, value) {
			events.push(`set:${String(key)}:${value}`);
			collectGarbage();
			object[key] = value;
			return true;
		},
	});
	rows.push(globalThis.recordClamp(proxy, 0, 5), events.slice());
	let x = -2;
	const accessor = {
		get x() {
			events.push("getter");
			collectGarbage();
			return x;
		},
		set x(value) {
			events.push("setter");
			x = value;
			this.y = 7;
		},
		y: 20,
	};
	rows.push(globalThis.recordClamp(accessor, 0, 9), x, accessor.y, events.slice());
	const record = { x: -3, y: 20 };
	rows.push(
		globalThis.recordClamp(
			record,
			{
				valueOf() {
					events.push("coerce");
					collectGarbage();
					record.y = 7;
					return 1;
				},
			},
			9,
		),
		record.x,
		record.y,
		events.slice(),
	);
	let thrown = 0;
	const sentinel = {};
	try {
		globalThis.recordClamp(
			record,
			{
				valueOf() {
					events.push("throw");
					throw sentinel;
				},
			},
			9,
		);
	} catch (error) {
		if (error === sentinel) thrown++;
	}
	try {
		globalThis.recordInteger({ x: 2n, y: 3 }, 2);
	} catch (error) {
		if (error instanceof TypeError) thrown++;
	}
	if (thrown !== 2 || events.filter((value) => value === "throw").length !== 1)
		throw new Error("coercion replay");
	rows.push(thrown, record.x, record.y, events.slice());
	const frozen = Object.freeze({ x: -3, y: 20 });
	let frozenThrows = false;
	try {
		globalThis.recordClamp(frozen, 0, 9);
	} catch (error) {
		frozenThrows = error instanceof TypeError;
	}
	if (!frozenThrows) throw new Error("non-writable store did not throw");
	rows.push(frozenThrows, frozen.x, frozen.y);
	const boxed = { x: new Number(-3), y: new Number(20) };
	rows.push(globalThis.recordClamp(boxed, 0, 9), Number(boxed.x), Number(boxed.y));
} else if (mode === "effects") {
	const record = { x: -3, y: 20 };
	const events = [];
	globalThis.recordClamp(record, 0, 9);
	if (process.env.MAL_PRIMORDIALS === "mutable") {
		const original = Math.max;
		Math.max = function (value, lower, bound) {
			events.push(`max:${value}:${lower}:${bound}`);
			collectGarbage();
			record.y = -17;
			return original(value, lower, bound);
		};
		try {
			rows.push(globalThis.recordClamp(record, 1, 9));
		} finally {
			Math.max = original;
		}
	}
	rows.push(record.x, record.y, events);
} else {
	const kernel = kernels[mode];
	if (kernel === undefined) throw new Error("unknown record Math mode");
	const inputs = [-0, 0, -3, 4, 1.00048828125, 2147483647, Infinity, -Infinity, NaN];
	for (let round = 0; round < 4; round++) {
		for (let index = 0; index < inputs.length; index++) {
			const record = {
				x: inputs[index],
				y: inputs[(index + 3) % inputs.length],
				z: 12,
				norm: 0,
			};
			const result = kernel(record, round === 0 ? 0.5 : 2, 9);
			rows.push([
				scalar(result),
				scalar(record.x),
				scalar(record.y),
				scalar(record.norm),
			]);
		}
		collectGarbage();
	}
}
console.log(JSON.stringify(rows));
