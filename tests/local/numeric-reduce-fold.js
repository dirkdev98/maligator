// Every case runs the proven region and an ordinary indexed loop over the same
// inputs. The two must agree bit for bit whether or not the region was admitted,
// so a guard that should have rejected shows up as a mismatch rather than as a
// merely different-looking number.

let checks = 0;
let passed = 0;
const report = [];

function equivalent(label, actual, expected) {
	checks++;
	if (Object.is(actual, expected)) {
		passed++;
	} else {
		console.log(`FAIL: ${label} ${String(actual)} !== ${String(expected)}`);
	}
	report.push(`${label}=${String(actual)}`);
}

function transcendental(values, initial) {
	return values.reduce(
		(sum, value) => sum + Math.sqrt(value) * Math.sin(value) + Math.abs(value - 0.5),
		initial,
	);
}

function transcendentalReference(values, initial) {
	let sum = initial;
	for (let index = 0; index < values.length; index++) {
		if (!(index in values)) continue;
		const value = values[index];
		sum = sum + Math.sqrt(value) * Math.sin(value) + Math.abs(value - 0.5);
	}
	return sum;
}

function arithmetic(values, initial) {
	return values.reduce((sum, value) => ((sum + value) * 3 - 1) % 1000, initial);
}

function arithmeticReference(values, initial) {
	let sum = initial;
	for (let index = 0; index < values.length; index++) {
		if (!(index in values)) continue;
		sum = ((sum + values[index]) * 3 - 1) % 1000;
	}
	return sum;
}

function concatenation(values, initial) {
	return values.reduce((sum, value) => sum + value, initial);
}

function concatenationReference(values, initial) {
	let sum = initial;
	for (let index = 0; index < values.length; index++) {
		if (!(index in values)) continue;
		sum = sum + values[index];
	}
	return sum;
}

const dense = [];
for (let index = 0; index < 64; index++)
	dense.push(((index * 2654435761) % 10007) / 10007);

// Repeated so a compiled build runs the admitted region many times over storage
// that never changes.
let repeated = 0;
for (let round = 0; round < 25; round++) repeated += transcendental(dense, 0);
let repeatedReference = 0;
for (let round = 0; round < 25; round++)
	repeatedReference += transcendentalReference(dense, 0);
equivalent("repeated", repeated, repeatedReference);

equivalent("empty", transcendental([], 7.5), 7.5);
equivalent("single", transcendental([0.25], 1), transcendentalReference([0.25], 1));
equivalent("arithmetic", arithmetic(dense, 11), arithmeticReference(dense, 11));

// Number edge cases must survive the unboxed fold exactly as the ordinary loop
// leaves them: -0 is a distinct Number and NaN poisons every later operation.
equivalent("negativeZero", concatenation([-1], 0) * 0, -0);
equivalent(
	"negativeZeroProduct",
	[0].reduce((sum, value) => sum * value, -1),
	-0,
);
equivalent("notANumber", concatenation([NaN, 1], 0), NaN);
equivalent("infinity", concatenation([Infinity, 1], 0), Infinity);
equivalent("infinityCancellation", concatenation([Infinity, -Infinity], 0), NaN);
equivalent("remainderSign", arithmetic([-1], -1), arithmeticReference([-1], -1));

// A non-Number element abandons the fold with nothing written, so the ordinary
// region still produces the observable string concatenation.
equivalent("stringElement", concatenation([1, 2, "3"], 0), "33");
equivalent("objectElement", concatenation([1, {}], 0), "1[object Object]");
equivalent("undefinedElement", concatenation([1, undefined], 0), NaN);

// Receivers the region is not proven over: a hole, an own index override, an own
// named property, and a subclass all keep the unchanged guarded loop.
const sparse = [1, , 3];
equivalent("sparse", concatenation(sparse, 0), concatenationReference(sparse, 0));
equivalent(
	"sparseTranscendental",
	transcendental(sparse, 0),
	transcendentalReference(sparse, 0),
);

const named = [1, 2, 3];
named.tag = "kept";
equivalent("ownNamedProperty", concatenation(named, 0), 6);

const shadowed = [1, 2, 3];
let shadowCalls = 0;
shadowed.reduce = function shadowedReduce() {
	shadowCalls++;
	return -1;
};
equivalent("ownReduce", concatenation(shadowed, 0), -1);
equivalent("ownReduceCalls", shadowCalls, 1);

class Sub extends Array {}
const subclass = Sub.from([1, 2, 3]);
equivalent("subclass", concatenation(subclass, 0), 6);

// A patched Math method must be observed by the region exactly as by the loop.
const originalSqrt = Math.sqrt;
let patchedSqrtCalls = 0;
Math.sqrt = function patchedSqrt(value) {
	patchedSqrtCalls++;
	return originalSqrt(value) + 1;
};
equivalent("patchedMath", transcendental(dense, 0), transcendentalReference(dense, 0));
equivalent("patchedMathCalls", patchedSqrtCalls, dense.length * 2);
Math.sqrt = originalSqrt;
equivalent("restoredMath", transcendental(dense, 0), transcendentalReference(dense, 0));

// Same for the method itself: an intercepted Array.prototype.reduce must run.
const originalReduce = Array.prototype.reduce;
let patchedReduceCalls = 0;
Array.prototype.reduce = function patchedReduce(callback, initial) {
	patchedReduceCalls++;
	return originalReduce.call(this, callback, initial);
};
equivalent("patchedReduce", concatenation([1, 2, 3], 0), 6);
equivalent("patchedReduceCalls", patchedReduceCalls, 1);
Array.prototype.reduce = originalReduce;

console.log(report.join(" "));
console.log(`numeric-reduce-fold PASS ${passed}/${checks}`);
