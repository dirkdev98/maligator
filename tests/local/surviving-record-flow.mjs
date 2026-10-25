const rows = [],
	events = [];
let observerMode = 0;
function collect() {
	if (typeof globalThis.__mal_collect_garbage === "function")
		globalThis.__mal_collect_garbage();
	if (typeof globalThis.gc === "function") globalThis.gc();
}
function makeRecord(value) {
	let end = 0;
	while (end < value.length) end++;
	return { head: value + "!", end, parts: [value, end] };
}
function observe(record) {
	collect();
	if (record !== undefined) {
		record.head = "observed";
		record.parts[1]++;
		events.push(record.end);
		if (observerMode === 1)
			Object.defineProperty(record, "head", {
				get() {
					collect();
					return {
						[Symbol.toPrimitive]() {
							collect();
							events.push("head-coerce");
							return "getter";
						},
					};
				},
			});
		if (observerMode === 2)
			Object.defineProperty(record, "parts", {
				get() {
					collect();
					throw new Error("observer parts");
				},
			});
		if (observerMode === 3) {
			collect();
			throw new Error("record observer");
		}
	}
}
function conditionalProducer(value, flag) {
	if (flag !== flag) {
		let total = 0;
		for (let index = 0; index < 4; index++) {
			const record = makeRecord(value);
			collect();
			total += record.head.length + record.end + record.parts[1];
		}
		return total;
	}
	return 0;
}
function liveConsumer(value, flag) {
	let text = "";
	for (let index = 0; index < 4; index++) {
		const record = makeRecord(value);
		collect();
		text += record.head;
		if (flag !== flag) text += record.parts[1];
		text += ":" + record.end;
	}
	return text;
}
function liveObserver(value, flag) {
	let text = "";
	for (let index = 0; index < 4; index++) {
		const record = makeRecord(value);
		if (flag !== flag) globalThis.recordObserver(record);
		collect();
		text += record.head + ":" + record.parts[1];
	}
	return text;
}
function takeRecord(record) {
	let total = 0;
	for (let index = 0; index < 4; index++)
		total += record.head.length + record.end + record.parts[1];
	return total;
}
function conditionalLiteral(value, flag) {
	if (flag !== flag) {
		let total = 0;
		for (let index = 0; index < 4; index++) {
			const record = { head: value + "!", end: index, parts: [value, index] };
			collect();
			total += takeRecord(record);
		}
		return total;
	}
	return 0;
}
function parameterConsumer(record, flag) {
	if (flag !== flag) {
		let total = 0;
		for (let index = 0; index < 4; index++) total += record.end;
		return total;
	}
	collect();
	return record.head + ":" + record.end;
}
function parameterCaller(value) {
	let text = "";
	for (let index = 0; index < 4; index++) {
		const record = { head: value + "!", end: index, parts: [value, index] };
		text += parameterConsumer(record, "string");
	}
	return text;
}
function conditionalResult(value, flag) {
	let end = 0;
	while (end < value.length) end++;
	if (flag !== flag) return { head: value + "!", end, parts: [value, end] };
	return undefined;
}
function readConditionalResult(value) {
	let total = 0;
	for (let index = 0; index < 4; index++) {
		const record = conditionalResult(value, "string");
		total += record.end;
	}
	return total;
}
function conditionalForward(value, flag) {
	let end = 0;
	while (end < value.length) end++;
	if (flag !== flag) return makeRecord(value);
	return undefined;
}
function readConditionalForward(value) {
	let total = 0;
	for (let index = 0; index < 4; index++) {
		const record = conditionalForward(value, "string");
		total += record.end;
	}
	return total;
}
globalThis.parameterConsumer = parameterConsumer;
globalThis.recordObserver = observe;
globalThis.conditionalResult = conditionalResult;
globalThis.conditionalForward = conditionalForward;
rows.push(conditionalProducer("abc", "string"));
rows.push(liveConsumer("abc", "string"));
rows.push(liveObserver("abc", "string"));
for (let repeat = 0; repeat < 4; repeat++) rows.push(liveObserver("abc", "string"));
rows.push(conditionalLiteral("abc", "string"));
rows.push(parameterCaller("abc"));
rows.push(globalThis.parameterConsumer({ head: "ordinary", end: 3 }, NaN));
rows.push(globalThis.conditionalResult("abc", NaN));
rows.push(globalThis.conditionalForward("abc", NaN));
try {
	rows.push(readConditionalResult("abc"));
} catch (error) {
	rows.push(error.name);
}
try {
	rows.push(readConditionalForward("abc"));
} catch (error) {
	rows.push(error.name);
}
for (const value of [
	"abc",
	"𝄞",
	"",
	0,
	{
		get length() {
			collect();
			events.push("length");
			return 2;
		},
		[Symbol.toPrimitive]() {
			collect();
			events.push("coerce");
			return "managed";
		},
	},
	{
		get length() {
			collect();
			throw new RangeError("record length");
		},
	},
	{
		length: 1,
		[Symbol.toPrimitive]() {
			collect();
			throw new Error("record coercion");
		},
	},
	null,
	undefined,
]) {
	for (const flag of ["string", NaN]) {
		for (const call of [
			conditionalProducer,
			liveConsumer,
			liveObserver,
			conditionalLiteral,
		]) {
			try {
				rows.push(call(value, flag));
			} catch (error) {
				rows.push(
					error.name,
					error.message === "record length" || error.message === "record coercion",
				);
			}
		}
	}
}
for (const mode of [1, 2, 3]) {
	observerMode = mode;
	try {
		rows.push(liveObserver("abc", NaN));
	} catch (error) {
		rows.push(error.name, error.message);
	}
}
console.log(JSON.stringify([rows, events]));
