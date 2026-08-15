// A Number has more than one NaN-boxing encoding, and -0 produced by the int32
// multiply fast path takes the static one. Every observable that dispatches over
// value encodings must recognize it, or -0 silently reads as an object.

let checks = 0;
let passed = 0;

function check(label, actual, expected) {
	checks++;
	if (Object.is(actual, expected)) {
		passed++;
	} else {
		console.log(`FAIL: ${label} ${String(actual)} !== ${String(expected)}`);
	}
}

// Derived at run time so no constant folding reaches it: reduce leaves an int32
// -1, and the int32 multiply below is the path that produces the static -0.
const negativeZero = [-1].reduce((sum, value) => sum + value, 0) * 0;

check("isNegativeZero", Object.is(negativeZero, -0), true);
check("reciprocal", 1 / negativeZero, -Infinity);
check("typeof", typeof negativeZero, "number");
check("string", String(negativeZero), "0");
check("template", `${negativeZero}`, "0");
check("join", [negativeZero].join(","), "0");
check("json", JSON.stringify(negativeZero), "0");
check("toString", negativeZero.toString(), "0");
check("propertyKey", Object.keys({ [negativeZero]: 1 })[0], "0");
check("truthy", negativeZero ? "truthy" : "falsy", "falsy");
check("negation", !negativeZero, true);
check("strictEqual", negativeZero === 0, true);
check("concatenation", "" + negativeZero, "0");

const positiveInfinity = [1].reduce((sum, value) => sum + value, 0) / 0;
check("infinityString", String(positiveInfinity), "Infinity");
check("infinityTruthy", positiveInfinity ? "truthy" : "falsy", "truthy");
check("negativeInfinityTruthy", -positiveInfinity ? "truthy" : "falsy", "truthy");

console.log(`negative-zero-encodings PASS ${passed}/${checks}`);
