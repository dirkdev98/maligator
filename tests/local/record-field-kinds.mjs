function check(actual, expected, label) {
	if (!Object.is(actual, expected))
		throw new Error(`${label}: ${String(actual)} != ${String(expected)}`);
}
const events = [];
function observe(value) {
	events.push(value);
	if (typeof globalThis.gc === "function") globalThis.gc();
}
const makeRecord = function makeRecord(value, callback) {
	let label = "";
	for (let index = 0; index < 2; index++) {
		callback(index);
		label += "x";
	}
	return { n: +value, label };
};
function readStable(value, callback) {
	const result = makeRecord(value, callback);
	callback("after");
	return typeof result.n === "number" && typeof result.label === "string";
}
function readValue(value, callback) {
	const result = makeRecord(value, callback);
	callback("value");
	return result.n;
}
function readString(value, callback) {
	const result = makeRecord(value, callback);
	callback("string");
	return result.label + ":";
}
const makeNullable = function makeNullable(flag, callback) {
	for (let index = 0; index < 2; index++) callback(index);
	return { label: flag ? null : "text" };
};
function readNullable(flag, callback) {
	const result = makeNullable(flag, callback);
	callback("nullable");
	return typeof result.label === "object";
}
function readEscaped(value, callback) {
	const result = makeRecord(value, observe);
	callback(result);
	return typeof result.n;
}
function readGetterMutated(value) {
	const result = makeRecord(value, observe);
	result.recordFieldProbe;
	return typeof result.n;
}
const makeString = function makeString(value, callback) {
	for (let index = 0; index < 2; index++) callback(index);
	return { n: "text", label: "xx" };
};
function readUnion(value, flag, callback) {
	const make = flag ? makeRecord : makeString;
	const result = make(value, callback);
	callback("union");
	return typeof result.n === "object";
}
function* readSuspended(value, callback) {
	const result = makeRecord(value, callback);
	yield result.label;
	callback("resume");
	return typeof result.n === "number" && result.label === "xx";
}
async function readAwaited(value, callback) {
	const result = makeRecord(value, callback);
	await 0;
	callback("await");
	return typeof result.n === "number" && result.label === "xx";
}
async function* readAsyncSuspended(value, callback) {
	const result = makeRecord(value, callback);
	yield result.label;
	await 0;
	callback("async resume");
	return typeof result.n === "number" && result.label === "xx";
}
function readPublic(callback) {
	callback();
	const result = globalThis.recordFieldFactory();
	return typeof result.n;
}
Object.assign(globalThis, {
	readStable,
	readValue,
	readString,
	readNullable,
	readEscaped,
	readGetterMutated,
	readUnion,
	readSuspended,
	readAwaited,
	readAsyncSuspended,
	readPublic,
});
let coercions = 0;
const value = {
	valueOf() {
		coercions++;
		observe("coerce");
		return 7;
	},
};
check(readStable(value, observe), true, "stable fields");
check(coercions, 1, "single coercion");
check(JSON.stringify(events), '[0,1,"coerce","after"]', "coercion order");
for (const input of [-0, 0, NaN, Infinity, -Infinity, 2147483648]) {
	check(readStable(input, observe), true, "Number field category");
	check(readValue(input, observe), input, "Number field value");
}
check(readString(3, observe), "xx:", "String field concatenation");
for (const flag of [false, true])
	check(readNullable(flag, observe), flag, "nullable String predicate");
const failure = { marker: "coercion failure" };
events.length = 0;
try {
	readStable(
		{
			valueOf() {
				observe("throw");
				throw failure;
			},
		},
		observe,
	);
	throw new Error("missing coercion exception");
} catch (error) {
	check(error, failure, "coercion exception identity");
}
check(JSON.stringify(events), '[0,1,"throw"]', "abrupt coercion order");
for (const input of [1n, Symbol("input")]) {
	let error;
	try {
		readStable(input, observe);
	} catch (caught) {
		error = caught;
	}
	check(error instanceof TypeError, true, "unary plus error");
}
check(
	readEscaped(3, (record) => {
		observe("escape");
		record.n = "changed";
	}),
	"string",
	"escaped record mutation",
);
let getterCalls = 0;
if (Object.isExtensible(Object.prototype)) {
	Object.defineProperty(Object.prototype, "recordFieldProbe", {
		configurable: true,
		get() {
			getterCalls++;
			observe("getter");
			this.n = "changed";
			return 0;
		},
	});
	try {
		check(readGetterMutated(3), "string", "prototype getter mutation");
		check(getterCalls, 1, "prototype getter count");
	} finally {
		delete Object.prototype.recordFieldProbe;
	}
}
for (const flag of [false, true])
	check(readUnion(3, flag, observe), false, "partial Number/String union");
globalThis.recordFieldFactory = () => ({ n: 1 });
check(
	readPublic(() => {
		globalThis.recordFieldFactory = () => ({ n: "changed" });
	}),
	"string",
	"replaceable public factory",
);
const iterator = readSuspended(3, observe);
check(iterator.next().value, "xx", "suspended heap field");
observe("between");
const completed = iterator.next();
check(completed.done, true, "generator completion");
check(completed.value, true, "generator field observation");
const asyncIterator = readAsyncSuspended(3, observe);
const asyncSteps = asyncIterator
	.next()
	.then((result) => {
		check(result.value, "xx", "async suspended heap field");
		observe("async between");
		return asyncIterator.next();
	})
	.then((result) => {
		check(result.done, true, "async generator completion");
		check(result.value, true, "async generator field observation");
	});
Promise.all([
	readAwaited(3, observe).then((result) => {
		check(result, true, "awaited field observation");
	}),
	asyncSteps,
]).then(() => console.log("record-field-kinds PASS"));
