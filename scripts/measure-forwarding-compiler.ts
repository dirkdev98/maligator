import { writeFileSync } from "node:fs";
import { resolveBuildConfig } from "../src/build-config.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-program.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
const config = resolveBuildConfig({ engine: { primordials: "mutable" } });
const samples = [];
for (let i = 0; i < 9; i++) {
	const start = performance.now();
	const semantic = loadEntrypointAndRunSemanticAnalysis("bench/rest-forwarding.mjs", {
		buildConfig: config,
	});
	const semanticMs = performance.now() - start;
	const phases: Record<string, number> = {};
	const image = compileSemanticProgramToProgramImage(semantic, {
		facts: compilerProgramFactsFromConfig(config),
		runPhase: (phase, run) => {
			const time = performance.now();
			const result = run();
			phases[phase] = performance.now() - time;
			return result;
		},
	});
	samples.push({
		totalMs: performance.now() - start,
		semanticMs,
		phases,
		functions: image.runtime.functions.length,
		restArrays: image.runtime.functions
			.flatMap((f) => f.instructions)
			.filter((i) => i.opcode === "CREATE_REST_ARGUMENTS").length,
		forwards: image.runtime.functions
			.flatMap((f) => f.instructions)
			.filter((i) => i.opcode === "CALL_REST_ARGUMENTS").length,
	});
}
writeFileSync(process.argv[2]!, JSON.stringify({ samples }, null, 2));
