import v8, { setFlagsFromString } from "node:v8";
import vm, { runInNewContext } from "node:vm";

const results: Array<[string, boolean]> = [];
function check(name: string, ok: boolean): void {
	results.push([name, !!ok]);
}

check("node:v8 default identity", v8.setFlagsFromString === setFlagsFromString);
check("node:vm default identity", vm.runInNewContext === runInNewContext);
check("new context evaluates code", runInNewContext("40 + 2") === 42);
check(
	"each call gets a fresh global",
	runInNewContext("globalThis.marker = 1; marker") === 1 &&
		runInNewContext("typeof marker") === "undefined",
);

setFlagsFromString("--expose_gc");
const isolatedGc = runInNewContext("gc");
check("V8 expose-gc flag reaches new contexts", typeof isolatedGc === "function");
isolatedGc();

let flagsTypeError = false;
try {
	setFlagsFromString(1 as unknown as string);
} catch (error) {
	flagsTypeError = error instanceof TypeError;
}
check("V8 flags require a string", flagsTypeError);

let codeTypeError = false;
try {
	runInNewContext(1 as unknown as string);
} catch (error) {
	codeTypeError = error instanceof TypeError;
}
check("VM code requires a string", codeTypeError);

for (const [name, ok] of results) {
	if (!ok) console.log(`FAIL: ${name}`);
}
console.log(`RESULT ${results.filter(([, ok]) => ok).length}/${results.length}`);
