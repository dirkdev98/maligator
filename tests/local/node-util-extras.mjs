import util, {
	aborted,
	callbackify,
	convertProcessSignalToExitCode,
	debug,
	debuglog,
	diff,
	getCallSites,
	getSystemErrorMap,
	getSystemErrorMessage,
	getSystemErrorName,
	isDeepStrictEqual,
	stripVTControlCharacters,
	transferableAbortController,
	transferableAbortSignal,
	types,
} from "node:util";

console.log(
	isDeepStrictEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }),
	isDeepStrictEqual([1], ["1"]),
);
console.log(
	debug === debuglog,
	util.TextEncoder === TextEncoder,
	util.TextDecoder === TextDecoder,
);
console.log(
	getSystemErrorName(-2),
	getSystemErrorMessage(-2),
	getSystemErrorMap().get(-13),
);
try {
	getSystemErrorName(2);
} catch (error) {
	console.log(error.code);
}
console.log(
	JSON.stringify(
		stripVTControlCharacters(
			"\u001b[31mred\u001b[39m \u001b]8;;http://x\u0007link\u001b]8;;\u0007 plain",
		),
	),
);
console.log(
	convertProcessSignalToExitCode("SIGINT"),
	convertProcessSignalToExitCode("SIGTERM"),
);
try {
	convertProcessSignalToExitCode("SIGNOPE");
} catch (error) {
	console.log(error.code);
}
console.log(
	JSON.stringify(diff("abc", "abd")),
	JSON.stringify(diff(["a", "b", "c"], ["a", "c", "d"])),
);
console.log(Array.isArray(getCallSites()), types.isFloat16Array(new Float32Array(1)));
const controller = transferableAbortController();
console.log(
	controller instanceof AbortController,
	transferableAbortSignal(controller.signal) === controller.signal,
);
const waiting = aborted(controller.signal, {});
waiting.then(() => console.log("aborted resolved"));
controller.abort();
const callbackified = callbackify(async (value) => value * 2);
console.log(callbackified.name, callbackified.length);
callbackified(21, (error, value) => console.log("callbackify", error, value));
callbackify(async () => {
	throw null;
})((error) => console.log("falsy rejection", error.code, error.reason));
console.log(
	JSON.stringify(util.parseEnv("A=1\n# comment\nexport B = 'two' \nC=\"x y\" # tail\n")),
);
console.log(
	JSON.stringify(util.parseEnv('D="line\\nnext"\nE="multi\nline" ignored\nF=`tick`\n')),
);
