import { assertEvalPolicy, assertRegexpPolicy } from "../../build-config.ts";
import { certifyProgramClosure } from "../frontend/certify-closure.ts";
import type { BuildModuleGraphOptions } from "../frontend/module-graph.ts";
import { buildModuleGraph } from "../frontend/module-graph.ts";
import { collectPrimordialMutationDiagnostics } from "../frontend/primordial-diagnostics.ts";
import {
	collectDisallowedEvalUsage,
	collectDisallowedRegexpUsage,
} from "../frontend/semantic-analysis.ts";
import { runSemanticAnalysisForGraph } from "../frontend/semantic-program.ts";
import type { CompilerDiagnostic } from "../shared/compiler-diagnostics.ts";
import type { CompilerProgramFacts } from "../shared/compiler-facts.ts";
import {
	compilerProgramFactsFromConfig,
	withProgramClosure,
} from "../shared/compiler-facts.ts";
import type { VmDefinition } from "../target/lower-vm.ts";
import { serializeVmDefinition } from "../target/serialize-vm.ts";
import { compileSemanticProgramToVmDefinition } from "./compile-core.ts";
import type { CompileCorePhase } from "./compile-core.ts";

export type CompileEntrypointPhase = "graph" | "semantic" | CompileCorePhase;
export type CompileEntrypointToBufferPhase = CompileEntrypointPhase | "serialize";

export interface CompileEntrypointOptions extends BuildModuleGraphOptions {
	runPhase?: <T>(phase: CompileEntrypointPhase, run: () => T) => T;
	onDiagnostic?: (diagnostic: CompilerDiagnostic) => void;
	/** Observe the facts this compilation ran under, including its closure certificate. */
	onProgramFacts?: (facts: CompilerProgramFacts) => void;
}

export interface CompileEntrypointToBufferOptions extends Omit<
	CompileEntrypointOptions,
	"runPhase"
> {
	runPhase?: <T>(phase: CompileEntrypointToBufferPhase, run: () => T) => T;
}

/** Compile an on-disk entrypoint and its module graph to the portable wire format. */
export function compileEntrypoint(
	entrypointPath: string,
	options: CompileEntrypointOptions = {},
): VmDefinition {
	const runPhase =
		options.runPhase ?? (<T>(_phase: CompileEntrypointPhase, run: () => T): T => run());
	const graph = runPhase("graph", () => buildModuleGraph(entrypointPath, options));
	const buildConfig = options.buildConfig;
	const facts =
		buildConfig === undefined
			? undefined
			: withProgramClosure(
					compilerProgramFactsFromConfig(buildConfig),
					// This entry point produces the whole-program image a native link
					// consumes. Relocatable islands and the development-wire-API host are
					// reached only through compileBuildFrontend, which certifies its own.
					certifyProgramClosure(graph, buildConfig, {
						relocatableArtifact: false,
						hostWireSplicing: false,
					}),
				);
	if (facts !== undefined) options.onProgramFacts?.(facts);
	const semantic = runPhase("semantic", () => {
		const result = runSemanticAnalysisForGraph(graph);
		if (options.buildConfig !== undefined) {
			assertEvalPolicy(options.buildConfig, collectDisallowedEvalUsage(result));
			assertRegexpPolicy(options.buildConfig, collectDisallowedRegexpUsage(result));
			for (const diagnostic of collectPrimordialMutationDiagnostics(
				result,
				facts!.world,
				{ nodeEnabled: options.buildConfig.surface.node },
			)) {
				options.onDiagnostic?.(diagnostic);
			}
		}
		return result;
	});
	return compileSemanticProgramToVmDefinition(semantic, {
		facts,
		runPhase,
	});
}

/** Compile an on-disk entrypoint and its module graph to the portable wire format. */
export function compileEntrypointToBuffer(
	entrypointPath: string,
	options: CompileEntrypointToBufferOptions = {},
): Uint8Array {
	const definition = compileEntrypoint(entrypointPath, options);
	const runPhase =
		options.runPhase ??
		(<T>(_phase: CompileEntrypointToBufferPhase, run: () => T): T => run());
	return runPhase("serialize", () => serializeVmDefinition(definition));
}
