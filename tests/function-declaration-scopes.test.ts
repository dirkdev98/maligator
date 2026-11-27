import { expect, it } from "vitest";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";

function bindingScopes(source: string, names: ReadonlyArray<string>) {
	const path = "/function-declaration-scopes.js";
	const { files } = analyzeSourceAndRunSemanticAnalysis(
		source,
		path,
		parseScript(source, { strict: false }),
	);
	return Object.fromEntries(
		files[0]!.scopes
			.flatMap((scope) => scope.bindings)
			.filter((binding) => names.includes(binding.name))
			.map((binding) => [binding.name, binding.scopedTo]),
	);
}

it("keeps a hoisted declaration local until another activation reads its binding", () => {
	expect(
		bindingScopes(
			`function owner() {
				const local = double(2);
				function double(value) { return value * 2; }
				function shared() { return local; }
				function streamed() { return local; }
				function deferred() { return local; }
				const expression = function self() { return self; };
				return [local, () => shared, function* () { yield streamed; },
					async () => { await 0; return deferred; }, expression];
			}`,
			["double", "shared", "streamed", "deferred", "self"],
		),
	).toEqual({
		double: "local",
		shared: "captured",
		streamed: "captured",
		deferred: "captured",
		self: "local",
	});
});

it("keeps declaration bindings visible through direct eval and with", () => {
	expect(
		bindingScopes(
			`function fromEval(source) {
				function reflected() { return 1; }
				return eval(source);
			}
			function fromWith(object, intercepted) {
				function intercepted() { return 2; }
				with (object) { return intercepted(); }
			}`,
			["reflected", "intercepted"],
		),
	).toEqual({ reflected: "captured", intercepted: "captured" });
});
