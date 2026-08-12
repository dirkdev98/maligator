function projected(value) {
	const fields = value.split("::");
	return fields[0].length * 100 + Number(fields[1].slice(1)) + fields.length;
}

function sparseProjection(value) {
	const fields = value.split("::");
	return (fields[4] === undefined ? 100 : 0) + fields.length;
}

function parsed(value, start) {
	return Number(value.slice(start));
}

const results = [
	projected("ab::x42::"),
	projected("::x7"),
	sparseProjection("a::b"),
	parsed("x  -12.5 ", 1),
	parsed("x0x10", 1),
	parsed("xInfinity", 1),
	Number.isNaN(parsed("xnope", 1)) ? 1 : 0,
];

const originalSplit = String.prototype.split;
let splitCalls = 0;
String.prototype.split = function () {
	splitCalls++;
	return ["patched", "x9"];
};
results.push(projected("ignored"));
String.prototype.split = originalSplit;

const originalSlice = String.prototype.slice;
let sliceCalls = 0;
String.prototype.slice = function () {
	sliceCalls++;
	return "17";
};
results.push(parsed("ignored", 1));
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
	results.join(",") === "245,9,102,-12.5,16,Infinity,1,711,17,23" &&
	splitCalls === 1 &&
	sliceCalls === 1;
console.log(
	`RESULT ${passed ? "PASS" : "FAIL"} ${results.join(",")} ${splitCalls} ${sliceCalls}`,
);
