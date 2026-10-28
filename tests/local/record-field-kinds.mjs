function check(actual, expected, label) {
	if (!Object.is(actual, expected))
		throw new Error(`${label}: ${String(actual)} != ${String(expected)}`);
}
const events = [];
const makeGuardedRecord = function makeGuardedRecord(input, callback) {
	for (let step = 0; step < 3; step++) callback(step);
	const record = { value: 0 };
	if (typeof input === "number") record.value = input;
	return record;
};
function readGuardedRecord(input, callback) {
	const record = makeGuardedRecord(input, callback);
	callback("guarded read");
	return record.value + 1;
}
function readCallerGuardedRecord(input, flag, callback) {
	const first = makeGuardedRecord(0, callback);
	const record = flag ? first : makeGuardedRecord(0, callback);
	if (typeof input === "number") record.value = input;
	callback("caller guarded read");
	return record.value + 1;
}
const makeGuardedUnion = function makeGuardedUnion(input, callback) {
	for (let step = 0; step < 3; step++) callback(step);
	if (typeof input === "string") return { value: input };
	return { value: 0 };
};
function readGuardedUnion(input, callback) {
	const record = makeGuardedUnion(input, callback);
	callback("guarded union");
	return record.value + 1;
}
Object.assign(globalThis, {
	readGuardedRecord,
	readGuardedUnion,
	readCallerGuardedRecord,
});
function observe(value) {
	events.push(value);
	if (typeof globalThis.gc === "function") globalThis.gc();
}
for (const input of [-0, 0, NaN, Infinity, -Infinity, 2147483648])
	check(readGuardedRecord(input, observe), input + 1, "guarded Number field");
for (const input of [undefined, null, false, "text", 1n, Symbol("input"), {}])
	check(readGuardedRecord(input, observe), 1, "guard rejects non-Number field");
check(readGuardedUnion("text", observe), "text1", "guarded String field");
check(readGuardedUnion(2, observe), 1, "guarded union default");
for (const flag of [false, true]) {
	for (const input of [-0, NaN, Infinity, -Infinity, 2147483648])
		check(
			readCallerGuardedRecord(input, flag, observe),
			input + 1,
			"guarded caller Number",
		);
	for (const input of [undefined, null, false, "text", 1n, Symbol("input"), {}])
		check(readCallerGuardedRecord(input, flag, observe), 1, "guarded caller default");
}
events.length = 0;
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
const makeBoundedRecord = function makeBoundedRecord(value, callback) {
	for (let step = 0; step < 3; step++) callback(step);
	return {
		signed: value | 0,
		unsigned: value >>> 0,
		small: value & 255,
		label: "bounded",
	};
};
const makeConditionalRecord = function makeConditionalRecord(value, flag, callback) {
	for (let step = 0; step < 3; step++) callback(step);
	return flag
		? { small: value & 15, label: "narrow", left: true }
		: { right: null, label: "wide", small: value & 255 };
};
const makeLoopRecord = function makeLoopRecord(value, steps, callback) {
	let result = { small: value & 15, label: "initial" };
	for (let step = 0; step < steps; step++) {
		callback(step);
		result = { label: "loop", small: value & 255 };
	}
	return result;
};
function readConditionalRecord(value, flag, callback) {
	const record = makeConditionalRecord(value, flag, observe);
	const small = record.small;
	const label = record.label;
	callback(record);
	return `${label}:${small % 10}`;
}
function readLoopRecord(value, steps, callback) {
	const record = makeLoopRecord(value, steps, observe);
	const small = record.small;
	const label = record.label;
	callback(record);
	return `${label}:${small % 10}`;
}
function readBounded(value, callback) {
	const record = makeBoundedRecord(value, callback);
	callback("bounded read");
	return record.small % 10;
}
function readBoundedUnsigned(value, callback) {
	const record = new makeBoundedRecord(...[value, callback]);
	callback("unsigned read");
	return record.unsigned;
}
function readBoundedEscaped(value, callback) {
	const record = makeBoundedRecord(value, observe);
	callback(record);
	return record.small;
}
function readBeforeFieldWrite(value, callback) {
	const record = makeBoundedRecord(value, observe);
	const small = record.small;
	const label = record.label;
	record.small = "changed";
	callback(record);
	return `${small % 10}:${label}`;
}
function readStringBeforeEscape(value, callback) {
	const record = makeRecord(value, observe);
	const label = record.label;
	record.label = 0;
	callback(record);
	return label + ":";
}
function readSiblingWritten(value, callback) {
	const record = makeBoundedRecord(value, observe);
	record.signed = "changed";
	callback();
	return record.small % 10;
}
function readCompatibleWritten(value, flag, callback) {
	const record = makeBoundedRecord(value, observe);
	if (flag) record.small = value & 15;
	callback();
	return record.small % 10;
}
function readWidenedWritten(value, callback) {
	const record = new makeBoundedRecord(...[value, observe]);
	record.small = value >>> 0;
	callback();
	return record.small;
}
function readNegativeZeroWritten(value, flag, callback) {
	const record = makeBoundedRecord(value, observe);
	if (flag) record.small = -0;
	callback();
	return record.small;
}
function readWrittenLoop(value, steps, callback) {
	const record = makeBoundedRecord(value, observe);
	for (let step = 0; step < steps; step++) record.small = (record.small + 1) & 255;
	callback();
	return record.small % 10;
}
function readCoerciveWritten(value, callback) {
	const record = makeBoundedRecord(0, observe);
	record.small = +value;
	callback();
	return record.small + 1;
}
function readWrittenString(value, callback) {
	const record = makeBoundedRecord(0, observe);
	record.small = value + ":";
	const saved = record.small;
	callback();
	return saved + ":";
}
const makeUnknownRecord = function makeUnknownRecord(value, flag, callback) {
	for (let step = 0; step < 3; step++) callback(step);
	return flag
		? { value, "": value, "\ud800": value }
		: { "\ud800": value, "": value, value };
};
function readUnknownRecord(value, flag, callback) {
	const record = makeUnknownRecord(value, flag, callback);
	callback();
	const named = record.value;
	const empty = record[""];
	const surrogate = record["\ud800"];
	callback();
	return (
		Object.is(named, value) && Object.is(empty, value) && Object.is(surrogate, value)
	);
}
const makeProducerWritten = function makeProducerWritten(value, flag, callback) {
	const record = flag
		? { small: 0, label: "producer-left" }
		: { small: 1, label: "producer-right" };
	for (let step = 0; step < 3; step++) callback(step);
	record.small = value & 255;
	callback("producer written");
	return record;
};
const makeProducerCoerced = function makeProducerCoerced(value, flag, callback) {
	const record = flag ? { small: 0 } : { small: 1 };
	for (let step = 0; step < 3; step++) callback(step);
	record.small = +value;
	callback("producer coerced");
	return record;
};
const makeForwardedWritten = function makeForwardedWritten(value, flag, callback) {
	const record = makeProducerWritten(value, flag, callback);
	callback(new.target);
	if (flag) record.small = value & 1023;
	return record;
};
function readForwardedWritten(value, flag, callback) {
	const record = makeForwardedWritten(value, flag, callback);
	callback("forwarded consumer");
	return record.small % 10;
}
const makeForwardedMixed = function makeForwardedMixed(value, flag, callback) {
	const record = makeProducerWritten(value, flag, callback);
	callback(new.target);
	if (flag) record.small = value + ":";
	return record;
};
function readForwardedMixed(value, flag, callback) {
	const record = makeForwardedMixed(value, flag, callback);
	const saved = record.small;
	callback("forwarded saved heap value");
	return saved;
}
const makeProducerString = function makeProducerString(value, flag, callback) {
	const record = flag ? { text: "left" } : { text: "right" };
	for (let step = 0; step < 3; step++) callback(step);
	record.text = value + ":";
	callback("producer String");
	return record;
};
function readProducerWritten(value, flag, callback) {
	const record = makeProducerWritten(value, flag, callback);
	callback("consumer written");
	return record.small % 10;
}
function readProducerConstructed(value, flag, callback) {
	const record = new makeProducerWritten(...[value, flag, callback]);
	callback("constructed producer");
	return record.small % 10;
}
function readProducerCoerced(value, flag, callback) {
	const record = makeProducerCoerced(value, flag, callback);
	callback("consumer coerced");
	return record.small;
}
function readProducerString(value, flag, callback) {
	const record = makeProducerString(value, flag, callback);
	callback("consumer String");
	return record.text + ":";
}
const makeProducerMissing = function makeProducerMissing(callback) {
	const record = { small: 1 };
	for (let step = 0; step < 3; step++) callback(step);
	record.recordProducerSetterProbe = 2;
	return record;
};
function readProducerMissing(callback) {
	return typeof makeProducerMissing(callback).small;
}
function* producerSuspended(value, flag, callback) {
	const record = makeProducerWritten(value, flag, callback);
	yield record.label;
	callback("producer resume");
	return record.small % 10;
}
async function producerAwaited(value, flag, callback) {
	const record = makeProducerWritten(value, flag, callback);
	await 0;
	callback("producer await");
	return record.small % 10;
}
async function* producerAsyncSuspended(value, flag, callback) {
	const record = makeProducerWritten(value, flag, callback);
	yield record.label;
	await 0;
	callback("producer async resume");
	return record.small % 10;
}
function readBeforeRecordGetter(value) {
	const record = makeBoundedRecord(value, observe);
	const small = record.small;
	record.recordFieldPointProbe;
	return small % 10;
}
function readAfterInheritedWrite(value) {
	const record = makeBoundedRecord(value, observe);
	record.recordFieldSetterProbe = 1;
	return typeof record.small;
}
function readEscapedLoop(value, callback) {
	const record = makeBoundedRecord(value, observe);
	let last;
	for (let step = 0; step < 2; step++) {
		last = record.small;
		callback(record, step);
	}
	return last;
}
function readFreshLoop(value, callback) {
	let total = 0;
	for (let step = 0; step < 2; step++) {
		const record = makeBoundedRecord(value, observe);
		const small = record.small;
		callback(record, step);
		total += small % 10;
	}
	return total;
}
function* boundedSuspended(value, callback) {
	const record = makeBoundedRecord(value, callback);
	yield record.label;
	callback("bounded resume");
	return record.signed % 10;
}
function* writtenSuspended(value, flag, callback) {
	const record = makeBoundedRecord(value, observe);
	if (flag) record.small = value & 15;
	yield record.label;
	callback();
	return record.small % 10;
}
async function writtenAwaited(value, flag, callback) {
	const record = makeBoundedRecord(value, observe);
	if (flag) record.small = value & 15;
	await 0;
	callback();
	return record.small % 10;
}
function* pointSuspended(value, callback) {
	const record = makeBoundedRecord(value, observe);
	const small = record.small;
	record.small = "changed";
	yield record.label;
	callback(record);
	return small % 10;
}
async function boundedAwaited(value, callback) {
	const record = makeBoundedRecord(value, callback);
	await 0;
	callback("bounded await");
	return record.small % 10;
}
async function* boundedAsyncSuspended(value, callback) {
	const record = makeBoundedRecord(value, callback);
	yield record.label;
	await 0;
	callback("bounded async resume");
	return record.unsigned % 10;
}
Object.assign(globalThis, {
	readBounded,
	makeUnknownRecord,
	readUnknownRecord,
	readConditionalRecord,
	readLoopRecord,
	readBoundedUnsigned,
	readBoundedEscaped,
	readBeforeFieldWrite,
	readStringBeforeEscape,
	readSiblingWritten,
	readCompatibleWritten,
	readWidenedWritten,
	readNegativeZeroWritten,
	readWrittenLoop,
	readCoerciveWritten,
	readWrittenString,
	readProducerWritten,
	readProducerConstructed,
	readProducerCoerced,
	makeForwardedWritten,
	readForwardedWritten,
	makeForwardedMixed,
	readForwardedMixed,
	readProducerString,
	readProducerMissing,
	producerSuspended,
	producerAwaited,
	producerAsyncSuspended,
	readBeforeRecordGetter,
	readAfterInheritedWrite,
	readEscapedLoop,
	readFreshLoop,
	boundedSuspended,
	writtenSuspended,
	writtenAwaited,
	pointSuspended,
	boundedAwaited,
	boundedAsyncSuspended,
});
for (const value of [
	undefined,
	null,
	-0,
	NaN,
	3n,
	Symbol("own"),
	"retained",
	{ own: 1 },
]) {
	for (const flag of [false, true])
		check(readUnknownRecord(value, flag, observe), true, "unknown own data field");
}
for (const value of [
	-0,
	0,
	-1,
	-10,
	-2147483648,
	NaN,
	Infinity,
	-Infinity,
	2147483647,
	2147483648,
	4294967295,
	4294967296,
	9007199254740991,
]) {
	for (const flag of [false, true]) {
		check(
			readForwardedMixed(value, flag, observe),
			flag ? value + ":" : value & 255,
			"forwarded mixed heap field",
		);
		check(
			readForwardedWritten(value, flag, observe),
			(value & (flag ? 1023 : 255)) % 10,
			"forwarded written bounds",
		);
		check(
			readProducerConstructed(value, flag, observe),
			(value & 255) % 10,
			"constructed producer bounds",
		);
		check(
			readProducerWritten(value, flag, observe),
			(value & 255) % 10,
			"producer written bounds",
		);
		check(readProducerCoerced(value, flag, observe), value, "producer coerced Number");
	}
	check(readBounded(value, observe), (value & 255) % 10, "bounded field remainder");
	check(readBoundedUnsigned(value, observe), value >>> 0, "unsigned field value");
	for (const flag of [false, true]) {
		check(
			readCompatibleWritten(value, flag, observe),
			(value & (flag ? 15 : 255)) % 10,
			"compatible field write bounds",
		);
		check(
			readNegativeZeroWritten(value, flag, observe),
			flag ? -0 : value & 255,
			"negative zero widens stored field",
		);
		const written = writtenSuspended(value, flag, observe);
		check(written.next().value, "bounded", "written field suspension");
		observe("written between");
		check(
			written.next().value,
			(value & (flag ? 15 : 255)) % 10,
			"written field after suspension",
		);
		check(
			readConditionalRecord(value, flag, (record) => {
				record.small = "changed";
				record.label = null;
				observe("conditional record");
			}),
			`${flag ? "narrow" : "wide"}:${(value & (flag ? 15 : 255)) % 10}`,
			"conditional object return retains common fields",
		);
		check(
			readLoopRecord(value, flag ? 2 : 0, (record) => {
				record.small = "changed";
				record.label = null;
				observe("loop record");
			}),
			`${flag ? "loop" : "initial"}:${(value & (flag ? 255 : 15)) % 10}`,
			"loop object return joins entry and backedge fields",
		);
	}
	check(readWidenedWritten(value, observe), value >>> 0, "widened field bounds");
	check(
		readWrittenLoop(value, 2, observe),
		(((value & 255) + 2) & 255) % 10,
		"loop field writes",
	);
	check(
		readBeforeFieldWrite(value, (record) => {
			observe("field write");
			record.label = "observed";
		}),
		`${(value & 255) % 10}:bounded`,
		"initial fields before mutation and escape",
	);
	check(
		readSiblingWritten(value, observe),
		(value & 255) % 10,
		"unmodified sibling field",
	);
	check(
		readStringBeforeEscape(value, (record) => {
			record.label = null;
			observe("saved heap string");
		}),
		"xx:",
		"saved String field survives mutation and GC",
	);
	const iterator = boundedSuspended(value, observe);
	check(iterator.next().value, "bounded", "bounded suspended heap field");
	observe("bounded between");
	check(iterator.next().value, (value | 0) % 10, "signed suspended field remainder");
	const pointIterator = pointSuspended(value, (record) => {
		record.label = "observed";
		observe("point resume");
	});
	check(pointIterator.next().value, "bounded", "initial field read precedes suspension");
	observe("point between");
	check(
		pointIterator.next().value,
		(value & 255) % 10,
		"initial field interval survives suspension and mutation",
	);
}
let writtenCoercions = 0;
check(
	readCoerciveWritten(
		{
			valueOf() {
				writtenCoercions++;
				observe("written coercion");
				return 7;
			},
		},
		observe,
	),
	8,
	"coercive field write value",
);
check(writtenCoercions, 1, "single coercive field write");
const writtenFailure = {};
let writtenCallback = false;
try {
	readCoerciveWritten(
		{
			valueOf() {
				throw writtenFailure;
			},
		},
		() => {
			writtenCallback = true;
		},
	);
	throw new Error("missing field conversion failure");
} catch (error) {
	check(error, writtenFailure, "field conversion throw identity");
}
check(writtenCallback, false, "throwing field conversion precedes callback");
check(readWrittenString("retained", observe), "retained::", "stored String survives GC");
for (const flag of [false, true]) {
	check(
		readProducerString("retained", flag, observe),
		"retained::",
		"producer String survives GC",
	);
	const iterator = producerSuspended(255, flag, observe);
	check(
		iterator.next().value,
		flag ? "producer-left" : "producer-right",
		"producer suspended String",
	);
	observe("producer between");
	check(iterator.next().value, 5, "producer suspended field");
}
events.length = 0;
let producerCoercions = 0;
check(
	readProducerCoerced(
		{
			valueOf() {
				producerCoercions++;
				observe("producer convert");
				return -0;
			},
		},
		false,
		observe,
	),
	-0,
	"producer conversion preserves negative zero",
);
check(producerCoercions, 1, "single producer conversion");
check(
	JSON.stringify(events),
	'[0,1,2,"producer convert","producer coerced","consumer coerced"]',
	"producer conversion order",
);
events.length = 0;
const producerFailure = { marker: "producer conversion" };
try {
	readProducerCoerced(
		{
			valueOf() {
				observe("producer throw");
				throw producerFailure;
			},
		},
		true,
		observe,
	);
	throw new Error("missing producer conversion exception");
} catch (error) {
	check(error, producerFailure, "producer exception identity");
}
check(JSON.stringify(events), '[0,1,2,"producer throw"]', "producer exception order");
const keptPointRecords = [];
check(
	readEscapedLoop(3, (record) => {
		observe("loop escape");
		record.small = "loop";
	}),
	"loop",
	"backedge sees escaped mutation",
);
check(
	readFreshLoop(3, (record, step) => {
		keptPointRecords.push(record);
		record.small = `step${step}`;
		observe("fresh loop escape");
	}),
	6,
	"fresh records reset the initial field proof",
);
observe("retained point records");
check(keptPointRecords[0] === keptPointRecords[1], false, "fresh loop object identity");
check(keptPointRecords[0].small, "step0", "first retained loop object");
check(keptPointRecords[1].small, "step1", "second retained loop object");
if (Object.isExtensible(Object.prototype)) {
	Object.defineProperty(Object.prototype, "recordProducerSetterProbe", {
		configurable: true,
		set(value) {
			observe(value);
			this.small = "producer setter";
		},
	});
	try {
		check(
			readProducerMissing(observe),
			"string",
			"producer missing field can invoke setter",
		);
	} finally {
		delete Object.prototype.recordProducerSetterProbe;
	}
	Object.defineProperty(Object.prototype, "recordFieldPointProbe", {
		configurable: true,
		get() {
			observe("point getter");
			this.small = "getter";
			return 0;
		},
	});
	Object.defineProperty(Object.prototype, "recordFieldSetterProbe", {
		configurable: true,
		set(value) {
			observe(value);
			this.small = "setter";
		},
	});
	try {
		check(readBeforeRecordGetter(3), 3, "initial value precedes prototype getter");
		check(
			readAfterInheritedWrite(3),
			"string",
			"inherited setter invalidates later reads",
		);
	} finally {
		delete Object.prototype.recordFieldPointProbe;
		delete Object.prototype.recordFieldSetterProbe;
	}
}
check(
	readBoundedEscaped(-1, (record) => {
		observe("bounded escape");
		record.small = "changed";
	}),
	"changed",
	"escaped bounded field mutation",
);
let boundedCoercions = 0;
check(
	readBounded(
		{
			valueOf() {
				boundedCoercions++;
				observe("bounded coerce");
				return 4294967295;
			},
		},
		observe,
	),
	5,
	"coerced bounded field",
);
check(boundedCoercions, 3, "bounded field coercion order");
for (const value of [1n, Symbol("bounded")]) {
	let error;
	try {
		readBounded(value, observe);
	} catch (caught) {
		error = caught;
	}
	check(error instanceof TypeError, true, "bounded field abrupt coercion");
}
const boundedAsync = boundedAsyncSuspended(4294967295, observe);
const boundedAsyncSteps = boundedAsync
	.next()
	.then((result) => {
		check(result.value, "bounded", "bounded async heap field");
		observe("bounded async between");
		return boundedAsync.next();
	})
	.then((result) => {
		check(result.done, true, "bounded async completion");
		check(result.value, 5, "bounded async unsigned remainder");
	});
const iterator = readSuspended(3, observe);
check(iterator.next().value, "xx", "suspended heap field");
observe("between");
const completed = iterator.next();
check(completed.done, true, "generator completion");
check(completed.value, true, "generator field observation");
const asyncIterator = readAsyncSuspended(3, observe);
const producerAsync = producerAsyncSuspended(255, true, observe);
const producerAsyncSteps = producerAsync
	.next()
	.then((result) => {
		check(result.value, "producer-left", "producer async suspended String");
		observe("producer async between");
		return producerAsync.next();
	})
	.then((result) => {
		check(result.done, true, "producer async completion");
		check(result.value, 5, "producer async field");
	});
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
const mergedRecursive = function mergedRecursive(value, depth, callback) {
	if (depth > 0) {
		const left = mergedRecursive(value, depth - 1, callback);
		const right = mergedRecursive(value, depth - 2, callback);
		const record = value ? left : right;
		record.n = record.n + 1;
		return record;
	}
	for (let i = 0; i < 3; i++) callback(i);
	return { n: value | 0, stable: value & 15 };
};
function readMergedRecursive(value, callback) {
	const record = mergedRecursive(value, 4, callback);
	callback("merged recursive");
	return typeof record.n === "number";
}
function readMergedNumber(value, flag, callback) {
	const left = makeRecord(value, callback);
	const right = makeRecord(value, callback);
	const record = flag ? left : right;
	if (flag) record.n = +value;
	callback("merged number");
	return typeof record.n === "number";
}
function readMergedString(value, flag, callback) {
	const left = makeRecord(value, callback);
	const right = makeString(value, callback);
	const record = flag ? left : right;
	callback("merged string");
	return record.label + ":";
}
function readMergedEscaped(value, flag, callback) {
	const left = makeRecord(value, observe);
	const right = makeRecord(value, observe);
	callback(left);
	const record = flag ? left : right;
	return typeof record.n;
}
function readMergedUnknown(value, flag) {
	const left = makeRecord(1, observe);
	const record = flag ? left : value;
	return record.n;
}
const makeMergedMissing = function makeMergedMissing(callback) {
	for (let i = 0; i < 3; i++) callback(i);
	return { __proto__: mergedPrototype, other: 1 };
};
function readMergedInherited(value, flag, callback) {
	const left = makeRecord(value, callback);
	const right = makeMergedMissing(callback);
	const record = flag ? left : right;
	record.n = value;
	callback("merged inherited");
	return typeof record.n;
}
function readMergedHeap(value, flag, callback) {
	const left = makeUnknownRecord(value, flag, callback);
	const right = makeUnknownRecord(value, !flag, callback);
	const record = flag ? left : right;
	const saved = record.value;
	callback("merged heap");
	return Object.is(saved, value);
}
function* readMergedSuspended(value, flag, callback) {
	const left = makeRecord(value, callback);
	const right = makeRecord(value, callback);
	const record = flag ? left : right;
	yield record.label;
	callback("merged resume");
	return record.n;
}
Object.assign(globalThis, {
	readMergedNumber,
	readMergedRecursive,
	readMergedString,
	readMergedEscaped,
	readMergedUnknown,
	readMergedInherited,
	readMergedHeap,
	readMergedSuspended,
});
for (const flag of [false, true]) {
	check(
		readMergedHeap({ marker: "heap".repeat(100) }, flag, observe),
		true,
		"unknown merged payload stays rooted",
	);
	check(readMergedNumber(7, flag, observe), true, "merged Number normal field");
	check(readMergedRecursive(7, observe), true, "recursive merged field stays Number");
	check(readMergedString(7, flag, observe), "xx:", "merged String concatenation");
	check(
		readMergedEscaped(7, flag, (record) => {
			record.n = "changed";
			observe("merged escape");
		}),
		flag ? "string" : "number",
		"merged escape invalidates field facts",
	);
	const iterator = readMergedSuspended(7, flag, observe);
	check(iterator.next().value, "xx", "merged field before yield");
	observe("merged suspended");
	check(iterator.next().value, 7, "merged field after resume");
}
let mergedGets = 0;
const mergedExotic = new Proxy(
	{},
	{
		get(target, key) {
			mergedGets++;
			observe("merged trap");
			return key === "n" ? "exotic" : undefined;
		},
	},
);
check(
	readMergedUnknown(mergedExotic, false),
	"exotic",
	"unknown merged source retains proxy get",
);
check(mergedGets, 1, "merged proxy getter executes exactly once");
check(
	readMergedUnknown(mergedExotic, true),
	1,
	"private branch of unknown merged source",
);
let mergedSetters = 0;
let mergedSetterTarget;
const mergedPrototype = {
	get n() {
		observe("merged inherited get");
		return "inherited";
	},
	set n(value) {
		mergedSetters++;
		mergedSetterTarget = this;
		observe(value);
	},
};
{
	check(
		readMergedInherited(7, true, observe),
		"number",
		"merged own write bypasses an inherited setter",
	);
	check(mergedSetters, 0, "own branch does not invoke setter");
	check(
		readMergedInherited(7, false, observe),
		"string",
		"missing merged key retains inherited access",
	);
	check(mergedSetters, 1, "missing branch invokes setter once");
	check(
		mergedSetterTarget.other,
		1,
		"inherited setter receives the actual merged source",
	);
}
const makeWritableRecord = function makeWritableRecord(flag, callback) {
	for (let step = 0; step < 3; step++) callback(step);
	return flag ? { value: undefined, tag: 0 } : { tag: 1, value: undefined };
};
const makeOverwriteRecord = function makeOverwriteRecord(value, callback) {
	for (let step = 0; step < 3; step++) callback(step);
	return { value };
};
const makeProducerOverwrite = function makeProducerOverwrite(input, flag, callback) {
	for (let step = 0; step < 3; step++) callback(step);
	const record = { value: callback("producer initializer"), stable: "stable" };
	record.value = "older";
	if (flag) record.value = input & 15;
	else record.value = input & 255;
	return record;
};
const forwardProducerOverwrite = function forwardProducerOverwrite(input, callback) {
	for (let step = 0; step < 3; step++) callback(step);
	const record = makeOverwriteRecord(input, callback);
	record.value = "older";
	record.value = input & 255;
	return record;
};
function readProducerOverwrite(input, flag, callback) {
	const record = makeProducerOverwrite(input, flag, callback);
	callback("producer read");
	return record.value % 10;
}
function readProducerForwardOverwrite(input, callback) {
	const record = forwardProducerOverwrite(input, callback);
	callback("forward producer read");
	return record.value % 10;
}
const makeProducerEarly = function makeProducerEarly(input, flag, callback) {
	for (let step = 0; step < 3; step++) callback(step);
	const record = { value: input };
	if (flag) return record;
	record.value = input & 255;
	return record;
};
function readProducerEarly(input, flag, callback) {
	const record = makeProducerEarly(input, flag, callback);
	callback("early producer read");
	return record.value % 10;
}
const makeProducerCaught = function makeProducerCaught(input, callback) {
	for (let step = 0; step < 3; step++) callback(step);
	const record = { value: "initial" };
	try {
		record.value = input & 255;
	} catch (error) {
		callback("caught producer write");
	}
	return record;
};
function readProducerCaught(input, callback) {
	const record = makeProducerCaught(input, callback);
	callback("caught producer read");
	return record.value % 10;
}
function readCallerCaught(input, callback) {
	const record = makeOverwriteRecord("initial", callback);
	try {
		record.value = input & 255;
	} catch (error) {
		callback("caught caller write");
	}
	callback("caught caller read");
	return record.value % 10;
}
function* readSuspendedCaught(input, callback) {
	const record = makeOverwriteRecord("initial", callback);
	try {
		yield 0;
		record.value = input & 255;
	} catch (error) {
		callback("caught suspended write");
	}
	return record.value % 10;
}
function readDefiniteRecord(input, flag, callback) {
	const record = flag
		? makeOverwriteRecord(input, callback)
		: makeOverwriteRecord(flag, callback);
	record.value = "older";
	record.value = input & 255;
	callback("definite overwrite");
	return record.value % 10;
}
const makeSelectedBounded = function makeSelectedBounded(callback) {
	for (let step = 0; step < 3; step++) callback(step);
	return { value: 7 };
};
function readSelectedInitial(input, flag, callback) {
	const left = makeSelectedBounded(callback);
	const right = makeOverwriteRecord(input, callback);
	right.value = input & 255;
	const record = flag ? left : right;
	callback("selected initializer");
	return record.value % 10;
}
function* selectedInitialSuspended(input, flag, callback) {
	const left = makeSelectedBounded(callback);
	const right = makeOverwriteRecord(input, callback);
	const record = flag ? left : right;
	right.value = "older";
	right.value = input & 255;
	yield record.value;
	callback("selected resume");
	return record.value % 10;
}
function readSelectedCaught(input, flag, callback) {
	const left = makeSelectedBounded(callback);
	const right = makeOverwriteRecord(input, callback);
	const record = flag ? left : right;
	try {
		right.value = input & 255;
	} catch (error) {
		callback("caught selected overwrite");
	}
	callback("selected caught read");
	return record.value % 10;
}
function readCorrelatedAfter(input, flag, callback) {
	const left = makeSelectedBounded(callback);
	const right = makeOverwriteRecord(input, callback);
	const record = flag ? left : right;
	right.value = "older";
	right.value = input & 255;
	callback("correlated after merge");
	return record.value % 10;
}
function readCorrelatedOpposite(payload, flag, callback) {
	const left = makeSelectedBounded(callback);
	const right = makeSelectedBounded(callback);
	let record;
	let other;
	if (flag) {
		record = left;
		other = right;
	} else {
		record = right;
		other = left;
	}
	other.value = payload;
	const result = record.value % 10;
	callback(other.value);
	return result;
}
function readCorrelatedLoop(callback) {
	let record = makeSelectedBounded(callback);
	let result = 0;
	for (let i = 0; i < 3; i++) {
		const next = makeSelectedBounded(callback);
		next.value = "new";
		result = record.value % 10;
		record = next;
	}
	return result;
}
function readDefiniteCoercion(input, callback) {
	const record = makeOverwriteRecord(input, observe);
	record.value = { valueOf: callback };
	return record.value % 10;
}
function writeOwnRecord(value, flag, callback) {
	const first = makeWritableRecord(flag, callback);
	const record = flag ? first : makeWritableRecord(flag, callback);
	record.value = value;
	callback("stored");
	return record;
}
function* writeOwnSuspended(value, callback) {
	const record = makeWritableRecord(true, callback);
	yield 0;
	record.value = value;
	callback("stored after yield");
	return record;
}
async function writeOwnAwaited(value, callback) {
	const record = makeWritableRecord(false, callback);
	await 0;
	record.value = value;
	callback("stored after await");
	return record;
}
async function* writeOwnAsyncSuspended(value, callback) {
	const record = makeWritableRecord(true, callback);
	yield 0;
	await 0;
	record.value = value;
	callback("stored after async yield");
	return record;
}
function writeEscapedRecord(value, callback) {
	const record = makeWritableRecord(true, observe);
	record.value = 1;
	callback(record);
	record.value = value;
	return record;
}
function writeComputedRecord(key, value, callback) {
	const record = makeWritableRecord(true, callback);
	record[key] = value;
	return record;
}
function writeUnknownReturned(factory, value) {
	const record = factory();
	record.value = value;
	return record;
}
Object.assign(globalThis, {
	readDefiniteRecord,
	readDefiniteCoercion,
	readProducerOverwrite,
	readProducerForwardOverwrite,
	readProducerEarly,
	readProducerCaught,
	readCallerCaught,
	readSuspendedCaught,
	writeOwnRecord,
	writeOwnSuspended,
	writeOwnAwaited,
	writeOwnAsyncSuspended,
	writeEscapedRecord,
	writeComputedRecord,
	writeUnknownReturned,
});
const storedHeap = { label: "stored heap value", nested: { live: true } };
for (const input of [
	-0,
	NaN,
	Infinity,
	-Infinity,
	-1,
	255,
	256,
	2147483648,
	4294967295,
]) {
	for (const flag of [false, true])
		check(
			readProducerOverwrite(input, flag, observe),
			(input & (flag ? 15 : 255)) % 10,
			"producer final field overwrite",
		);
	check(
		readProducerForwardOverwrite(input, observe),
		(input & 255) % 10,
		"forwarded final field overwrite",
	);
}
const producerSequence = [];
let finalProducerCoercions = 0;
const producerInput = {
	valueOf() {
		finalProducerCoercions++;
		producerSequence.push("coerce");
		observe("producer coerce");
		return 511;
	},
};
check(
	readProducerOverwrite(producerInput, true, (stage) => {
		producerSequence.push(stage);
		observe(stage);
		return {};
	}),
	5,
	"producer input coerced after initialization",
);
check(
	JSON.stringify(producerSequence),
	'[0,1,2,"producer initializer","coerce","producer read"]',
	"producer initializer and writer order",
);
check(finalProducerCoercions, 1, "producer input coerced once");
const finalProducerFailure = { marker: "producer initializer failure" };
try {
	readProducerOverwrite(producerInput, true, (stage) => {
		observe(stage);
		if (stage === "producer initializer") throw finalProducerFailure;
	});
	throw new Error("missing producer initializer exception");
} catch (error) {
	check(error, finalProducerFailure, "producer initializer exception identity");
}
check(finalProducerCoercions, 1, "abrupt initializer prevents writer coercion");
let earlyCoercions = 0;
check(
	readProducerEarly(
		{
			valueOf() {
				earlyCoercions++;
				observe("early producer coerce");
				return -0;
			},
		},
		true,
		observe,
	),
	-0,
	"early return retains original payload",
);
check(earlyCoercions, 1, "early-return payload coerced once");
check(readProducerCaught(255, observe), 5, "normal producer write reaches return");
check(readCallerCaught(255, observe), 5, "normal caller write reaches read");
const abruptStoreIterator = readSuspendedCaught(255, observe);
check(abruptStoreIterator.next().value, 0, "suspend before caller store");
observe("suspended exception");
const abruptStoreResult = abruptStoreIterator.throw({ marker: "injected throw" });
check(abruptStoreResult.done, true, "injected throw completes caught generator");
check(abruptStoreResult.value, NaN, "abrupt resume retains the initial payload");
const normalStoreIterator = readSuspendedCaught(255, observe);
normalStoreIterator.next();
check(normalStoreIterator.next().value, 5, "normal resume observes the completed store");
for (const input of [1n, Symbol("producer overwrite")]) {
	check(
		readProducerCaught(input, observe),
		NaN,
		"caught write retains the initial payload",
	);
	check(
		readCallerCaught(input, observe),
		NaN,
		"caught caller write retains the initial payload",
	);
	let failure;
	try {
		readProducerOverwrite(input, true, observe);
	} catch (error) {
		failure = error;
	}
	check(failure instanceof TypeError, true, "producer writer coercion error");
}
for (const flag of [false, true]) {
	for (const input of [
		-0,
		NaN,
		Infinity,
		-Infinity,
		-1,
		255,
		256,
		2147483648,
		4294967295,
	])
		check(
			readDefiniteRecord(input, flag, observe),
			(input & 255) % 10,
			"definite masked overwrite",
		);
}
let overwriteCoercions = 0;
for (const flag of [false, true]) {
	for (const input of [-0, NaN, Infinity, -1, 0, 255, 256, 4294967295]) {
		const expected = flag ? 7 : input & 255;
		check(
			readSelectedInitial(input, flag, observe),
			expected % 10,
			"selected initial source",
		);
		check(
			readCorrelatedAfter(input, flag, observe),
			expected % 10,
			"source-specific store after receiver merge",
		);
		const suspended = selectedInitialSuspended(input, flag, observe);
		check(suspended.next().value, expected, "selected field before suspension");
		observe("selected suspended");
		check(suspended.next().value, expected % 10, "selected field after suspension");
	}
	const payload = { marker: "opposite record payload" };
	let observedPayload = false;
	check(
		readCorrelatedOpposite(payload, flag, (value) => {
			observe(value);
			if (value === payload) {
				observedPayload = true;
				check(
					value.marker,
					"opposite record payload",
					"disjoint store survives collection",
				);
			}
		}),
		7,
		"opposite receiver does not overwrite the selected record",
	);
	check(observedPayload, true, "excluded writer remains observable");
}
check(readCorrelatedLoop(observe), NaN, "earlier loop allocation retains String payload");
let selectedCoercions = 0;
const selectedInput = {
	valueOf() {
		selectedCoercions++;
		observe("selected coercion");
		return 511;
	},
};
check(readSelectedInitial(selectedInput, false, observe), 5, "selected input coercion");
check(selectedCoercions, 1, "selected overwrite coerces once");
let selectedCaughtCoercions = 0;
const selectedCaughtInput = {
	valueOf() {
		selectedCaughtCoercions++;
		observe("selected caught coercion");
		if (selectedCaughtCoercions === 1) throw new Error("selected RHS");
		return 9;
	},
};
check(
	readSelectedCaught(selectedCaughtInput, false, observe),
	9,
	"caught selected heap payload",
);
check(selectedCaughtCoercions, 2, "caught overwrite retains earlier payload");
for (const input of [Symbol("selected"), 1n]) {
	try {
		readSelectedInitial(input, false, observe);
		throw new Error("missing selected overwrite error");
	} catch (error) {
		check(error instanceof TypeError, true, "selected overwrite preserves type error");
	}
}
check(
	readDefiniteRecord(
		{
			valueOf() {
				overwriteCoercions++;
				observe("overwrite input");
				return 511;
			},
		},
		true,
		observe,
	),
	5,
	"definite write input coercion",
);
check(overwriteCoercions, 1, "definite write coerces input once");
check(
	readDefiniteCoercion(storedHeap, () => {
		overwriteCoercions++;
		observe("stored coercion");
		return -0;
	}),
	-0,
	"stored object retains negative-zero coercion",
);
check(overwriteCoercions, 2, "stored object coerced once");
const overwriteFailure = { marker: "overwrite coercion failure" };
try {
	readDefiniteCoercion(storedHeap, () => {
		observe("stored throw");
		throw overwriteFailure;
	});
	throw new Error("missing stored coercion exception");
} catch (error) {
	check(error, overwriteFailure, "stored coercion exception identity");
}
for (const input of [1n, Symbol("overwrite")]) {
	let failure;
	try {
		readDefiniteRecord(input, true, observe);
	} catch (error) {
		failure = error;
	}
	check(failure instanceof TypeError, true, "definite input coercion error");
}
for (let round = 0; round < 3; round++) {
	for (const input of [
		undefined,
		null,
		false,
		-0,
		NaN,
		1n,
		Symbol("stored"),
		"stored",
		storedHeap,
	]) {
		const record = writeOwnRecord(input, (round & 1) === 0, observe);
		observe("returned store");
		check(record.value, input, "own overwrite preserves payload identity");
	}
}
const ownIterator = writeOwnSuspended(storedHeap, observe);
check(ownIterator.next().value, 0, "own store yield");
observe("suspended own store");
const ownCompleted = ownIterator.next();
check(ownCompleted.done, true, "own store generator completion");
check(ownCompleted.value.value, storedHeap, "own store after yield");
const ownAsyncIterator = writeOwnAsyncSuspended(storedHeap, observe);
const ownAsyncSteps = ownAsyncIterator.next().then((step) => {
	check(step.value, 0, "own store async yield");
	observe("async suspended own store");
	return ownAsyncIterator.next().then((result) => {
		check(result.done, true, "own store async completion");
		check(result.value.value, storedHeap, "own store after async yield");
	});
});
for (const mutate of [
	(record) => Object.freeze(record),
	(record) => Object.defineProperty(record, "value", { writable: false }),
]) {
	let caught;
	try {
		writeEscapedRecord(2, mutate);
	} catch (error) {
		caught = error;
	}
	check(caught instanceof TypeError, true, "escaped nonwritable store throws");
}
const storeFailure = { marker: "store failure" };
let setterCalls = 0;
try {
	writeEscapedRecord(2, (record) => {
		Object.defineProperty(record, "value", {
			set(value) {
				setterCalls++;
				check(value, 2, "escaped setter value");
				throw storeFailure;
			},
		});
	});
	throw new Error("missing setter exception");
} catch (error) {
	check(error, storeFailure, "escaped setter exception identity");
}
check(setterCalls, 1, "escaped setter called once");
let storeKeyCoercions = 0;
check(
	writeComputedRecord(
		{
			toString() {
				storeKeyCoercions++;
				observe("store key");
				return "value";
			},
		},
		storedHeap,
		observe,
	).value,
	storedHeap,
	"computed store value",
);
check(storeKeyCoercions, 1, "store key coerced once");
check(
	writeComputedRecord(0, storedHeap, observe)[0],
	storedHeap,
	"indexed store fallback",
);
let storeTraps = 0;
const storeProxy = new Proxy(
	{},
	{
		set(target, key, value) {
			storeTraps++;
			observe("store trap");
			if (value === storeFailure) throw storeFailure;
			target[key] = value;
			return true;
		},
	},
);
check(
	writeUnknownReturned(() => storeProxy, storedHeap),
	storeProxy,
	"Proxy store receiver",
);
check(storeProxy.value, storedHeap, "Proxy store payload");
try {
	writeUnknownReturned(() => storeProxy, storeFailure);
	throw new Error("missing Proxy store exception");
} catch (error) {
	check(error, storeFailure, "Proxy store exception identity");
}
check(storeTraps, 2, "Proxy set traps called once per store");
Promise.all([
	writeOwnAwaited(storedHeap, observe).then((record) =>
		check(record.value, storedHeap, "own store after await"),
	),
	ownAsyncSteps,
	producerAwaited(255, false, observe).then((value) =>
		check(value, 5, "producer awaited field"),
	),
	producerAsyncSteps,
	writtenAwaited(255, true, observe).then((value) =>
		check(value, 5, "written awaited field"),
	),
	boundedAwaited(-1, observe).then((value) => check(value, 5, "bounded awaited field")),
	boundedAsyncSteps,
	readAwaited(3, observe).then((result) => {
		check(result, true, "awaited field observation");
	}),
	asyncSteps,
]).then(() => console.log("record-field-kinds PASS"));
