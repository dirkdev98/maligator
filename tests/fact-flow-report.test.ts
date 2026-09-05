import { expect, test } from "vitest";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";

function compile(source: string, profile = true) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"/project/src/fact-flow-fixture.js",
		parseScript(source, { strict: true }),
	);
	return compileSemanticProgramToProgramImage(semantic, { profile });
}

test("ordinary compilation does not collect fact flow", () => {
	const definition = compile("globalThis.result = globalThis.callback(1);", false);
	expect(definition.diagnostics.factFlow).toBeUndefined();
});

test("fact flow does not publish residual targets without a selected consumer", () => {
	const definition = compile(`
		function recursive(value) {
			if (value <= 0) return 1;
			return value * recursive(value - 1);
		}
		globalThis.result = recursive(3) + globalThis.callback(1);
	`);
	const report = definition.diagnostics.factFlow!;
	expect(report.schema).toBe(1);
	expect(
		report.entries
			.flatMap(({ events }) => events)
			.some(
				(event) =>
					event.phase === "core-to-execution" &&
					event.disposition === "dropped" &&
					event.reason === "unsupported-consumer",
			),
	).toBe(false);
	expect(
		report.entries.every(({ events }) =>
			events.some(
				(event) =>
					event.phase === "core-optimization" &&
					event.artifact === "callee-target-set" &&
					event.disposition === "produced",
			),
		),
	).toBe(true);
	expect(report.summary.produced).toBe(report.entries.length);
});

test("fact flow records finite guarded target sets in both outputs", () => {
	const definition = compile(`
		function caller(useSecond, value) {
			function first(input) {
				if (input > 0) return input + 1;
				return input - 1;
			}
			function second(input) {
				if (input > 0) return input + 2;
				return input - 2;
			}
			const handler = useSecond ? second : first;
			let total = 0;
			for (let index = 0; index < 3; index++) total += handler(value + index);
			return total;
		}
		globalThis.result = caller(globalThis.useSecond, globalThis.value);
	`);
	const finite = definition.diagnostics.factFlow!.entries.find(
		({ functions, events }) =>
			functions.length === 2 &&
			events.some(
				(event) =>
					event.phase === "runtime-output" &&
					event.artifact === "guardedFunctionIndices" &&
					event.disposition === "consumed",
			),
	);

	expect(finite?.events).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				phase: "core-to-execution",
				disposition: "consumed",
				artifact: "guardedFunctionIndices",
			}),
			expect.objectContaining({
				phase: "native-output",
				disposition: "consumed",
				artifact: "guardedFunctionIndices",
			}),
		]),
	);
	expect(definition.diagnostics.factFlow!.summary.consumed).toBeGreaterThanOrEqual(3);
});

test("a singleton candidate with a non-callable alternative remains guarded", () => {
	const definition = compile(`
		function target(value) { ${"value += 1;".repeat(300)} return value; }
		const handler = globalThis.chooseTarget ? target : null;
		globalThis.result = handler(globalThis.value);
	`);
	const singleton = definition.diagnostics.factFlow!.entries.find(
		({ functions, events }) =>
			functions.length === 1 &&
			events.some(
				(event) =>
					event.phase === "native-output" && event.artifact === "guardedFunctionIndices",
			),
	);
	expect(singleton?.events).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				phase: "core-to-execution",
				artifact: "guardedFunctionIndices",
			}),
			expect.objectContaining({
				phase: "runtime-output",
				artifact: "guardedFunctionIndices",
			}),
		]),
	);
});
