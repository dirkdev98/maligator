import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { worldFactsFromConfig } from "../src/compiler-facts.ts";
import { collectPrimordialMutationDiagnostics } from "../src/primordial-diagnostics.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

function diagnostics(source: string, policy: "locked" | "mutable" = "locked") {
	const semantic = analyzeSourceAndRunSemanticAnalysis(source, "diagnostic.js");
	return collectPrimordialMutationDiagnostics(
		semantic,
		worldFactsFromConfig(resolveBuildConfig({ engine: { primordials: policy } })),
	);
}

describe("locked primordial diagnostics", () => {
	it("warns for sound direct and reflective mutation targets", () => {
		const found = diagnostics(`
Math.extra = 1;
String.prototype.split = replacement;
delete globalThis.Object;
Object.defineProperty(Array.prototype, "x", { value: 1 });
Reflect.set(globalThis, "Math", replacement);
Reflect.setPrototypeOf(JSON, null);
Array.prototype.push(1);
var Math = replacement;
function Object() {}
`);
		expect(found).toHaveLength(9);
		expect(found.every(({ code }) => code === "primordial.mutation")).toBe(true);
		expect(found.map(({ message }) => message)).toEqual(
			expect.arrayContaining([
				expect.stringContaining("Math.extra"),
				expect.stringContaining("String.prototype.split"),
				expect.stringContaining("globalThis.Object"),
				expect.stringContaining("Array.prototype"),
			]),
		);
	});

	it("does not guess through dynamic keys or shadowed bindings", () => {
		const found = diagnostics(`
function local(Math, Object) {
	Math.extra = 1;
	Object.defineProperty({}, "x", { value: 1 });
}
const key = "split";
String.prototype[key] = replacement;
Object.freeze(Math);
const user = {};
user.extra = 1;
`);
		expect(found).toEqual([]);
	});

	it("is disabled completely in mutable builds", () => {
		expect(diagnostics("Math.extra = 1", "mutable")).toEqual([]);
	});
});
