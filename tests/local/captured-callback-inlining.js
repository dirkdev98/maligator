let passed = 0;

function check(condition, label) {
	if (!condition) throw new Error(`captured-callback-inlining: ${label}`);
	passed++;
}

let reportingEnabled = false;
let reports = 0;

function invokeWithReporting(callback) {
	const result = callback();
	if (reportingEnabled) reports = (reports + result) | 0;
	return result;
}

function run(seed, iterations) {
	let checksum = 0;
	for (let index = 0; index < iterations; index++) {
		const value = (seed + index) & 255;
		checksum = (checksum + invokeWithReporting(() => value + 1)) | 0;
	}
	return checksum;
}

check(run(2, 4) === 18, "guarded hot path preserves captured values");
reportingEnabled = true;
check(run(5, 3) === 21, "reporting path preserves callback results");
check(reports === 21, "reporting path preserves callback side effects");

const originalInvoke = invokeWithReporting;
invokeWithReporting = (callback) => callback() * 2;
check(run(1, 3) === 18, "changed wrapper takes the guarded fallback");
check(reports === 21, "fallback does not execute the original wrapper");
invokeWithReporting = originalInvoke;

const fallbackCallbacks = [];
invokeWithReporting = (callback) => {
	fallbackCallbacks.push(callback);
	return callback();
};
check(run(4, 3) === 18, "fallback retains callbacks without sharing environments");
check(
	fallbackCallbacks.map((callback) => callback()).join(",") === "5,6,7",
	"retained fallback callbacks preserve per-iteration values",
);

const deferredCallbacks = [];
invokeWithReporting = (callback) => {
	deferredCallbacks.push(callback);
	return 0;
};
check(run(8, 2) === 0, "fallback may retain callbacks without invoking them");
check(
	deferredCallbacks.map((callback) => callback()).join(",") === "9,10",
	"deferred fallback callbacks remain valid after the loop",
);
invokeWithReporting = originalInvoke;

function delayed(value) {
	const callback = () => value;
	value += 2;
	return callback();
}

check(delayed(11) === 13, "inlining reads the captured cell at invocation");

let retained;
function retain(callback) {
	retained = callback;
	return callback();
}
function runRetained(value) {
	const first = retain(() => value + 1);
	return first + retained();
}

check(runRetained(17) === 36, "escaping callbacks retain their identity and environment");

const callbacks = [];
for (let index = 0; index < 3; index++) callbacks.push(() => index);
check(
	callbacks[0]() === 0 && callbacks[1]() === 1 && callbacks[2]() === 2,
	"per-iteration environments remain distinct",
);

console.log(`captured-callback-inlining:${passed}`);
