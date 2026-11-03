/* oxlint-disable no-console -- The fixture reports observable variadic ABI behavior. */
import { invoke, invokeEmpty, dispatch_calls } from "maligator:ffi/variadic_dispatch";
function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
check(
	invoke("small", -7, 60000, 0.1) === -7 + 60000 + Math.fround(0.1),
	"C promotes narrow integers and floats",
);
check(
	invoke("mixed", "hello", 0.5, -1099511627776n) === 5.5 - 1099511627776,
	"variadic calls preserve mixed integer and floating registers",
);
check(
	invoke("array", [2, 3, 5]) === 10,
	"dispatch uses visible arity after hidden counts and constants",
);
const out = invoke("output");
check(out.result === 3.5 && out.arg3 === 91, "each signature retains its output shape");
check(
	invoke("callback", (value) => value + 1) === 9,
	"dispatched callbacks use the VM's native frame",
);
const marker = new Error("callback marker");
let caught: unknown;
try {
	invoke("callback", () => {
		throw marker;
	});
} catch (error) {
	caught = error;
}
check(caught === marker, "callback exceptions survive dispatched C calls");
const requests: Array<Parameters<typeof invoke>> = [
	["small", -1, 2, 0.5],
	["array", [5, 6]],
];
const results = requests.map((request) => invoke(...request));
check(
	results[0] === 1.5 && results[1] === 11,
	"runtime tuples keep selectors correlated with their arguments",
);
check(
	invokeEmpty("noExtra", 0) === 19 && invokeEmpty("oneExtra", 1, -3) === -3,
	"typed variants may pass no variadic arguments",
);
const dynamic = invoke as (...args: Array<unknown>) => unknown;
let touched = 0;
const poison = {
	get length() {
		touched++;
		throw new Error("payload read");
	},
};
const before = dispatch_calls();
for (const args of [
	[],
	["unknown", poison],
	[null, poison],
	[
		{
			toString() {
				touched++;
				return "array";
			},
		},
		poison,
	],
	["array"],
	["array", poison, 99],
	["output", poison],
	["small\0", poison],
]) {
	let rejected = false;
	try {
		dynamic(...args);
	} catch (error) {
		rejected = error instanceof TypeError;
	}
	check(rejected, "invalid selector or arity throws TypeError");
}
check(
	touched === 0 && dispatch_calls() === before,
	"invalid dispatch never converts payloads or enters C",
);
let range = false;
try {
	invoke("small", -129, 1, 0);
} catch (error) {
	range = error instanceof RangeError;
}
check(
	range && dispatch_calls() === before,
	"selected signatures keep their scalar range checks",
);
console.log("variadic dispatch passed");
