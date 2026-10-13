const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc;
const mutable = process.env.MAL_PRIMORDIALS !== "locked";
function effectful(first, source, make) {
	return [first, make(1), source.value, make(3), source + 4, make(5), 123n, -0, "𝌆"];
}
function large64(make) {
	return [
		make(0),
		make(1),
		make(2),
		make(3),
		make(4),
		make(5),
		make(6),
		make(7),
		make(8),
		make(9),
		make(10),
		make(11),
		make(12),
		make(13),
		make(14),
		make(15),
		make(16),
		make(17),
		make(18),
		make(19),
		make(20),
		make(21),
		make(22),
		make(23),
		make(24),
		make(25),
		make(26),
		make(27),
		make(28),
		make(29),
		make(30),
		make(31),
		make(32),
		make(33),
		make(34),
		make(35),
		make(36),
		make(37),
		make(38),
		make(39),
		make(40),
		make(41),
		make(42),
		make(43),
		make(44),
		make(45),
		make(46),
		make(47),
		make(48),
		make(49),
		make(50),
		make(51),
		make(52),
		make(53),
		make(54),
		make(55),
		make(56),
		make(57),
		make(58),
		make(59),
		make(60),
		make(61),
		make(62),
		make(63),
	];
}
function large128(value) {
	return [
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
		value,
	];
}
function protectedValues(make) {
	try {
		return [make(0), make(1), make(2)];
	} catch (error) {
		return error;
	}
}
globalThis.effectfulArray = effectful;
globalThis.large64Array = large64;
globalThis.large128Array = large128;
globalThis.protectedArray = protectedValues;
const rows = [];
for (let round = 0; round < 12; round++) {
	let order = "";
	const first = { round };
	const source = {
		get value() {
			order += "g";
			collectGarbage?.();
			return { getter: round };
		},
		valueOf() {
			order += "v";
			collectGarbage?.();
			return round;
		},
	};
	function make(index) {
		order += index;
		collectGarbage?.();
		return { index, round };
	}
	const result = globalThis.effectfulArray(first, source, make);
	collectGarbage?.();
	if (
		result[0] !== first ||
		result[1].index !== 1 ||
		result[2].getter !== round ||
		result[3].index !== 3 ||
		result[4] !== round + 4 ||
		result[5].index !== 5 ||
		result[6] !== 123n ||
		!Object.is(result[7], -0) ||
		result[8] !== "𝌆"
	)
		throw new Error("incremental values");
	if (order !== "1g3v5" || result.length !== 9 || Object.keys(result).length !== 9)
		throw new Error("evaluation order");
	const long = globalThis.large64Array(make);
	const repeated = globalThis.large128Array(first);
	collectGarbage?.();
	if (
		long.length !== 64 ||
		!long.every((value, index) => value.index === index && value.round === round)
	)
		throw new Error("large evaluated values");
	if (repeated.length !== 128 || !repeated.every((value) => value === first))
		throw new Error("large reference values");
	rows.push([result.length, long[63].index, repeated.length, order.length]);
}
for (const stop of [1, 3, 5]) {
	let order = "";
	const error = { stop };
	try {
		globalThis.effectfulArray(
			null,
			{
				get value() {
					order += "g";
					return null;
				},
				valueOf() {
					order += "v";
					return 0;
				},
			},
			(index) => {
				order += index;
				collectGarbage?.();
				if (index === stop) throw error;
				return index;
			},
		);
		throw new Error("missing abrupt completion");
	} catch (caught) {
		if (caught !== error) throw caught;
		if (order !== (stop === 1 ? "1" : stop === 3 ? "1g3" : "1g3v5"))
			throw new Error("replayed initializer");
		rows.push(order);
	}
}
const caught = { caught: true };
if (
	globalThis.protectedArray((index) => {
		collectGarbage?.();
		if (index === 1) throw caught;
		return index;
	}) !== caught
)
	throw new Error("handler identity");
let inheritedWrites = 0;
if (mutable)
	Object.defineProperty(Array.prototype, "1", {
		configurable: true,
		set() {
			inheritedWrites++;
		},
	});
try {
	const output = globalThis.effectfulArray(
		null,
		{
			value: null,
			valueOf() {
				return 0;
			},
		},
		(index) => index,
	);
	if (output[1] !== 1 || !Object.hasOwn(output, "1"))
		throw new Error("inherited setter intercepted definition");
} finally {
	if (mutable) delete Array.prototype[1];
}
if (inheritedWrites !== 0) throw new Error("inherited setter ran");
rows.push(inheritedWrites);
console.log(JSON.stringify(rows));
