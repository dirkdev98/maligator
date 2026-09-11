import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { artifactDigest, artifactProducer } from "./artifact-store.ts";
import type { ResolvedBuildConfig } from "./build-config.ts";
import { compilerImplementationDigestForRoot } from "./compiler-cache-identity.ts";
import { stripCompactTypes } from "./compiler/frontend/compact-type-strip.ts";
import { ESTREE_STOP, traverseEstree } from "./compiler/frontend/estree-traversal.ts";
import { buildModuleGraph } from "./compiler/frontend/module-graph.ts";
import { compileEntrypoint } from "./compiler/pipeline/compile-program.ts";
import { emitProgramTranslationUnits } from "./compiler/target/emit-program-image.ts";

export function prepareWasmSource(
	root: string,
	entry: string,
	config: ResolvedBuildConfig,
	cache: string,
) {
	const compileOptions = {
		buildConfig: config,
		stripTypes: stripCompactTypes,
		entryGoal: "module" as const,
		coreInstrumentation: "off" as const,
	};
	const entryPath = path.resolve(root, entry);
	const graph = buildModuleGraph(entryPath, compileOptions);
	let pathSensitive = false;
	for (const module of graph.modules.values()) {
		if (module.goal === "cjs") pathSensitive = true;
		traverseEstree(module.parsed.ast, (node) => {
			if (node.type === "MetaProperty" && node.meta.name === "import") {
				pathSensitive = true;
				return ESTREE_STOP;
			}
		});
	}
	const modulePath = (file: string): string =>
		path.isAbsolute(file) && !pathSensitive ? path.relative(root, file) : file;
	const sourceIdentity = artifactDigest(
		JSON.stringify({
			entry: modulePath(graph.entry),
			modules: [...graph.modules].map(([file, module]) => ({
				path: modulePath(file),
				source: artifactDigest(module.source),
				goal: module.goal,
				dependencies: module.dependencies.map((dependency) => ({
					...dependency,
					resolvedPath:
						dependency.resolvedPath === null ? null : modulePath(dependency.resolvedPath),
				})),
			})),
			evaluationOrder: graph.evaluationOrder.map(modulePath),
		}),
	);
	const parser = createRequire(path.join(root, "package.json")).resolve("meriyah");
	const compilerHash = artifactDigest(
		JSON.stringify({
			implementation: compilerImplementationDigestForRoot(path.join(root, "src"), cache),
			parser: artifactDigest(readFileSync(parser)),
		}),
	);
	return {
		sourceIdentity,
		compilerHash,
		producer: artifactProducer(
			"wasm-source",
			2,
			artifactDigest(readFileSync(path.join(root, "src/wasm-source.ts"))),
		),
		compile(log: (message: string) => void) {
			const image = compileEntrypoint(entryPath, {
				...compileOptions,
				runPhase(phase, execute) {
					log(`Compiler: ${phase}`);
					return execute();
				},
			});
			// The reactor ignores the dev runner's entry path; observable module paths remain keyed.
			const portable = {
				...image,
				runtime: { ...image.runtime, entrypointPath: modulePath(entryPath) },
			};
			return emitProgramTranslationUnits(portable, { debugInfo: false });
		},
	};
}
