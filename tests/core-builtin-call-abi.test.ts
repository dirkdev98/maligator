import { expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import type { CoreProgram } from "../src/compiler/core/core-store.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";

it("keeps clock reads distinct and forwards only consumed Date arguments", () => {
	let optimized: CoreProgram | undefined;
	compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`function dates(value, extra) {
				const first = Date.now(extra());
				const second = Date.now(extra());
				const parsed = Date.parse(value, extra());
				const utc = Date.UTC(2001, 1, 3, 4, 5, 6, 7, extra());
				return first + second + parsed + utc;
			}`,
			"core-exact-date-builtins.js",
		),
		{
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
			afterCoreOptimization(program) {
				optimized = program;
			},
		},
	);

	const calls = coreOperations(coreFunctionNamed(optimized!, "dates")!).filter(
		({ opcode }) => opcode === "callKnown",
	);
	expect(calls.map(({ attributes }) => attributes.operation)).toEqual([
		"Date.now",
		"Date.now",
		"Date.parse",
		"Date.UTC",
	]);
	expect(calls.map(({ inputs }) => inputs.length)).toEqual([1, 1, 2, 8]);
});
