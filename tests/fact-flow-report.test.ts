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

test("fact flow names the boundary where unsupported targets are dropped", () => {
	const definition = compile(`
		function recursive(value) {
			if (value <= 0) return 1;
			return value * recursive(value - 1);
		}
		globalThis.result = recursive(3) + globalThis.callback(1);
	`);
	const report = definition.diagnostics.factFlow!;
	const unsupported = report.entries.find(({ events }) =>
		events.some(
			(event) =>
				event.phase === "core-to-execution" &&
				event.disposition === "dropped" &&
				event.reason === "unsupported-consumer",
		),
	);

	expect(report.schema).toBe(1);
	expect(unsupported?.events).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				phase: "core-optimization",
				disposition: "produced",
				artifact: "callee-target-set",
			}),
			expect.objectContaining({
				phase: "core-to-execution",
				disposition: "dropped",
				reason: "unsupported-consumer",
			}),
		]),
	);
	expect(report.summary.produced).toBe(report.entries.length);
	expect(report.summary.dropped).toBeGreaterThanOrEqual(1);
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
