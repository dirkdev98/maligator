// Runtime-gate fixture for `engine.eval: false`. Built with evalEnabled:false, so
// the baked compiler is not embedded and every dynamic-code path must throw an
// EvalError at the point it would compile — including the aliased indirect eval
// the compile-time static check deliberately cannot see. `eval` and `Function`
// must still EXIST as bindings (the gate throws when called, it doesn't delete
// them), so feature-detection and the prototype chain stay intact.

const results = [];
function throwsEvalError(name, fn) {
	try {
		fn();
		results.push([name, false]);
	} catch (e) {
		results.push([name, e instanceof EvalError]);
	}
}

throwsEvalError("direct eval", () => eval("1 + 1"));
throwsEvalError("new Function", () => new Function("return 1"));
throwsEvalError("Function(...) call", () => Function("return 1"));

// Aliased indirect eval: the static check can't follow this; only the runtime
// gate catches it.
const aliased = eval;
throwsEvalError("aliased indirect eval", () => aliased("1 + 1"));

// The bindings themselves survive (not deleted by the gate).
results.push(["eval binding intact", typeof eval === "function"]);
results.push(["Function binding intact", typeof Function === "function"]);
results.push(["instanceof Function works", function () {} instanceof Function]);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
