function projected(value) {
	const fields = value.split("::");
	return fields[0].length * 100 + Number(fields[1].slice(1)) + fields.length;
}

function sparseProjection(value) {
	const fields = value.split("::");
	return (fields[4] === undefined ? 100 : 0) + fields.length;
}

function overflowProjection(value) {
	const fields = value.split("::");
	return (
		fields[0].length * 1_000_000 +
		fields[64].length * 10_000 +
		fields[65].length * 100 +
		fields.length
	);
}

function parsed(value, start) {
	return Number(value.slice(start));
}

function cursor(value, separator) {
	const parts = value.split(separator);
	let total = 0;
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index].trim();
		total += part.length;
	}
	return total;
}

function cursorRevalidates(value, separator, afterElement) {
	const parts = value.split(separator);
	let total = 0;
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index].trim();
		total += part.length;
		afterElement();
	}
	return total;
}

const results = [
	projected("ab::x42::"),
	projected("::x7"),
	sparseProjection("a::b"),
	overflowProjection("a::".repeat(65) + "tail"),
	parsed("x  -12.5 ", 1),
	parsed("x0x10", 1),
	parsed("xInfinity", 1),
	Number.isNaN(parsed("xnope", 1)) ? 1 : 0,
	cursor(" a |b| c |", "|"),
	cursor("", "|"),
	cursor("a|| b", "|"),
	cursor(" a\r\n b \r\n", "\r\n"),
];

let reentrantInput = " ".repeat(32);
for (let index = 0; index < 3; index++) {
	if (index !== 0) reentrantInput += "|";
	reentrantInput += String.fromCharCode(97 + index) + " ".repeat(32);
}

const cursorFailure = new Error("cursor body");
let callbacksBeforeThrow = 0;
try {
	cursorRevalidates(reentrantInput, "|", () => {
		callbacksBeforeThrow++;
		if (callbacksBeforeThrow === 2) throw cursorFailure;
	});
} catch (error) {
	results.push(error === cursorFailure && callbacksBeforeThrow === 2 ? 1 : 0);
}

const originalTrim = String.prototype.trim;
cursorRevalidates(reentrantInput, "|", () => {});
let trimCalls = 0;
let trimPatched = false;
results.push(
	cursorRevalidates(reentrantInput, "|", () => {
		if (trimPatched) return;
		trimPatched = true;
		String.prototype.trim = function () {
			trimCalls++;
			return "xxxx";
		};
	}),
);
results.push(trimCalls);
String.prototype.trim = originalTrim;

const originalSplit = String.prototype.split;
let splitCalls = 0;
String.prototype.split = function () {
	splitCalls++;
	return ["patched", "x9"];
};
results.push(projected("ignored"));
results.push(cursor("ignored", "|"));
String.prototype.split = originalSplit;

const originalSlice = String.prototype.slice;
let sliceCalls = 0;
String.prototype.slice = function () {
	sliceCalls++;
	return "17";
};
results.push(parsed("ignored", 1));
results.push(cursor(" a | b ", "|"));
String.prototype.slice = originalSlice;

results.push(
	parsed(
		{
			slice() {
				return "23";
			},
		},
		1,
	),
);

const passed =
	results.join(",") ===
		"245,9,102,1010466,-12.5,16,Infinity,1,3,0,2,2,1,9,2,711,9,17,2,23" &&
	splitCalls === 2 &&
	sliceCalls === 1;
console.log(
	`RESULT ${passed ? "PASS" : "FAIL"} ${results.join(",")} ${splitCalls} ${sliceCalls}`,
);
