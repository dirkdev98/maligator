import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ResolvedBuildConfig } from "../src/build-config.ts";
import type * as Compiler from "../src/compiler/pipeline/compile-program.ts";
import type { CompilerProgramFacts } from "../src/compiler/shared/compiler-facts.ts";

/** Both revisions must compile the frozen module graph under the product's facts. */
export async function compileNativeMicroProgram(
	root: string,
	fixture: string,
	config: ResolvedBuildConfig,
) {
	const { compileEntrypoint } = (await import(
		pathToFileURL(path.join(root, "src/compiler/pipeline/compile-program.ts")).href
	)) as typeof Compiler;
	let facts: CompilerProgramFacts | undefined;
	const started = performance.now();
	const programImage = compileEntrypoint(path.resolve(fixture), {
		buildConfig: config,
		entryGoal: "module",
		onProgramFacts: (compiledFacts) => {
			facts = compiledFacts;
		},
	});
	if (facts === undefined)
		throw new Error("Product frontend did not report program facts");
	return {
		programImage,
		evidence: {
			policy: "product-module-graph-with-closure-certificate",
			cache: "disabled",
			durationMs: performance.now() - started,
			closure: facts.closure,
		},
	};
}
