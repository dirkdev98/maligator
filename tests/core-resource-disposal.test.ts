import { expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import type { CoreProgram } from "../src/compiler/core/core-store.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";

const CAPABILITY_INTRINSICS = new Set([
	"__newDisposeCapability",
	"__addDisposableResource",
	"__disposeResources",
]);

function capabilityIntrinsics(program: CoreProgram, name: string): Array<string> {
	return coreOperations(coreFunctionNamed(program, name)!).flatMap(
		({ opcode, attributes }) =>
			opcode === "loadIntrinsic" &&
			typeof attributes.intrinsic === "string" &&
			CAPABILITY_INTRINSICS.has(attributes.intrinsic)
				? [attributes.intrinsic]
				: [],
	);
}

it("allocates a dispose capability only for scopes that can await disposal", () => {
	let optimized: CoreProgram | undefined;
	compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`function scoped(resource) {
				using held = resource;
				for (using item of [resource]) item;
				return held;
			}
			async function awaited(resource) {
				await using held = resource;
				return held;
			}`,
			"core-resource-disposal.js",
		),
		{
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
			afterCoreOptimization(program) {
				optimized = program;
			},
		},
	);

	expect(capabilityIntrinsics(optimized!, "scoped")).toEqual([]);
	expect(capabilityIntrinsics(optimized!, "awaited")).toContain("__newDisposeCapability");
});
