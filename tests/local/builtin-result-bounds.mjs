function check(actual, expected, label) {
	if (!Object.is(actual, expected)) throw new Error(label);
}
const collect = () => globalThis.gc?.();
function jsonSequence(replacer) {
	const first = JSON.stringify(17, replacer);
	const second = JSON.stringify(17, replacer);
	return [first, second];
}
function heldJson(value, observe) {
	const result = JSON.stringify(value);
	observe();
	return result;
}
function flag(value, observe) {
	const result = Object.getOwnPropertyDescriptor(RegExp.prototype, "global").get.call(
		value,
	);
	observe();
	return result;
}
function atomic(value, index, observe) {
	const result = Atomics.load(value, index);
	observe();
	return result;
}
function setTime(value, time, observe) {
	const result = Date.prototype.setTime.call(value, time);
	observe();
	return result;
}
Object.assign(globalThis, { jsonSequence, heldJson, flag, atomic, setTime });

let visits = 0;
const sequence = jsonSequence(() => {
	collect();
	return ++visits === 1 ? "first" : undefined;
});
check(sequence[0], '"first"', "String replacer completion");
check(sequence[1], undefined, "undefined replacer completion");
check(visits, 2, "replacer effects retained");
const text = "heap".repeat(100);
check(
	heldJson({ text }, collect),
	`{"text":"${text}"}`,
	"String result survives collection",
);
check(heldJson(undefined, collect), undefined, "undefined serialization result");
check(flag(RegExp.prototype, collect), undefined, "prototype flag sentinel");
check(flag(/x/g, collect), true, "Boolean flag result");
check(flag(/x/, collect), false, "false flag result");
const numbers = new Int32Array([17]);
check(atomic(numbers, 0, collect), 17, "Number atomic result");
Atomics.store(numbers, 0, 23);
check(atomic(numbers, 0, collect), 23, "atomic reads observe mutation");
const big = 2n ** 60n + 3n;
check(
	atomic(new BigInt64Array([big]), 0, collect),
	big,
	"BigInt result survives collection",
);
const date = new Date(0);
check(
	setTime(
		date,
		{
			valueOf() {
				collect();
				return 42;
			},
		},
		collect,
	),
	42,
	"setter coercion",
);
check(date.getTime(), 42, "Date mutation retained");

let reads = 0;
const arrayLike = {
	get length() {
		collect();
		return 1;
	},
	get 0() {
		collect();
		return ++reads;
	},
};
check(Array.prototype.includes.call(arrayLike, 1), true, "first indexed read");
check(Array.prototype.includes.call(arrayLike, 1), false, "indexed getter retained");
check(reads, 2, "both indexed getters ran");
let executions = 0;
const regexpLike = {
	exec() {
		collect();
		return ++executions === 1 ? {} : null;
	},
};
check(RegExp.prototype.test.call(regexpLike, "x"), true, "object exec result");
check(RegExp.prototype.test.call(regexpLike, "x"), false, "null exec result");
check(executions, 2, "custom exec effects retained");

const marker = {};
try {
	JSON.stringify(17, () => {
		collect();
		throw marker;
	});
	throw new Error("missing replacer exception");
} catch (error) {
	check(error, marker, "replacer exception identity");
}
console.log("builtin-result-bounds PASS");
