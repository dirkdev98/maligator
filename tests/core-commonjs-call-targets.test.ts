import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import {
	CORE_CALLEE_TARGETS_NON_CALLABLE,
	coreCalleeTargetsFunction,
	joinCoreCalleeTargets,
} from "../src/compiler/core/core-callee-targets.ts";
import type { CoreCalleeTargets } from "../src/compiler/core/core-callee-targets.ts";
import { coreCommonJsRequiredModule } from "../src/compiler/core/core-ir-call-targets.ts";
import type { CoreFunctionId } from "../src/compiler/core/core-ir.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_CALL_GRAPH_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import { constructSemanticProgramCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { analyzeEntrypoint } from "../src/compiler/pipeline/compile-program-common.ts";

const FIXTURE = resolve("tests/local/commonjs-root-exports/main.cjs");

/** The targets of each `require()` result in the fixture's entry, by required file. */
function requiredTargets() {
	const analysis = analyzeEntrypoint(
		FIXTURE,
		{ buildConfig: resolveBuildConfig({}), stripTypes: (text) => text },
		(_phase, run) => run(),
	);
	const { program, context } = constructSemanticProgramCore(
		analysis.semantic,
		{ facts: analysis.facts },
		(_phase, run) => run(),
	);
	const graph = new CoreAnalysisManager(
		program,
		context,
		new CoreOptimizationReportBuilder(program),
	).get(CORE_CALL_GRAPH_ANALYSIS, { scope: "program" });
	const file = (functionId: number) =>
		basename(program.function(functionId as CoreFunctionId).metadata.sourcePath);
	const targets = new Map<string, CoreCalleeTargets>();
	for (const functionId of program.functionIds()) {
		if (file(functionId) !== "main.cjs") continue;
		const fn = program.function(functionId);
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const module = coreCommonJsRequiredModule(fn, instruction);
			if (module === undefined) continue;
			const result = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
			targets.set(
				file(context.data.cjsModuleFunctionIndices[module]!),
				graph.targets(functionId, result),
			);
		}
	}
	const declared = (path: string, name: string) =>
		[...program.functionIds()].find(
			(functionId) =>
				file(functionId) === path &&
				String.fromCharCode(
					...(program.stringConstants[
						program.function(functionId).metadata.nameStringIndex
					] ?? []),
				) === name,
		)!;
	return { targets, declared };
}

const exactly = (target: number) => coreCalleeTargetsFunction(target);
const orInitialExports = (...functions: Array<number>) =>
	functions.reduce(
		(targets, target) =>
			joinCoreCalleeTargets(targets, coreCalleeTargetsFunction(target)),
		CORE_CALLEE_TARGETS_NON_CALLABLE,
	);

describe("CommonJS require() call targets", () => {
	const { targets, declared } = requiredTargets();

	it.each([
		["plain.cjs", "isThenable"],
		["with-default.cjs", "isThenable"],
		["exported-first-head.cjs", "double"],
		["flaky.cjs", "count"],
	])(
		"resolves %s to the function its only root write exports before any user code runs",
		(path, name) => {
			expect(targets.get(path)).toEqual(exactly(declared(path, name)));
		},
	);

	it.each([
		["host-before-export.cjs", ["leaf"]],
		["cycle-head.cjs", ["head"]],
		["chosen.cjs", ["first", "second"]],
		["maybe.cjs", ["unused"]],
	])(
		"keeps the initial exports object possible for %s, which can run user code or finish before its root write",
		(path, names) => {
			expect(targets.get(path)).toEqual(
				orInitialExports(...names.map((name) => declared(path, name))),
			);
		},
	);

	it("leaves require() open when a function can replace module.exports later", () => {
		const replaced = targets.get("replaced.cjs");
		expect(replaced?.functions).toEqual([]);
		expect(replaced?.anyScript).toBe(true);
	});
});
