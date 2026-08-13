const checks = [];

function check(name, condition) {
	checks.push([name, condition]);
}

function normalizedLength(regexp, value) {
	const match = regexp.exec(value);
	if (match === null) return -1;
	const normalized = match[1].toUpperCase().toLowerCase();
	return normalized.length;
}

let total = 0;
for (let iteration = 0; iteration < 100; iteration++) {
	total += normalizedLength(/^([A-Za-z]+)$/, "Read");
}
check("hot ASCII capture chain keeps its length", total === 400);
check("empty capture keeps zero length", normalizedLength(/^()$/, "") === 0);
check(
	"long ASCII capture takes the bounded fallback",
	normalizedLength(/^(.+)$/, "A".repeat(65)) === 65,
);

let genericEscape;
function genericLength(value) {
	const upper = value.toUpperCase();
	genericEscape = upper;
	return upper.toLowerCase().length;
}
check(
	"non-ASCII capture preserves the generic case result",
	normalizedLength(/^(.+)$/, "ß") === genericLength("ß") && genericEscape !== undefined,
);

let unmatchedThrew = false;
try {
	normalizedLength(/^(a)?b$/, "b");
} catch (error) {
	unmatchedThrew = error instanceof TypeError;
}
check("unmatched capture preserves its property throw", unmatchedThrew);

const originalLower = String.prototype.toLowerCase;
let lowerGetterCalls = 0;
Object.defineProperty(String.prototype, "toLowerCase", {
	configurable: true,
	get() {
		lowerGetterCalls++;
		return function () {
			return "lowered";
		};
	},
});
check(
	"lower method getter runs at its original fallback point",
	normalizedLength(/^(.+)$/, "A") === 7 && lowerGetterCalls === 1,
);
Object.defineProperty(String.prototype, "toLowerCase", {
	configurable: true,
	writable: true,
	value: originalLower,
});

const originalUpper = String.prototype.toUpperCase;
String.prototype.toUpperCase = function () {
	return "longer";
};
check(
	"method replacement forces the generic chain",
	normalizedLength(/^(.+)$/, "A") === 6,
);
String.prototype.toUpperCase = originalUpper;

let passed = 0;
for (const [name, condition] of checks) {
	if (condition) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + checks.length);
