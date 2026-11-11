const check = (condition, message) => {
	if (!condition) throw new Error(message);
};
function convert(value) {
	return Number(value);
}
function rejects(call) {
	let rejected = false;
	try {
		call();
	} catch (error) {
		rejected = error instanceof TypeError;
	}
	check(rejected, "expected TypeError");
}
const source = {
	get values() {
		return [
			0n,
			1n,
			-1n,
			9007199254740993n,
			9223372036854775807n,
			-9223372036854775808n,
			18446744073709551615n,
			1n << 100n,
			-(1n << 100n),
		];
	},
};
const inputs = Reflect.get(source, process.argv[2] ?? "values");
const outputs = inputs.map(convert);
check(!Object.is(outputs[0], -0), "BigInt zero is positive zero");
check(Object.is(convert(-0), -0), "Number preserves negative zero");
const wide = inputs[6];
const events = [];
const object = {
	[Symbol.toPrimitive](hint) {
		events.push(hint);
		return wide;
	},
};
check(
	convert(object) === outputs[6] && events.join(",") === "number",
	"observable coercion",
);
check(convert(Object(wide)) === outputs[6], "boxed BigInt coercion");
check(Number(...[wide]) === outputs[6], "spread conversion");
check(new Number(wide).valueOf() === outputs[6], "Number construction");
check(
	convert("17") === 17 && convert(null) === 0 && convert(true) === 1,
	"primitive fallback",
);
rejects(() => convert(Symbol("value")));
rejects(() => +wide);
const captured = Number;
if (process.env.NUMBER_CONVERSION_PRIMORDIALS === "mutable") {
	const replacement = new Proxy(captured, {
		apply(target, receiver, args) {
			events.push("replacement");
			return Reflect.apply(target, receiver, args) + 1;
		},
	});
	function mutate() {
		globalThis.Number = replacement;
		return 7n;
	}
	try {
		check(Number(mutate()) === 7, "callee captured before argument mutation");
		check(convert(7n) === 8, "replacement receives BigInt");
		check(captured(7n) === 7, "captured intrinsic remains callable");
	} finally {
		globalThis.Number = captured;
	}
}
let extra = 0;
check(Number(wide, extra++) === outputs[6] && extra === 1, "extra arguments evaluated");
// Loop-carried BigInts keep exact kinds, so conversions and width operations take
// their typed paths, including their errors.
function exactConversions() {
	let state = (1n << 63n) + 17n;
	const results = [];
	for (let round = 0; round < 8; round++) {
		state = BigInt.asUintN(64, state * 6364136223846793005n + BigInt(round & 255));
		const signed = BigInt.asIntN(64, state);
		results.push(String(state), String(signed), Number(signed & 65535n), Number(signed));
		try {
			results.push(String(BigInt(round + 0.5)));
		} catch (error) {
			results.push(error.name);
		}
		try {
			results.push(String(state / (signed - signed)));
		} catch (error) {
			results.push(error.name);
		}
	}
	return results;
}
const exact = exactConversions();
console.log(JSON.stringify({ outputs, events, exact }));
