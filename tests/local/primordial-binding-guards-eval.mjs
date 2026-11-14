// Rebinds global primordials from code compiled at run time: a global `var` or
// function declaration in indirect eval, a sloppy assignment, a `with` statement, and
// a later script's lexical declaration, which shadows the global object's property.
// Indirect eval's own `let` stays inside the eval. One case runs per process.
import vm from "node:vm";

const environment = globalThis.process?.env ?? {};
const mode = environment.PRIMORDIAL_BINDING_CASE ?? "eval-let";
const results = [];
function record(label, value) {
	results[results.length] = `${label}=${value}`;
}

const original = { Math: globalThis.Math, parseInt: globalThis.parseInt };
globalThis.__originalMath = original.Math;
globalThis.__fakeMath = Object.assign(Object.create(original.Math), {
	max: (left, right) => `max(${left},${right})`,
	trunc: (value) => `trunc(${value})`,
});

function sample(value, text) {
	return [
		Math.max(value, 1),
		Math.trunc(value / 3),
		parseInt(text, 16),
		parseFloat(text),
		Number.parseFloat(text),
	].join(",");
}

function warm(label) {
	let last = "";
	let length = 0;
	for (let round = 0; round < 48; round++) {
		last = sample(((round * 37) % 101) - 50.5, String(round * 3 + 1));
		length += last.length;
	}
	record(label, `${length}:${last}`);
}

const cases = {
	"eval-let"() {
		record("inside", (0, eval)("let Math = globalThis.__fakeMath; Math.max(1, 2);"));
		warm("outside");
	},
	"eval-var"() {
		(0, eval)("var Math = globalThis.__fakeMath;");
		warm("replaced");
		(0, eval)("Math = globalThis.__originalMath;");
		warm("restored");
	},
	"eval-function"() {
		(0, eval)(
			"function parseInt(text, radix) { return 'eval(' + text + ',' + radix + ')'; }",
		);
		warm("replaced");
		globalThis.parseInt = original.parseInt;
		warm("restored");
	},
	"sloppy-assign"() {
		new Function("fake", "parseFloat = fake;")((text) => `float(${text})`);
		warm("replaced");
		new Function("value", "parseFloat = value;")(Number.parseFloat);
		warm("restored");
	},
	"with-statement"() {
		new Function("fake", "with (globalThis) { Math = fake; }")(globalThis.__fakeMath);
		warm("replaced");
		new Function("value", "with (globalThis) { Math = value; }")(original.Math);
		warm("restored");
	},
	"script-let"() {
		vm.runInThisContext("let Math = globalThis.__fakeMath;");
		warm("shadowed");
		record("property", globalThis.Math === original.Math);
		vm.runInThisContext("Math = globalThis.__originalMath;");
		warm("restored");
	},
};

warm("first");
cases[mode]();
console.log(mode, results.join("\n"));
